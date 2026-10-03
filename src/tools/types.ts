// The tool contract. Every capability the operator has (browser, files, memory, people) is a Tool with a typed input.
import type { z } from 'zod';
import type { ErrorKind, Role } from '../runtime/types.js';
import type { RunStore } from '../runtime/events.js';

export interface ToolContext { step: number; role: Role; store: RunStore }
export interface ToolResult {
  ok: boolean; summary: string; observation: string; errorKind?: ErrorKind;
  screenshot?: string; artifacts?: string[]; data?: Record<string, unknown>;
}
export interface Tool<A = any> {
  name: string; description: string; schema: z.ZodType<A>;
  /** read: only looks. write: may change company data (still policy-checked). human: involves a person. control: ends the loop. */
  risk: 'read' | 'write' | 'human' | 'control';
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}
export type ToolSet = Record<string, Tool>;
export const ok = (summary: string, observation = summary, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, summary, observation, ...extra });
export const fail = (errorKind: ErrorKind, summary: string, observation = summary, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: false, errorKind, summary, observation, ...extra });
