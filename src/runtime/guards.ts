// Guards stop the operator from going in circles or burning its budget on repeated errors.
import type { StepView } from './state.js';

const signature = (s: StepView) => `${s.tool}:${JSON.stringify(s.args)}`;

export function checkGuards(steps: StepView[]): { warning?: string; stop?: string } {
  // Repeating an action is only a loop if nothing changed in between: count from the last step that sent a change.
  const lastProgress = steps.map((s) => !!s.wrote).lastIndexOf(true);
  const recent = steps.slice(lastProgress + 1).slice(-8);
  const counts = new Map<string, number>();
  for (const s of recent) counts.set(signature(s), (counts.get(signature(s)) ?? 0) + 1);
  const [topSig, top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  let trailingErrors = 0;
  for (const s of [...steps].reverse()) { if (s.result && !s.result.ok) trailingErrors++; else break; }

  if (top >= 5) return { stop: `The same action was repeated ${top} times (${topSig.slice(0, 120)}). Stopping to avoid a loop.` };
  if (trailingErrors >= 7) return { stop: `${trailingErrors} actions in a row failed. Stopping so a person can look.` };
  if (top >= 3) return { warning: `You have repeated the same action ${top} times recently (${topSig.slice(0, 120)}) without getting closer. Step back: re-read the page, re-check the plan, and try a different approach.` };
  if (trailingErrors >= 4) return { warning: `Your last ${trailingErrors} actions failed. Stop and rethink: re-read the current page and the procedure before acting again.` };
  return {};
}
