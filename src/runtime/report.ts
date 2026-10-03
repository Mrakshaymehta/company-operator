// Writes report.md for a run: the result, the checker's findings, approvals, questions, what was learned and every step.
import fs from 'node:fs';
import type { RunStore } from './events.js';
import { reduce } from './state.js';

const LABEL: Record<string, string> = { completed: 'Completed and checked', needs_human: 'Needs a person', failed: 'Failed', waiting_approval: 'Waiting for approval', waiting_input: 'Waiting for an answer' };
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function writeReport(store: RunStore): string {
  const s = reduce(store.read());
  const mins = (Date.parse(s.finished?.at ?? s.updatedAt) - Date.parse(s.startedAt)) / 60000;
  const verdict = s.verdicts.at(-1);
  const lines: string[] = [
    `# Task report: ${LABEL[s.status] ?? s.status}`, '',
    `**Task:** ${s.goal}`, '',
    `**Result:** ${s.finished?.summary ?? '(not finished)'}`, '',
    `| Run | Started | Duration | Steps | Checker | AI calls |`, `|---|---|---|---|---|---|`,
    `| ${s.id} | ${s.startedAt} | ${mins.toFixed(1)} min | ${s.steps.length} | ${verdict ? `${verdict.overall} (${verdict.criteria.filter((c) => c.status === 'pass').length} of ${verdict.criteria.length})` : 'not run'} | ${s.brainCalls} |`, '',
  ];
  const flags = s.finishes.at(-1)?.args.flags ?? [];
  if (flags.length) lines.push('## Flags for a person', ...flags.map((f) => `- ${f}`), '');
  if (s.brief) lines.push('## What success looked like', ...s.brief.success_criteria.map((c) => `- ${c}`), '');
  if (verdict) {
    lines.push('## What the independent checker found', '| Criterion | Result | Evidence |', '|---|---|---|',
      ...verdict.criteria.map((c) => `| ${esc(c.criterion)} | ${c.status} | ${esc(c.evidence)} |`), '');
    if (verdict.notes) lines.push(`Checker notes: ${verdict.notes}`, '');
  }
  if (s.approvals.length || s.questions.length || s.denials.length) {
    lines.push('## People and policy');
    for (const a of s.approvals) lines.push(`- **Approval** (${a.ruleId}): ${a.description} → **${a.decision ?? 'pending'}**${a.by ? ` by ${a.by}` : ''}${a.note ? ` ("${a.note}")` : ''}`);
    for (const q of s.questions) lines.push(`- **Question:** ${q.question} → ${q.answer ?? '(no answer yet)'}${q.by ? ` (${q.by})` : ''}${q.remember && q.saveAs ? ', saved to memory' : ''}`);
    for (const d of s.denials) lines.push(`- **Blocked by policy** at step ${d.step}: ${d.reason}`);
    lines.push('');
  }
  if (s.writes.length) lines.push('## Changes the operator sent to the company systems', ...s.writes.map((w) => `- ${w.at} \`${w.method} ${w.system}${w.path}\` ${esc(JSON.stringify(w.fields)).slice(0, 240)}${w.approvalId ? ` (approved: ${w.approvalId})` : ''}`), '');
  if (s.notes.length) lines.push('## Facts collected during the task', ...s.notes.map((n) => `- **${n.key}:** ${n.value} (${n.source})`), '');
  if (s.memory.length) lines.push('## Company memory', ...s.memory.map((m) => `- ${m.action === 'saved' ? 'Saved (confirmed by a person)' : 'Proposed, waiting for confirmation'}: ${m.text} [${m.factId}]`), '');
  lines.push('## Steps', '| # | Reason | Action | Result | Screenshot |', '|---|---|---|---|---|',
    ...s.steps.map((st) => `| ${st.step} | ${esc(st.reason)} | \`${st.tool}\` ${esc(JSON.stringify(st.args)).slice(0, 160)} | ${st.result ? `${st.result.ok ? 'ok' : `**${st.result.errorKind}**`}: ${esc(st.result.summary)}` : ''} | ${st.result?.screenshot ? `[view](${st.result.screenshot})` : ''} |`), '');
  if (s.verifierSteps.length) lines.push('## Checker steps', ...s.verifierSteps.map((st) => `- ${st.step}. ${st.tool} ${JSON.stringify(st.args).slice(0, 120)}: ${st.result?.summary ?? ''}`), '');
  if (s.guards.length || s.errors.length) lines.push('## Runtime warnings', ...s.guards.map((g) => `- ${g.kind}: ${g.message}`), ...s.errors.map((e) => `- error in ${e.where}: ${e.message.split('\n')[0]}`), '');
  lines.push(`Full diary: \`events.jsonl\` (${store.read().length} events).`);
  const md = lines.join('\n');
  fs.writeFileSync(store.path('report.md'), md);
  return md;
}
