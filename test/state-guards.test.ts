import { describe, expect, it } from 'vitest';
import { reduce, type StepView } from '../src/runtime/state.js';
import { checkGuards } from '../src/runtime/guards.js';
import type { RunEvent } from '../src/runtime/types.js';

let seq = 0;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, at: new Date(Date.UTC(2026, 9, 3, 12, 0, seq)).toISOString(), runId: 'r_t', ...e }) as RunEvent;

describe('rebuilding state from the diary', () => {
  it('tracks plan, notes, approvals and the final status', () => {
    const s = reduce([
      ev({ type: 'run.created', goal: 'Enter an invoice', options: {} }),
      ev({ type: 'brief', brief: { intent: 'x', success_criteria: ['a'], entities: [], procedures: [], plan: ['find', 'enter'], question: '', options: [] } }),
      ev({ type: 'decision', role: 'executor', step: 1, reason: 'r', tool: 'browser_open', args: { url: 'u' }, brainMs: 10, notes: [{ key: 'total', value: '100', source: 'pdf' }], plan: [{ step: 'find', status: 'done' }, { step: 'enter', status: 'doing' }] }),
      ev({ type: 'result', role: 'executor', step: 1, tool: 'browser_open', ok: false, errorKind: 'approval_required', summary: 'held', observation: 'o', ms: 5 }),
      ev({ type: 'approval.requested', id: 'ap', step: 1, ruleId: 'bills-over-50k', description: 'd', fields: {}, fingerprint: 'f', summary: 's' }),
      ev({ type: 'approval.resolved', id: 'ap', decision: 'approved', by: 'Nisha', ruleId: 'bills-over-50k', fingerprint: 'f' }),
      ev({ type: 'run.finished', status: 'completed', summary: 'done' }),
    ]);
    expect(s.plan.map((p) => p.status)).toEqual(['done', 'doing']);
    expect(s.notes).toEqual([{ key: 'total', value: '100', source: 'pdf' }]);
    expect(s.pendingApproval).toBeUndefined();
    expect(s.approvals[0].decision).toBe('approved');
    expect(s.steps[0].result?.errorKind).toBe('approval_required');
    expect(s.status).toBe('completed');
  });
  it('knows a question is still pending until it is answered', () => {
    const s = reduce([ev({ type: 'run.created', goal: 'g', options: {} }), ev({ type: 'question', id: 'q1', question: 'Which?', options: ['A'], origin: 'clarify' })]);
    expect(s.pendingQuestion?.id).toBe('q1');
  });
});

const step = (n: number, tool: string, ok = true): StepView => ({ role: 'executor', step: n, reason: '', tool, args: { ref: 1 }, brainMs: 0, result: { ok, summary: '', observation: '', ms: 0 } });
describe('guards', () => {
  it('warns on repetition and stops a loop', () => {
    expect(checkGuards([step(1, 'a'), step(2, 'a'), step(3, 'a')]).warning).toBeTruthy();
    expect(checkGuards([1, 2, 3, 4, 5].map((n) => step(n, 'a'))).stop).toBeTruthy();
  });
  it('does not count repeats across real progress (entering several bills)', () => {
    const steps = [1, 2, 3, 4, 5, 6].map((n) => ({ ...step(n, 'open_new_bill'), wrote: n % 2 === 0 }));
    expect(checkGuards(steps)).toEqual({});
  });
  it('stops after a long run of failures', () => {
    expect(checkGuards([1, 2, 3, 4, 5, 6, 7].map((n) => ({ ...step(n, `t${n}`, false) }))).stop).toBeTruthy();
    expect(checkGuards([step(1, 'a'), step(2, 'b')])).toEqual({});
  });
});
