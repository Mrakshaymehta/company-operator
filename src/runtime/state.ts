// Rebuilds the current state of a run from its diary. Used for prompts, resume, the console and reports.
import type { Brief, FinishArgs, Note, PlanItem, Role, RunEvent, RunStatus, Verdict, ErrorKind } from './types.js';

export interface StepView {
  role: Role; step: number; reason: string; tool: string; args: unknown; brainMs: number; notes?: Note[];
  /** True if this step sent a change to a company system (progress). */
  wrote?: boolean;
  result?: { ok: boolean; summary: string; errorKind?: ErrorKind; screenshot?: string; artifacts?: string[]; observation: string; ms: number };
}
export interface PendingQuestion { id: string; question: string; options: string[]; why?: string; saveAs?: { entity: string; fact: string }; origin: 'clarify' | 'executor' }
export interface PendingApproval { id: string; step: number; ruleId: string; description: string; approver?: string; fields: Record<string, string>; fingerprint: string; summary: string; screenshot?: string }
export interface RunState {
  id: string; goal: string; options: Record<string, unknown>; status: RunStatus; startedAt: string; updatedAt: string;
  brief?: Brief; clarifications: { question: string; answer: string; by: string }[];
  plan: PlanItem[]; notes: Note[]; steps: StepView[]; verifierSteps: StepView[];
  questions: (PendingQuestion & { answer?: string; by?: string; remember?: boolean })[];
  approvals: (PendingApproval & { decision?: 'approved' | 'rejected'; by?: string; note?: string })[];
  pendingQuestion?: PendingQuestion; pendingApproval?: PendingApproval;
  denials: { step: number; ruleId?: string; reason: string }[];
  writes: { at: string; system: string; method: string; path: string; fields: Record<string, string>; approvalId?: string }[];
  guards: { kind: string; message: string }[];
  memory: { action: string; factId: string; entity: string; text: string }[];
  finishes: { step: number; args: FinishArgs }[]; verdicts: Verdict[];
  finished?: { status: RunStatus; summary: string; at: string };
  resumes: number; brainCalls: number; brainMs: number; costUsd: number; errors: { where: string; message: string }[];
}

export function reduce(events: RunEvent[]): RunState {
  const first = events.find((e) => e.type === 'run.created');
  const s: RunState = {
    id: first?.runId ?? '', goal: first && first.type === 'run.created' ? first.goal : '', options: first && first.type === 'run.created' ? first.options : {},
    status: 'created', startedAt: first?.at ?? '', updatedAt: first?.at ?? '', clarifications: [], plan: [], notes: [], steps: [], verifierSteps: [],
    questions: [], approvals: [], denials: [], writes: [], guards: [], memory: [], finishes: [], verdicts: [], resumes: 0, brainCalls: 0, brainMs: 0, costUsd: 0, errors: [],
  };
  for (const e of events) {
    s.updatedAt = e.at;
    switch (e.type) {
      case 'status': s.status = e.status; break;
      case 'brief':
        s.brief = e.brief; s.brainCalls++; s.brainMs += e.brainMs ?? 0; s.costUsd += e.costUsd ?? 0;
        if (!s.plan.length || s.steps.length === 0) s.plan = e.brief.plan.map((step) => ({ step, status: 'todo' as const }));
        break;
      case 'question': {
        const q = { id: e.id, question: e.question, options: e.options, why: e.why, saveAs: e.saveAs, origin: e.origin };
        s.questions.push(q); s.pendingQuestion = q; break;
      }
      case 'answer': {
        const q = s.questions.find((x) => x.id === e.id);
        if (q) { q.answer = e.answer; q.by = e.by; q.remember = e.remember; if (q.origin === 'clarify') s.clarifications.push({ question: q.question, answer: e.answer, by: e.by }); }
        if (s.pendingQuestion?.id === e.id) s.pendingQuestion = undefined;
        break;
      }
      case 'decision': {
        const v: StepView = { role: e.role, step: e.step, reason: e.reason, tool: e.tool, args: e.args, brainMs: e.brainMs, notes: e.notes };
        (e.role === 'executor' ? s.steps : s.verifierSteps).push(v);
        s.brainCalls++; s.brainMs += e.brainMs; s.costUsd += e.costUsd ?? 0;
        if (e.role === 'executor' && e.plan?.length) s.plan = e.plan;
        if (e.role === 'executor' && e.notes?.length) for (const n of e.notes) { s.notes = s.notes.filter((x) => x.key !== n.key); s.notes.push(n); }
        break;
      }
      case 'result': {
        const list = e.role === 'executor' ? s.steps : s.verifierSteps;
        const v = [...list].reverse().find((x) => x.step === e.step);
        if (v) v.result = { ok: e.ok, summary: e.summary, errorKind: e.errorKind, screenshot: e.screenshot, artifacts: e.artifacts, observation: e.observation, ms: e.ms };
        break;
      }
      case 'approval.requested': {
        const a = { id: e.id, step: e.step, ruleId: e.ruleId, description: e.description, approver: e.approver, fields: e.fields, fingerprint: e.fingerprint, summary: e.summary, screenshot: e.screenshot };
        s.approvals.push(a); s.pendingApproval = a; break;
      }
      case 'approval.resolved': {
        const a = s.approvals.find((x) => x.id === e.id);
        if (a) { a.decision = e.decision; a.by = e.by; a.note = e.note; }
        if (s.pendingApproval?.id === e.id) s.pendingApproval = undefined;
        break;
      }
      case 'policy.denied': s.denials.push({ step: e.step, ruleId: e.ruleId, reason: e.reason }); break;
      case 'write': {
        s.writes.push({ at: e.at, system: e.system, method: e.method, path: e.path, fields: e.fields, approvalId: e.approvalId });
        const last = s.steps.at(-1);
        if (last) last.wrote = true;
        break;
      }
      case 'guard': s.guards.push({ kind: e.kind, message: e.message }); break;
      case 'memory': s.memory.push({ action: e.action, factId: e.factId, entity: e.entity, text: e.text }); break;
      case 'finish': s.finishes.push({ step: e.step, args: e.args }); break;
      case 'verify.result': s.verdicts.push(e.verdict); break;
      case 'run.finished': s.finished = { status: e.status, summary: e.summary, at: e.at }; s.status = e.status; break;
      case 'resumed': s.resumes++; break;
      case 'error': s.errors.push({ where: e.where, message: e.message }); break;
    }
  }
  return s;
}
