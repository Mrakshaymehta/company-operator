// The step loop shared by the doer and the checker: brief the model, get one decision, validate it,
// run the tool, record everything in the diary, and repeat until a terminal tool or a limit.
import { z } from 'zod';
import type { Brain } from '../brain/types.js';
import type { ToolResult, ToolSet } from '../tools/types.js';
import type { RunStore } from './events.js';
import { reduce, type RunState, type StepView } from './state.js';
import { checkGuards } from './guards.js';
import { decisionSchema } from './prompts.js';
import type { Role } from './types.js';

export interface LoopSpec {
  role: Role; brain: Brain; tools: ToolSet; system: string; store: RunStore;
  maxSteps: number; deadline: number; terminal: string[];
  /** Only steps from this index onward count for this loop (the checker starts fresh each round). */
  fromIndex?: number;
  initialObservation: string;
  prompt(state: RunState, steps: StepView[], last: { observation: string; step: number } | null, extra: string[], step: number, previous: { observation: string; step: number } | null): string;
  onResult?(res: ToolResult, step: number, reason: string): Promise<string | null>;
}
export type LoopOutcome = { kind: 'terminal'; tool: string; args: any; step: number } | { kind: 'stopped'; reason: string };

const Decision = z.object({
  reason: z.string().default(''),
  plan: z.array(z.object({ step: z.string(), status: z.enum(['todo', 'doing', 'done', 'skipped']) })).optional(),
  notes: z.array(z.object({ key: z.string(), value: z.string(), source: z.string() })).optional(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

export async function runLoop(spec: LoopSpec): Promise<LoopOutcome> {
  const { role, store, tools } = spec;
  const mine = (s: RunState) => (role === 'executor' ? s.steps : s.verifierSteps).slice(spec.fromIndex ?? 0);
  const schema = decisionSchema(Object.keys(tools), role === 'executor', true);
  let state = reduce(store.read());
  const all = role === 'executor' ? state.steps : state.verifierSteps;
  let step = all.at(-1)?.step ?? 0;
  let last: { observation: string; step: number } | null = { observation: spec.initialObservation, step };
  let previous: { observation: string; step: number } | null = null;
  let lastWarning = '';

  for (;;) {
    state = reduce(store.read());
    const steps = mine(state);
    if (steps.length >= spec.maxSteps) return { kind: 'stopped', reason: `reached the limit of ${spec.maxSteps} steps` };
    if (Date.now() > spec.deadline) return { kind: 'stopped', reason: 'ran out of time' };
    const extra: string[] = [];
    if (role === 'executor') {
      const g = checkGuards(steps);
      if (g.stop) { store.append({ type: 'guard', kind: 'stop', message: g.stop }); return { kind: 'stopped', reason: g.stop }; }
      if (g.warning) {
        if (g.warning !== lastWarning) store.append({ type: 'guard', kind: 'warning', message: g.warning });
        lastWarning = g.warning;
        extra.push(`WARNING FROM THE RUNTIME: ${g.warning}`);
      }
    }
    step += 1;
    const prompt = spec.prompt(state, steps, last, extra, step, previous);
    let raw: unknown; let brainMs = 0; let costUsd: number | undefined;
    try {
      const r = await spec.brain.decide<unknown>({ purpose: `${role} step ${step}`, system: spec.system, prompt, schema });
      raw = r.output; brainMs = r.ms; costUsd = r.costUsd;
    } catch (e) {
      store.append({ type: 'error', where: `${role} brain`, message: (e as Error).message });
      return { kind: 'stopped', reason: `the AI model could not be reached: ${(e as Error).message}` };
    }
    const parsed = Decision.safeParse(raw);
    const d = parsed.success ? parsed.data : { reason: 'Unreadable decision', tool: '(invalid)', args: {} as Record<string, unknown> };
    store.append({ type: 'decision', role, step, reason: d.reason, plan: 'plan' in d ? d.plan : undefined, notes: 'notes' in d ? d.notes : undefined, tool: d.tool, args: d.args, brainMs, costUsd });

    const tool = tools[d.tool];
    if (!tool) {
      const obs = `"${d.tool}" is not an available tool. Available tools: ${Object.keys(tools).join(', ')}.`;
      store.append({ type: 'result', role, step, tool: d.tool, ok: false, errorKind: 'invalid_args', summary: 'unknown tool', observation: obs, ms: 0 });
      previous = last; last = { observation: obs, step };
      continue;
    }
    const args = tool.schema.safeParse(d.args);
    if (!args.success) {
      const obs = `The arguments for ${d.tool} were not valid: ${args.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}. Fix them and try again.`;
      store.append({ type: 'result', role, step, tool: d.tool, ok: false, errorKind: 'invalid_args', summary: 'invalid arguments', observation: obs, ms: 0 });
      previous = last; last = { observation: obs, step };
      continue;
    }
    if (spec.terminal.includes(d.tool)) {
      store.append({ type: 'result', role, step, tool: d.tool, ok: true, summary: `called ${d.tool}`, observation: '', ms: 0 });
      return { kind: 'terminal', tool: d.tool, args: args.data, step };
    }
    const t0 = Date.now();
    let res: ToolResult;
    try { res = await tool.run(args.data, { step, role, store }); } catch (e) {
      res = { ok: false, errorKind: 'unknown', summary: `${d.tool} crashed: ${(e as Error).message}`, observation: `The tool failed with an unexpected error: ${(e as Error).message}` };
    }
    store.append({ type: 'result', role, step, tool: d.tool, ok: res.ok, summary: res.summary, errorKind: res.errorKind, screenshot: res.screenshot, artifacts: res.artifacts, observation: res.observation, ms: Date.now() - t0 });
    const injected = spec.onResult ? await spec.onResult(res, step, d.reason) : null;
    previous = last;
    last = { observation: injected ? `${injected}\n\n${res.observation}` : res.observation, step };
  }
}
