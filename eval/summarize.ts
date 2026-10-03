// Builds docs/EVALS.md from every results file in eval/results/.  pnpm eval:report
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { SCENARIOS } from './scenarios.js';

const dir = path.join(ROOT, 'eval', 'results');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
type R = { id: string; pass: boolean; steps: number; checkerSteps: number; minutes: number; checks: { name: string; pass: boolean; detail?: string }[]; runs: string[] };
const all: (R & { model: string })[] = [];
const rounds: { file: string; at: string; model: string; n: number; p: number; ids: string }[] = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const r of j.results) all.push({ ...r, model: j.model });
  rounds.push({ file: f, at: j.at, model: j.model, n: j.results.length, p: j.results.filter((r: R) => r.pass).length, ids: [...new Set(j.results.map((r: R) => r.id.split('-')[0]))].join(', ') });
}
const ist = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' IST';

const rows = SCENARIOS.map((s) => {
  const rs = all.filter((r) => r.id === s.id);
  const n = rs.length; const p = rs.filter((r) => r.pass).length;
  const avg = (k: 'steps' | 'checkerSteps' | 'minutes') => (n ? rs.reduce((a, r) => a + r[k], 0) / n : 0);
  return { s, n, p, steps: avg('steps'), chk: avg('checkerSteps'), min: avg('minutes'), fails: rs.filter((r) => !r.pass) };
});
const total = rows.reduce((a, r) => a + r.n, 0); const passed = rows.reduce((a, r) => a + r.p, 0);
const lines = [
  '# Evaluation results', '',
  'Each task runs against a freshly reset Kaira Naturals. Company memory is reset too, except between the two halves of task 5. It is graded by code against the sandbox\'s **true state** from the admin API, plus the run\'s own records for approvals, questions and resumes. The agent\'s claims are never used for grading. A task passes only if every check passes, including "the independent checker passed it".', '',
  `**Overall: ${passed} of ${total} task runs passed** (${total ? Math.round((100 * passed) / total) : 0}%). Model: Claude ${[...new Set(all.map((r) => r.model[0].toUpperCase() + r.model.slice(1)))].join(', ')} through the Claude Code CLI, for both the operator and the checker.`, '',
  '| Task | Priority | Runs | Passed | Avg operator steps | Avg checker steps | Avg minutes |', '|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.s.id}: ${r.s.title} | ${r.s.priority} | ${r.n} | ${r.p} | ${r.steps.toFixed(1)} | ${r.chk.toFixed(1)} | ${r.min.toFixed(1)} |`), '',
  '## Rounds', '', '| Finished | Model | Tasks | Passed |', '|---|---|---|---|',
  ...rounds.map((r) => `| ${ist(r.at)} | ${r.model} | ${r.ids} | ${r.p} of ${r.n} |`), '',
  'Two small changes were made after the first full round (finished 3 Oct, 21:25 IST): the operator now includes its updated to-do list in every step, and the default step budget went from 40 to 60. Later rounds run on the final code.', '',
  '## What each task checks', '',
  ...SCENARIOS.map((s) => `- **${s.id}**: ${s.proves}.`), '',
];
const failures = rows.flatMap((r) => r.fails.map((f) => ({ id: r.s.id, f })));
if (failures.length) {
  lines.push('## Failed runs', '', 'Every failure is kept and listed here. The diaries are in `runs/<id>/` when run locally.', '');
  for (const { id, f } of failures) lines.push(`- **${id}** (runs ${f.runs.join(', ')}): ${f.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`);
  lines.push('');
}
lines.push('## Problems found during development', '',
  'The results above come from the final code. Earlier development runs, kept in `eval/results/dev/`, found these problems, all fixed before the official runs:', '',
  '1. **The checker looped** between the PDF and the bills page because it only saw the latest page. It now keeps notes and sees the previous page.',
  '2. **The checker could not confirm approvals,** because approvals are not stored in the company\'s systems. It now receives the runtime\'s own records (approvals, policy blocks, exact requests sent) as trusted evidence, separate from the operator\'s untrusted claims.',
  '3. **The operator guessed** that "the supplier invoice" meant the latest one. The rule is now that a request that does not identify its target means asking first.',
  '4. **The scam email was handled correctly but reported as "done".** Finishing now includes flags for a person, shown first in the console and the report.',
  '5. **The loop guard mistook entering several bills for going in circles.** Repeats now only count since the last change the operator sent.', '',
  '## Example runs', '', 'Three complete runs from the official results are in [`examples/`](../examples/): the diary (`events.jsonl`), the report, the downloaded PDFs and a screenshot after every action.', '');
lines.push('## How to reproduce', '', '```bash', 'pnpm sandbox            # terminal 1', 'pnpm eval               # terminal 2: all tasks once', 'pnpm eval 1 3 --repeat 3 --verbose', 'pnpm eval:report        # rebuild this file', '```', '',
  `Generated from ${files.length} result file(s) in \`eval/results/\`.`);
fs.writeFileSync(path.join(ROOT, 'docs', 'EVALS.md'), lines.join('\n'));
console.log(`docs/EVALS.md: ${passed}/${total} passed across ${files.length} file(s)`);
