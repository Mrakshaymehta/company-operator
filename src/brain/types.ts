// The brain is a stateless decision function: given a briefing and an output schema, return one structured decision.
// All state lives in the runtime, so any model or provider can sit behind this interface.
export interface BrainRequest { purpose: string; system: string; prompt: string; schema: Record<string, unknown> }
export interface BrainResponse<T> { output: T; ms: number; costUsd?: number; model: string }
export interface Brain { name: string; decide<T>(req: BrainRequest): Promise<BrainResponse<T>> }
export class BrainError extends Error {}
