// The orchestrator. Turns a request into completed, checked work:
// understand (with clarification if needed) → execute step by step → independent check → fix once if needed → report.
import { z } from 'zod';
import type { Brain } from '../brain/types.js';
import { config, type CompanyConfig } from '../config.js';
import type { CompanyMemory } from '../memory/store.js';
import { BrowserSession, browserTools } from '../tools/browser.js';
import { fileTools } from '../tools/files.js';
import { memoryTools } from '../tools/memory.js';
import { ok, type Tool, type ToolResult, type ToolSet } from '../tools/types.js';
import { RunStore } from './events.js';
import type { HumanChannel } from './human.js';
import { runLoop } from './loop.js';
import { PolicyGate } from './policy.js';
import { briefSchema, executorSystem, understandSystem, verifierSystem } from './prompts.js';
import { executorPrompt, verifierPrompt, todayIST } from './context.js';
import { reduce, type PendingQuestion, type RunState } from './state.js';
import type { Brief, FinishArgs, RunStatus, Verdict } from './types.js';
import { writeReport } from './report.js';

export interface OperatorOptions { maxSteps: number; maxMinutes: number; verifierMaxSteps: number; fixRounds: number; headed: boolean; slowMo: number }
export interface OperatorDeps {
  brain: Brain; checkerBrain?: Brain; human: HumanChannel; memory: CompanyMemory; company: CompanyConfig;
  options?: Partial<OperatorOptions>; runsDir?: string;
}

const FinishSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string().min(1),
  evidence: z.array(z.object({ criterion: z.string(), proof: z.string() })).default([]),
  learned: z.array(z.object({ entity: z.string(), kind: z.string(), fact: z.string(), source: z.string() })).default([]),
  flags: z.array(z.string()).default([]),
});
const VerdictSchema = z.object({
  overall: z.enum(['pass', 'fail']),
  criteria: z.array(z.object({ criterion: z.string(), status: z.enum(['pass', 'fail', 'unknown']), evidence: z.string() })).min(1),
  notes: z.string().default(''),
});
const BriefZ = z.object({
  intent: z.string().default(''), success_criteria: z.array(z.string()).default([]), entities: z.array(z.string()).default([]),
  procedures: z.array(z.string()).default([]), plan: z.array(z.string()).default([]), question: z.string().default(''), options: z.array(z.string()).default([]),
});
const rid = () => Math.random().toString(36).slice(2, 7);

export class Operator {
  readonly opts: OperatorOptions;
  private lastStatus = new Map<string, RunStatus>();

  constructor(private d: OperatorDeps) {
    this.opts = { maxSteps: config.maxSteps, maxMinutes: config.maxMinutes, verifierMaxSteps: config.verifierMaxSteps, fixRounds: config.fixRounds,
      headed: config.headed, slowMo: config.slowMo, ...d.options };
  }
  private get checker() { return this.d.checkerBrain ?? this.d.brain; }
  private get loginPaths() { return Object.fromEntries(this.d.company.systems.map((s) => [s.id, s.login.path])); }

  /** Starts a run. onCreated fires with the run id as soon as the diary exists (the console uses it). */
  async start(goal: string, onCreated?: (runId: string) => void): Promise<RunState> {
    const store = RunStore.create(this.d.runsDir);
    store.append({ type: 'run.created', goal, options: { brain: this.d.brain.name, checker: this.checker.name, ...this.opts } });
    onCreated?.(store.runId);
    return this.drive(store, false);
  }

  /** Continues a run from its diary after a crash or restart. */
  async resume(runId: string): Promise<RunState> {
    const store = RunStore.open(runId, this.d.runsDir);
    const st = reduce(store.read());
    if (st.finished) return st;
    store.append({ type: 'resumed', note: 'The operator restarted and is continuing from the diary.' });
    return this.drive(store, true);
  }

  private status(store: RunStore, s: RunStatus, note?: string) {
    if (this.lastStatus.get(store.runId) === s) return;
    this.lastStatus.set(store.runId, s);
    store.append({ type: 'status', status: s, note });
  }

  private async drive(store: RunStore, resumed: boolean): Promise<RunState> {
    const { memory, company } = this.d;
    memory.refresh();
    const gate = new PolicyGate(company.policies, { readOnly: false, loginPaths: this.loginPaths });
    for (const a of reduce(store.read()).approvals) if (a.decision === 'approved') gate.addGrant({ ruleId: a.ruleId, fingerprint: a.fingerprint, approvalId: a.id });
    const browser = new BrowserSession({ role: 'executor', store, systems: company.systems, vault: company.vault, gate, headed: this.opts.headed, slowMo: this.opts.slowMo,
      onWrite: (w) => store.append({ type: 'write', ...w }) });
    try {
      await this.understandPhase(store);
      const state = reduce(store.read());
      const deadline = (resumed ? Date.now() : Date.parse(state.startedAt)) + this.opts.maxMinutes * 60000;
      const tools = this.executorTools(store, browser);
      const system = executorSystem(company.company, company.systems, tools);
      let observation = resumed
        ? 'The operator was restarted. Your browser is a fresh session, so you may need to sign in again. Continue from where you stopped, and check what is already done in the systems before repeating any save.'
        : 'Nothing has been done yet. Start with the first step of your to-do list.';
      if (resumed && state.pendingApproval) observation += ' A submission was waiting for approval when the operator stopped: fill in and submit the form again and the approval will be requested again.';

      for (let round = 0; ; round++) {
        this.status(store, 'executing');
        const out = await runLoop({
          role: 'executor', brain: this.d.brain, tools, system, store, maxSteps: this.opts.maxSteps, deadline, terminal: ['finish'], initialObservation: observation,
          prompt: (st, _steps, last, extra, step) => executorPrompt(st, memory, last, extra, step, { maxSteps: this.opts.maxSteps, deadline }),
          onResult: (res, step, reason) => this.onExecutorResult(store, gate, res, step, reason),
        });
        if (out.kind === 'stopped') return this.end(store, 'needs_human', `Stopped before finishing: ${out.reason}.`);
        const fin = out.args as FinishArgs;
        store.append({ type: 'finish', step: out.step, args: fin });
        if (fin.status === 'blocked') { this.recordLearned(store, fin); return this.end(store, 'needs_human', fin.summary); }
        if (fin.status === 'failed') return this.end(store, 'failed', fin.summary);

        this.status(store, 'verifying');
        const verdict = await this.verify(store, fin);
        store.append({ type: 'verify.result', round, verdict });
        if (verdict.overall === 'pass') { this.recordLearned(store, fin); return this.end(store, 'completed', fin.summary); }
        const failing = verdict.criteria.filter((c) => c.status !== 'pass');
        if (round >= this.opts.fixRounds) {
          return this.end(store, 'needs_human', `The checker could not confirm: ${failing.map((c) => `${c.criterion} (${c.status}: ${c.evidence})`).join('; ')}`);
        }
        observation = `THE INDEPENDENT CHECKER DID NOT CONFIRM YOUR WORK.\n${failing.map((c) => `- ${c.criterion}: ${c.status}. ${c.evidence}`).join('\n')}\nChecker notes: ${verdict.notes || 'none'}\nLook again, fix what is wrong without creating duplicates, then finish again.`;
        this.lastStatus.delete(store.runId);
      }
    } catch (e) {
      store.append({ type: 'error', where: 'operator', message: (e as Error).stack ?? String(e) });
      return this.end(store, 'failed', `Unexpected error: ${(e as Error).message}`);
    } finally {
      await browser.close();
    }
  }

  private end(store: RunStore, status: RunStatus, summary: string): RunState {
    store.append({ type: 'run.finished', status, summary });
    writeReport(store);
    return reduce(store.read());
  }

  // ---------- Understand ----------
  private async understandPhase(store: RunStore) {
    let state = reduce(store.read());
    if (state.pendingQuestion?.origin === 'clarify') await this.askClarification(store, state.pendingQuestion);
    state = reduce(store.read());
    if (!state.brief || (state.clarifications.length && state.brief.question && state.clarifications.some((c) => c.question === state.brief!.question))) await this.understand(store);
    for (let i = 0; i < 2; i++) {
      state = reduce(store.read());
      const q = state.brief?.question?.trim();
      if (!q || state.clarifications.some((c) => c.question === q)) return;
      const pq: PendingQuestion = { id: `q_${rid()}`, question: q, options: state.brief!.options, why: 'The request can be read in more than one way.', origin: 'clarify' };
      store.append({ type: 'question', ...pq });
      await this.askClarification(store, pq);
      await this.understand(store);
    }
  }
  private async askClarification(store: RunStore, q: PendingQuestion) {
    this.status(store, 'waiting_input');
    const a = await this.d.human.ask({ runId: store.runId, id: q.id, question: q.question, options: q.options, why: q.why, canRemember: false });
    store.append({ type: 'answer', id: q.id, answer: a.answer, by: a.by, remember: false });
  }
  private async understand(store: RunStore) {
    const { memory, company } = this.d;
    this.status(store, 'understanding');
    const st = reduce(store.read());
    const prompt = [
      `TODAY: ${todayIST()}`,
      `REQUEST: ${st.goal}`,
      st.clarifications.length ? `CLARIFICATIONS FROM THE PERSON\n${st.clarifications.map((c) => `- ${c.question} → ${c.answer}`).join('\n')}\nDo not ask again about anything answered here.` : '',
      `SYSTEMS\n${company.systems.map((s) => `- ${s.name} (${s.id}): ${s.purpose}`).join('\n')}`,
      `COMPANY MEMORY INDEX\n${memory.index()}`,
    ].filter(Boolean).join('\n\n');
    const r = await this.d.brain.decide<Brief>({ purpose: 'understand', system: understandSystem(company.company), prompt, schema: briefSchema });
    const b = BriefZ.parse(r.output);
    b.entities = [...new Set(b.entities.map((id) => memory.entity(id)?.id).filter((x): x is string => !!x))];
    b.procedures = [...new Set(b.procedures.map((id) => memory.procedure(id)?.id).filter((x): x is string => !!x))];
    store.append({ type: 'brief', brief: b, brainMs: r.ms, costUsd: r.costUsd });
  }

  // ---------- Execute ----------
  private executorTools(store: RunStore, browser: BrowserSession): ToolSet {
    const { memory, company } = this.d;
    const list: Tool[] = [
      ...browserTools(browser, { readOnly: false, systems: company.systems }),
      ...fileTools(store, { canWrite: true }),
      ...memoryTools(memory),
      this.askTool(store),
      { name: 'finish', risk: 'control', description: 'End the task (see FINISHING). Include evidence for each success criterion.', schema: FinishSchema, run: async () => ok('finished') },
    ];
    return Object.fromEntries(list.map((t) => [t.name, t]));
  }

  private askTool(store: RunStore): Tool {
    const { memory, human } = this.d;
    return {
      name: 'ask_human', risk: 'human',
      description: 'Ask a person one question when you cannot proceed safely without it. Give short answer options. If the answer is reusable company knowledge, set save_as so it is stored in company memory and never asked again.',
      schema: z.object({
        question: z.string().min(5),
        options: z.array(z.string()).max(6).default([]),
        why: z.string().optional(),
        save_as: z.object({
          entity: z.string().describe('Company memory entity id the answer is about'),
          kind: z.string().describe('Short machine name for the fact, for example expense_category'),
          fact: z.string().describe('The fact to store, with {answer} where the answer goes, for example "Expense category for bills: {answer}."'),
        }).optional(),
      }),
      run: async (a: { question: string; options: string[]; why?: string; save_as?: { entity: string; kind: string; fact: string } }, ctx): Promise<ToolResult> => {
        const id = `q_${ctx.step}_${rid()}`;
        store.append({ type: 'question', id, question: a.question, options: a.options, why: a.why, saveAs: a.save_as ? { entity: a.save_as.entity, fact: a.save_as.fact } : undefined, origin: 'executor' });
        this.status(store, 'waiting_input');
        const ans = await human.ask({ runId: store.runId, id, question: a.question, options: a.options, why: a.why, canRemember: !!a.save_as });
        store.append({ type: 'answer', id, answer: ans.answer, by: ans.by, remember: ans.remember });
        this.status(store, 'executing');
        let saved = '';
        if (a.save_as && ans.remember) {
          try {
            const text = a.save_as.fact.includes('{answer}') ? a.save_as.fact.replace('{answer}', ans.answer) : `${a.save_as.fact} ${ans.answer}`;
            const f = memory.add({ entity: a.save_as.entity, kind: a.save_as.kind, text, shelf: 'things', status: 'confirmed', runId: store.runId, createdBy: ans.by,
              source: { type: 'human', ref: `Answer to the operator's question "${a.question}"`, by: ans.by, date: todayIST() } });
            store.append({ type: 'memory', action: 'saved', factId: f.id, entity: f.entity, text: f.text });
            saved = ` Saved to company memory as fact ${f.id}, so nobody will be asked again.`;
          } catch (e) { saved = ` (Could not save to memory: ${(e as Error).message})`; }
        }
        return ok(`${ans.by} answered: ${ans.answer}`, `ANSWER from ${ans.by}: ${ans.answer}.${saved}`);
      },
    };
  }

  private labelFields(fields: Record<string, string>, show?: string[]) {
    const out: Record<string, string> = {};
    for (const k of show ?? Object.keys(fields)) {
      if (fields[k] === undefined) continue;
      const e = this.d.memory.data.entities.find((x) => Object.values(x.links).includes(fields[k]));
      out[k] = e ? `${fields[k]} (${e.name})` : fields[k];
    }
    return out;
  }

  private async onExecutorResult(store: RunStore, gate: PolicyGate, res: ToolResult, step: number, reason: string): Promise<string | null> {
    if (res.errorKind === 'policy_denied') {
      const den = res.data?.denied as { ruleId?: string; reason?: string; fields?: Record<string, string> } | undefined;
      store.append({ type: 'policy.denied', step, ruleId: den?.ruleId, reason: den?.reason ?? res.summary, fields: den?.fields ?? {} });
      return null;
    }
    if (res.errorKind !== 'approval_required') return null;
    const a = res.data!.approval as { ruleId: string; description: string; approver?: string; fingerprint: string; fields: Record<string, string>; show?: string[] };
    const fields = this.labelFields(a.fields, a.show);
    const id = `ap_${step}_${rid()}`;
    store.append({ type: 'approval.requested', id, step, ruleId: a.ruleId, description: a.description, approver: a.approver, fields, fingerprint: a.fingerprint, summary: reason, screenshot: res.screenshot });
    this.status(store, 'waiting_approval');
    const dec = await this.d.human.approve({ runId: store.runId, id, ruleId: a.ruleId, description: a.description, approver: a.approver, fields, summary: reason,
      screenshot: res.screenshot ? store.path(res.screenshot) : undefined });
    store.append({ type: 'approval.resolved', id, decision: dec.decision, by: dec.by, note: dec.note, ruleId: a.ruleId, fingerprint: a.fingerprint });
    this.status(store, 'executing');
    const note = dec.note ? ` Note: "${dec.note}".` : '';
    if (dec.decision === 'approved') {
      gate.addGrant({ ruleId: a.ruleId, fingerprint: a.fingerprint, approvalId: id });
      return `APPROVED by ${dec.by}.${note} The form is still filled in on the page. Submit the same form again now, without changing any value, and it will go through.`;
    }
    return `REJECTED by ${dec.by}.${note} Nothing was saved. Do not submit it again and do not look for another way. Finish with status "blocked" and explain.`;
  }

  private recordLearned(store: RunStore, fin: FinishArgs) {
    const { memory } = this.d;
    memory.refresh();
    for (const l of fin.learned ?? []) {
      const e = memory.entity(l.entity);
      if (!e) continue;
      const dup = memory.factsFor(e.id).some((f) => memory.isCurrent(f) && f.text.trim().toLowerCase() === l.fact.trim().toLowerCase());
      if (dup) continue;
      const f = memory.add({ entity: e.id, kind: l.kind, text: l.fact, shelf: 'things', status: 'pending', runId: store.runId, createdBy: 'operator',
        source: { type: 'run', ref: `Learned in task ${store.runId}: ${l.source}`, date: todayIST() } });
      store.append({ type: 'memory', action: 'proposed', factId: f.id, entity: f.entity, text: f.text });
    }
  }

  // ---------- Check ----------
  private async verify(store: RunStore, fin: FinishArgs): Promise<Verdict> {
    const { memory, company } = this.d;
    const gate = new PolicyGate([], { readOnly: true, loginPaths: this.loginPaths });
    const vb = new BrowserSession({ role: 'verifier', store, systems: company.systems, vault: company.vault, gate, headed: this.opts.headed, slowMo: this.opts.slowMo });
    const list: Tool[] = [
      ...browserTools(vb, { readOnly: true, systems: company.systems }),
      ...fileTools(store, { canWrite: false }),
      ...memoryTools(memory),
      { name: 'verdict', risk: 'control', description: 'Report your verdict on every success criterion.', schema: VerdictSchema, run: async () => ok('verdict') },
    ];
    const tools = Object.fromEntries(list.map((t) => [t.name, t]));
    const fromIndex = reduce(store.read()).verifierSteps.length;
    try {
      const out = await runLoop({
        role: 'verifier', brain: this.checker, tools, system: verifierSystem(company.company, company.systems, tools), store,
        maxSteps: this.opts.verifierMaxSteps, deadline: Date.now() + 10 * 60000, terminal: ['verdict'], fromIndex,
        initialObservation: 'Nothing checked yet. Sign in to the system you need first.',
        prompt: (st, steps, last, _extra, step, previous) => verifierPrompt(st, fin, steps, last, step, { maxSteps: this.opts.verifierMaxSteps }, previous),
      });
      if (out.kind === 'stopped') return { overall: 'fail', criteria: [{ criterion: 'The checker completes its review', status: 'unknown', evidence: out.reason }], notes: `The checker stopped: ${out.reason}` };
      const v = out.args as Verdict;
      return { ...v, overall: v.criteria.length > 0 && v.criteria.every((c) => c.status === 'pass') ? 'pass' : 'fail' };
    } finally {
      await vb.close();
    }
  }
}
