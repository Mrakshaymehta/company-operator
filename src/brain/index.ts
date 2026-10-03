// Chooses the brain. Claude Code works with a Claude subscription or with ANTHROPIC_API_KEY set.
// Another provider is one class implementing the Brain interface in ./types.ts.
import { config } from '../config.js';
import { ClaudeCodeBrain } from './claude-code.js';
import type { Brain } from './types.js';

export function makeBrain(model = config.model, kind = config.brain): Brain {
  if (kind === 'claude-code') return new ClaudeCodeBrain(model);
  throw new Error(`Unknown brain "${kind}". Supported: claude-code.`);
}
export type { Brain } from './types.js';
