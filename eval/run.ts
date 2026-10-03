// Runs the demo tasks against a fresh Kaira Naturals and grades them on the sandbox's true state.
//   pnpm eval                 all tasks once
//   pnpm eval 1 3 --repeat 3  chosen tasks, three times each
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, loadCompany, ROOT } from '../src/config.js';
import { makeBrain } from '../src/brain/index.js';
import { CompanyMemory } from '../src/memory/store.js';
import { Operator } from '../src/runtime/operator.js';
import { RunStore } from '../src/runtime/events.js';
import type { RunState } from '../src/runtime/state.js';
import { ScriptedHuman } from '../src/runtime/human.js';
import { closeBrowser } from '../src/tools/browser.js';
import { attachPrinter } from '../src/printer.js';
import { SCENARIOS, type Check, type Scenario } from './scenarios.js';

const args = process.argv.slice(2);
const take = (f: string) => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const repeat = Number(take('--repeat') ?? 1);
const model = take('--model') ?? config.model;
const verbose = args.includes('--verbose') ? (args.splice(args.indexOf('--verbose'), 1), true) : false;
const chosen = args.length ? SCENARIOS.filter((s) => args.some((a) => s.id === a || s.id.split('-')[0] === a)) : SCENARIOS;

const admin = (p: string, body?: unknown) => fetch(`${config.adminUrl}${p}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function runCrashing(goal: string, after: number): Promise<string> {
  // Start the operator in a child process, kill it hard after N actions, and return the run id.
  const before = new Set(RunStore.list());
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/cli.ts'), 'run', goal, '--auto-approve', '--model', model], { cwd: ROOT, stdio: 'ignore' });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const id = RunStore.list().find((x) => !before.has(x));
    if (!id) continue;
    const results = RunStore.open(id).read().filter((e) => e.type === 'result' && e.role === 'executor').length;
    if (results >= after || child.exitCode !== null) { child.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 500)); return id; }
  }
}

async function runScenario(s: Scenario) {
  await admin('/reset', {});
  CompanyMemory.reset();
  if (s.faults) await admin('/faults', s.faults);
  const human = new ScriptedHuman({ ...s.human, name: 'Nisha Kapoor (test script)' });
  const memory = CompanyMemory.load();
  const operator = new Operator({ brain: makeBrain(model), checkerBrain: makeBrain(model), human, memory, company: loadCompany(), options: { headed: config.headed, ...(s.options ?? {}) } });
  const runs: RunState[] = [];
  const t0 = Date.now();
  for (const goal of s.goals) {
    if (s.crashAfterResults) {
      const id = await runCrashing(goal, s.crashAfterResults);
      console.log(`  (killed the operator process mid-run: ${id}; resuming)`);
      runs.push(await operator.resume(id));
    } else runs.push(await operator.start(goal));
  }
  const truth = await admin('/state');
  const fired = (await admin('/faults')).fired ?? [];
  memory.refresh();
  const checks: Check[] = s.check({ truth, runs, human, memory, fired });
  return { id: s.id, title: s.title, pass: checks.every((c) => c.pass), checks, runs: runs.map((r) => r.id), steps: runs.reduce((n, r) => n + r.steps.length, 0),
    checkerSteps: runs.reduce((n, r) => n + r.verifierSteps.length, 0), minutes: (Date.now() - t0) / 60000 };
}

/** Only one test round may drive the sandbox at a time: rounds reset the company between tasks. */
const LOCK = path.join(config.dataDir, 'eval.lock');
function takeLock() {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    try { process.kill(pid, 0); throw new Error(`Another test round is running (process ${pid}). Stop it first, or wait for it to finish.`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));
  const release = () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch { /* already gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { release(); process.exit(130); });
}

async function main() {
  takeLock();
  if (verbose) attachPrinter({ quietHumans: true });
  try { await admin('/faults'); } catch { throw new Error(`The sandbox is not running. Start it with: pnpm sandbox`); }
  const results = [];
  for (const s of chosen) {
    for (let r = 1; r <= repeat; r++) {
      console.log(`\n▸ ${s.id} (${r}/${repeat}): ${s.title}`);
      const res = await runScenario(s);
      results.push(res);
      for (const c of res.checks) console.log(`  ${c.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.name}${c.detail ? `  \x1b[2m${c.detail}\x1b[0m` : ''}`);
      console.log(`  ${res.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${res.steps} steps + ${res.checkerSteps} checker steps, ${res.minutes.toFixed(1)} min, runs: ${res.runs.join(', ')}`);
    }
  }
  console.log('\nSummary');
  const byId = new Map<string, typeof results>();
  for (const r of results) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  for (const [id, rs] of byId) console.log(`  ${id.padEnd(22)} ${rs.filter((r) => r.pass).length}/${rs.length} passed  avg ${(rs.reduce((n, r) => n + r.steps, 0) / rs.length).toFixed(0)} steps, ${(rs.reduce((n, r) => n + r.minutes, 0) / rs.length).toFixed(1)} min`);
  const dir = path.join(ROOT, 'eval', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ model, repeat, at: new Date().toISOString(), results }, null, 2));
  console.log(`\nSaved ${path.relative(ROOT, file)}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closeBrowser());
