// Shared types for the operator runtime. A run is an append-only list of events; state is derived from them.
export type RunStatus = 'created' | 'understanding' | 'waiting_input' | 'executing' | 'waiting_approval' | 'verifying' | 'completed' | 'needs_human' | 'failed';
export type Role = 'executor' | 'verifier';
export interface PlanItem { step: string; status: 'todo' | 'doing' | 'done' | 'skipped' }
export interface Note { key: string; value: string; source: string }
export interface Brief {
  intent: string; success_criteria: string[]; entities: string[]; procedures: string[]; plan: string[];
  question: string; options: string[];
}
export interface FinishArgs {
  status: 'done' | 'blocked' | 'failed'; summary: string;
  evidence: { criterion: string; proof: string }[];
  learned?: { entity: string; kind: string; fact: string; source: string }[];
  /** Things a person should look at, even when the task itself is done. */
  flags?: string[];
}
export interface Verdict { overall: 'pass' | 'fail'; criteria: { criterion: string; status: 'pass' | 'fail' | 'unknown'; evidence: string }[]; notes: string }
export type ErrorKind = 'invalid_args' | 'stale_ref' | 'not_found' | 'approval_required' | 'policy_denied' | 'not_allowed' | 'http_error' | 'timeout' | 'unknown';

type Base = { seq: number; at: string; runId: string };
export type RunEvent = Base & (
  | { type: 'run.created'; goal: string; options: Record<string, unknown> }
  | { type: 'status'; status: RunStatus; note?: string }
  | { type: 'brief'; brief: Brief; brainMs?: number; costUsd?: number }
  | { type: 'question'; id: string; question: string; options: string[]; why?: string; saveAs?: { entity: string; fact: string }; origin: 'clarify' | 'executor' }
  | { type: 'answer'; id: string; answer: string; by: string; remember: boolean }
  | { type: 'decision'; role: Role; step: number; reason: string; plan?: PlanItem[]; notes?: Note[]; tool: string; args: unknown; brainMs: number; costUsd?: number }
  | { type: 'result'; role: Role; step: number; tool: string; ok: boolean; summary: string; errorKind?: ErrorKind; screenshot?: string; artifacts?: string[]; observation: string; ms: number }
  | { type: 'approval.requested'; id: string; step: number; ruleId: string; description: string; approver?: string; fields: Record<string, string>; fingerprint: string; summary: string; screenshot?: string }
  | { type: 'approval.resolved'; id: string; decision: 'approved' | 'rejected'; by: string; note?: string; ruleId: string; fingerprint: string }
  | { type: 'policy.denied'; step: number; ruleId?: string; reason: string; fields: Record<string, string> }
  | { type: 'write'; system: string; method: string; path: string; fields: Record<string, string>; approvalId?: string }
  | { type: 'guard'; kind: string; message: string }
  | { type: 'memory'; action: 'proposed' | 'saved'; factId: string; entity: string; text: string }
  | { type: 'finish'; step: number; args: FinishArgs }
  | { type: 'verify.result'; round: number; verdict: Verdict }
  | { type: 'run.finished'; status: RunStatus; summary: string }
  | { type: 'resumed'; note: string }
  | { type: 'error'; where: string; message: string }
);
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<RunEvent, 'seq' | 'at' | 'runId'>;
export type EventOf<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;
