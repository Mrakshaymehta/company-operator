// Builds showcase/: a static, read-only copy of the console filled with real recorded runs, for static hosting (Vercel).
//   pnpm showcase
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, config, loadCompany } from '../src/config.js';
import { reduce, type RunState } from '../src/runtime/state.js';
import type { RunEvent } from '../src/runtime/types.js';
import { CompanyMemory } from '../src/memory/store.js';
import { SCENARIOS } from '../eval/scenarios.js';

const OUT = path.join(ROOT, 'showcase');
const EXTRA = [{ id: 'r_1003_215442_ktx', title: 'Background work: a scheduled check enters a newly arrived invoice', proves: 'Nobody started this task: a schedule checked the inbox and the operator entered the new Greenleaf invoice, computing the missing due date from 15-day terms' }];

const runDir = (id: string) => [path.join(config.runsDir, id), path.join(config.runsDir, '_archive', id), path.join(ROOT, 'examples', id)].find((d) => fs.existsSync(path.join(d, 'events.jsonl')));
const read = (d: string): RunEvent[] => fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 1. Pick one passing run per test task from the official results (both runs for the two-part learning task).
const resultsDir = path.join(ROOT, 'eval', 'results');
const results = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')).results as { id: string; pass: boolean; runs: string[] }[]);
const picks: { id: string; scenario: { id: string; title: string; proves: string }; graded: boolean; part?: string }[] = [];
for (const s of SCENARIOS) {
  const r = results.find((x) => x.id === s.id && x.pass && x.runs.every((id) => runDir(id)));
  if (!r) { console.warn(`no recorded passing run for ${s.id}`); continue; }
  r.runs.forEach((id, i) => picks.push({ id, scenario: { id: s.id, title: s.title + (r.runs.length > 1 ? ` (part ${i + 1} of ${r.runs.length})` : ''), proves: s.proves }, graded: true }));
}
for (const e of EXTRA) if (runDir(e.id)) picks.push({ id: e.id, scenario: { id: 'extra', title: e.title, proves: e.proves }, graded: true });

// 2. Fresh output folder with the console's page, marked as a recorded showcase.
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['data/runs', 'data/memory', 'files']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const pub = path.join(ROOT, 'src', 'console', 'public');
fs.copyFileSync(path.join(pub, 'styles.css'), path.join(OUT, 'styles.css'));
fs.copyFileSync(path.join(pub, 'app.js'), path.join(OUT, 'app.js'));
fs.writeFileSync(path.join(OUT, 'index.html'), fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
  .replace('<title>Operator Console</title>', '<title>Company Operator</title><meta name="description" content="Recorded runs of an AI employee prototype working inside a pretend company.">')
  .replace('<script src="/app.js"></script>', '<script>window.OPERATOR_REPLAY = true;</script>\n<script src="/app.js"></script>'));

// 3. Each run: its full state (with what the model saw at each step), plus screenshots, PDFs and report.
const company = loadCompany();
const summaries = [];
const savedFacts: { entity: string; text: string; by: string; date: string; runId: string }[] = [];
for (const p of picks) {
  const dir = runDir(p.id)!;
  const s: RunState = reduce(read(dir));
  const v = s.verdicts.at(-1);
  const summary = { id: s.id, goal: s.goal, status: s.status, steps: s.steps.length, startedAt: s.startedAt, updatedAt: s.updatedAt, summary: s.finished?.summary,
    checks: v ? { passed: v.criteria.filter((c) => c.status === 'pass').length, total: v.criteria.length } : null,
    active: false, elsewhere: false, interrupted: false, approvals: s.approvals.length, questions: s.questions.length, resumes: s.resumes, waiting: null,
    flags: s.finishes.at(-1)?.args.flags?.length ?? 0, brainCalls: s.brainCalls, brainMs: s.brainMs, costUsd: Math.round(s.costUsd * 100) / 100, endedAt: s.finished?.at,
    source: p.scenario.id === 'extra' ? 'schedule' : 'person', scenarioTitle: p.scenario.title, proves: p.scenario.proves, graded: p.graded };
  const learned = s.memory.map((m) => ({ id: m.factId, text: m.text, status: m.action === 'saved' ? 'confirmed' : 'pending', entity: m.entity, source: '' }));
  for (const q of s.questions) if (q.remember && q.saveAs && q.answer) savedFacts.push({ entity: q.saveAs.entity, text: q.saveAs.fact.replace('{answer}', q.answer), by: q.by ?? 'a person', date: s.startedAt.slice(0, 10), runId: s.id });
  fs.writeFileSync(path.join(OUT, 'data', 'runs', `${s.id}.json`), JSON.stringify({ state: s, summary, learned, live: { question: false, approval: false }, scenario: p.scenario }));
  for (const sub of ['screenshots', 'downloads']) if (fs.existsSync(path.join(dir, sub))) fs.cpSync(path.join(dir, sub), path.join(OUT, 'files', s.id, sub), { recursive: true });
  if (fs.existsSync(path.join(dir, 'report.md'))) fs.copyFileSync(path.join(dir, 'report.md'), path.join(OUT, 'files', s.id, 'report.md'));
  summaries.push(summary);
}
fs.writeFileSync(path.join(OUT, 'data', 'runs.json'), JSON.stringify(summaries));
fs.writeFileSync(path.join(OUT, 'data', 'info.json'), JSON.stringify({ company: company.company, person: 'Nisha Kapoor', model: 'sonnet', checker: 'sonnet', systems: company.systems.map((x) => ({ id: x.id, name: x.name, url: '#' })) }));

// 4. Company memory: the seed, plus the answer the learning task saved, so the "ask once, remember" fact is visible.
const tmp = path.join(os.tmpdir(), `showcase-memory-${process.pid}.json`);
CompanyMemory.reset({ file: tmp });
const mem = CompanyMemory.load({ file: tmp });
for (const f of savedFacts) {
  try { mem.add({ entity: f.entity, kind: 'expense_category', text: f.text, shelf: 'things', status: 'confirmed', createdBy: f.by, runId: f.runId,
    source: { type: 'human', ref: `Answer to the operator's question in task ${f.runId}`, by: f.by, date: f.date } }); } catch { /* unknown entity */ }
}
const facts = mem.data.facts;
fs.writeFileSync(path.join(OUT, 'data', 'memory.json'), JSON.stringify({ company: mem.data.company, procedures: mem.data.procedures,
  entities: mem.data.entities.map((e) => ({ ...e, facts: facts.filter((f) => f.entity === e.id).length, pending: 0 })), pending: [] }));
for (const e of mem.data.entities) {
  fs.writeFileSync(path.join(OUT, 'data', 'memory', `${e.id}.json`), JSON.stringify({ entity: e,
    facts: mem.factsFor(e.id).map((f) => ({ ...f, current: mem.isCurrent(f), sourceText: mem.formatSource(f.source) })) }));
}
fs.rmSync(tmp, { force: true });

const size = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((n, x) => n + (x.isDirectory() ? size(path.join(d, x.name)) : fs.statSync(path.join(d, x.name)).size), 0);
console.log(`showcase/: ${summaries.length} runs, ${(size(OUT) / 1e6).toFixed(1)} MB`);
