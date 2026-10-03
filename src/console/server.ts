// The operator console: start tasks, watch them live, approve, answer, read reports, browse and confirm company memory.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { config, loadCompany } from '../config.js';
import { makeBrain } from '../brain/index.js';
import { CompanyMemory } from '../memory/store.js';
import { Operator } from '../runtime/operator.js';
import { RunStore, runBus } from '../runtime/events.js';
import { reduce, type RunState } from '../runtime/state.js';
import type { ApprovalDecision, ApprovalRequest, HumanChannel, QuestionAnswer, QuestionRequest } from '../runtime/human.js';
import type { RunEvent } from '../runtime/types.js';
import { WorkQueue, type Job } from './queue.js';

/** People answer through the web page: requests wait here until someone clicks. */
class WebHuman implements HumanChannel {
  private waiting = new Map<string, (v: unknown) => void>();
  ask(q: QuestionRequest) { return new Promise<QuestionAnswer>((r) => this.waiting.set(`${q.runId}:${q.id}`, r as (v: unknown) => void)); }
  approve(a: ApprovalRequest) { return new Promise<ApprovalDecision>((r) => this.waiting.set(`${a.runId}:${a.id}`, r as (v: unknown) => void)); }
  isWaiting(runId: string, id: string) { return this.waiting.has(`${runId}:${id}`); }
  resolve(runId: string, id: string, value: unknown) {
    const r = this.waiting.get(`${runId}:${id}`);
    if (!r) return false;
    this.waiting.delete(`${runId}:${id}`); r(value); return true;
  }
}

export function consoleApp() {
  const app = express();
  app.use(express.json());
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(here, 'public')));
  app.use('/files', express.static(config.runsDir));

  const human = new WebHuman();
  const memory = CompanyMemory.load();
  const company = loadCompany();
  const active = new Set<string>();
  const person = config.humanName;
  const makeOperator = (model?: string) => new Operator({ brain: makeBrain(model || config.model), checkerBrain: makeBrain(model || config.verifierModel), human, memory, company, options: { headed: config.headed } });

  // Every task, whether a person typed it, a schedule fired it, or it is a resume, goes through one durable queue.
  const queue = new WorkQueue(path.join(config.dataDir, 'queue.json'), async (job: Job, onCreated) => {
    let runId = job.resumeRunId ?? '';
    try {
      if (job.kind === 'resume' && job.resumeRunId) { active.add(job.resumeRunId); await makeOperator(job.model).resume(job.resumeRunId); }
      else await makeOperator(job.model).start(job.goal, (id) => { runId = id; active.add(id); onCreated(id); });
    } finally { active.delete(runId); }
  });
  queue.start();
  const jobFor = (runId: string) => [...queue.jobs].reverse().find((j) => j.runId === runId);

  const summary = (id: string) => {
    const s = reduce(RunStore.open(id).read());
    const v = s.verdicts.at(-1);
    const terminal = ['completed', 'needs_human', 'failed'].includes(s.status);
    return { id, goal: s.goal, status: s.status, steps: s.steps.length, startedAt: s.startedAt, updatedAt: s.updatedAt, summary: s.finished?.summary,
      checks: v ? { passed: v.criteria.filter((c) => c.status === 'pass').length, total: v.criteria.length } : null,
      // A run that is not terminal and not running in this process is either running elsewhere (CLI, tests) or was interrupted.
      active: active.has(id), elsewhere: !terminal && !active.has(id) && Date.now() - Date.parse(s.updatedAt) < 180000,
      interrupted: !terminal && !active.has(id) && Date.now() - Date.parse(s.updatedAt) >= 180000, approvals: s.approvals.length, questions: s.questions.length, resumes: s.resumes,
      waiting: s.pendingApproval ? 'approval' : s.pendingQuestion ? 'question' : null, flags: s.finishes.at(-1)?.args.flags?.length ?? 0,
      brainCalls: s.brainCalls, brainMs: s.brainMs, costUsd: Math.round(s.costUsd * 100) / 100, endedAt: s.finished?.at, source: jobFor(id)?.source ?? 'person' };
  };
  const slim = (s: RunState) => ({
    ...s,
    steps: s.steps.map((st) => ({ ...st, result: st.result && { ...st.result, observation: st.result.observation.slice(0, 2500) } })),
    verifierSteps: s.verifierSteps.map((st) => ({ ...st, result: st.result && { ...st.result, observation: '' } })),
  });

  app.get('/api/tests', (_req, res) => res.json({ running: testsRunning() }));
  app.get('/api/info', (_req, res) => res.json({ company: company.company, person, model: config.model, checker: config.verifierModel, systems: company.systems.map((x) => ({ id: x.id, name: x.name, url: x.baseUrl })) }));
  app.get('/api/runs', (_req, res) => res.json(RunStore.list().slice(0, 50).map(summary)));
  app.get('/api/runs/:id', (req, res) => {
    try {
      const s = reduce(RunStore.open(req.params.id).read());
      memory.refresh();
      const learned = memory.data.facts.filter((f) => f.runId === s.id).map((f) => ({ id: f.id, text: f.text, status: f.status, entity: memory.entity(f.entity)?.name ?? f.entity, source: memory.formatSource(f.source) }));
      res.json({ state: slim(s), summary: summary(s.id), learned,
        live: { question: s.pendingQuestion ? human.isWaiting(s.id, s.pendingQuestion.id) : false, approval: s.pendingApproval ? human.isWaiting(s.id, s.pendingApproval.id) : false } });
    } catch (e) { res.status(404).json({ error: (e as Error).message }); }
  });
  app.get('/api/runs/:id/steps/:step', (req, res) => {
    const s = reduce(RunStore.open(req.params.id).read());
    const st = (req.query.role === 'verifier' ? s.verifierSteps : s.steps).find((x) => x.step === Number(req.params.step));
    res.json(st ?? null);
  });
  app.post('/api/runs', async (req, res) => {
    const goal = String(req.body?.goal ?? '').trim();
    if (!goal) return res.status(400).json({ error: 'Type a task first.' });
    const job = queue.enqueue(goal, { source: 'person', model: req.body?.model || undefined });
    const id = await queue.waitForRun(job, 6000);
    res.json(id ? { id } : { queued: job.id, position: queue.position(job) });
  });
  app.post('/api/runs/:id/resume', (req, res) => {
    const id = req.params.id;
    if (active.has(id) || queue.jobs.some((j) => j.resumeRunId === id && (j.status === 'queued' || j.status === 'running'))) return res.json({ id, already: true });
    const s = reduce(RunStore.open(id).read());
    queue.enqueue(s.goal, { kind: 'resume', resumeRunId: id, source: 'person' });
    res.json({ id });
  });

  app.post('/api/runs/archive', (_req, res) => {
    const dest = path.join(config.runsDir, '_archive');
    fs.mkdirSync(dest, { recursive: true });
    let archived = 0;
    for (const id of RunStore.list()) {
      const s = summary(id);
      if (s.active || !['completed', 'needs_human', 'failed'].includes(s.status)) continue;
      fs.renameSync(path.join(config.runsDir, id), path.join(dest, id)); archived++;
    }
    res.json({ archived });
  });

  // Queue and schedules
  app.get('/api/queue', (_req, res) => res.json({ jobs: [...queue.jobs].reverse().slice(0, 30), schedules: queue.schedules }));
  app.post('/api/schedules', (req, res) => {
    const goal = String(req.body?.goal ?? '').trim(); const every = Number(req.body?.everyMinutes);
    if (!goal || !(every >= 1)) return res.status(400).json({ error: 'Give a task and an interval of at least 1 minute.' });
    res.json(queue.addSchedule(goal, every));
  });
  app.post('/api/schedules/:id', (req, res) => {
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (Number(req.body?.everyMinutes) >= 1) patch.everyMinutes = Math.round(Number(req.body.everyMinutes));
    const s = queue.updateSchedule(req.params.id, patch);
    res.status(s ? 200 : 404).json(s ?? { error: 'Not found' });
  });
  app.post('/api/schedules/:id/run', (req, res) => { const j = queue.runNow(req.params.id); res.status(j ? 200 : 404).json(j ?? { error: 'Not found' }); });
  app.post('/api/schedules/:id/delete', (req, res) => { queue.removeSchedule(req.params.id); res.json({ ok: true }); });
  app.post('/api/runs/:id/answer', (req, res) => {
    const { questionId, answer, remember } = req.body ?? {};
    if (!String(answer ?? '').trim()) return res.status(400).json({ error: 'Write or choose an answer.' });
    const ok = human.resolve(req.params.id, questionId, { answer: String(answer).trim(), by: person, remember: !!remember });
    res.status(ok ? 200 : 409).json(ok ? { ok } : { error: 'This question is no longer waiting. Resume the task to ask it again.' });
  });
  app.post('/api/runs/:id/approval', (req, res) => {
    const { approvalId, decision, note } = req.body ?? {};
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
    const ok = human.resolve(req.params.id, approvalId, { decision, by: person, note: note ? String(note) : undefined });
    res.status(ok ? 200 : 409).json(ok ? { ok } : { error: 'This approval is no longer waiting. Resume the task to ask again.' });
  });

  // Company memory
  app.get('/api/memory', (_req, res) => {
    memory.refresh();
    const { entities, facts, procedures, company: c } = memory.data;
    res.json({ company: c, procedures, entities: entities.map((e) => ({ ...e, facts: facts.filter((f) => f.entity === e.id).length, pending: facts.filter((f) => f.entity === e.id && f.status === 'pending').length })),
      pending: facts.filter((f) => f.status === 'pending').map((f) => ({ ...f, entityName: memory.entity(f.entity)?.name, sourceText: memory.formatSource(f.source) })) });
  });
  app.get('/api/memory/entity/:id', (req, res) => {
    memory.refresh();
    const e = memory.entity(req.params.id);
    if (!e) return res.status(404).json({ error: 'Not found' });
    const facts = memory.factsFor(e.id).map((f) => ({ ...f, current: memory.isCurrent(f), sourceText: memory.formatSource(f.source) }));
    res.json({ entity: e, facts });
  });
  app.post('/api/memory/facts/:id', (req, res) => {
    const status = req.body?.status;
    if (!['confirmed', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be confirmed or rejected' });
    const f = memory.setStatus(req.params.id, status, person);
    res.status(f ? 200 : 404).json(f ?? { error: 'Not found' });
  });

  // Demo controls for the pretend company
  const admin = (p: string, body?: unknown) => fetch(`${config.adminUrl}${p}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const testsRunning = () => { try { const pid = Number(fs.readFileSync(path.join(config.dataDir, 'eval.lock'), 'utf8')); process.kill(pid, 0); return true; } catch { return false; } };
  app.get('/api/sandbox', async (_req, res) => { try { res.json({ ok: true, testsRunning: testsRunning(), ...(await admin('/faults')) }); } catch { res.json({ ok: false, testsRunning: testsRunning() }); } });
  app.post('/api/sandbox/reset', async (_req, res) => { try { await admin('/reset', {}); CompanyMemory.reset(); memory.refresh(); res.json({ ok: true }); } catch (e) { res.status(502).json({ error: `Sandbox not reachable: ${(e as Error).message}` }); } });
  app.get('/api/sandbox/deliveries', async (_req, res) => { try { res.json(await admin('/deliveries')); } catch { res.json([]); } });
  app.post('/api/sandbox/deliver', async (req, res) => { try { res.json(await admin('/deliver', { kind: req.body?.kind })); } catch (e) { res.status(502).json({ error: (e as Error).message }); } });
  app.post('/api/sandbox/faults', async (req, res) => { try { res.json(await admin('/faults', req.body ?? {})); } catch (e) { res.status(502).json({ error: (e as Error).message }); } });

  // Live updates
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const only = req.query.run ? String(req.query.run) : null;
    const onEvent = (e: RunEvent) => { if (!only || e.runId === only) res.write(`data: ${JSON.stringify({ runId: e.runId, type: e.type, seq: e.seq })}\n\n`); };
    const onQueue = () => { if (!only) res.write(`data: ${JSON.stringify({ type: 'queue' })}\n\n`); };
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    runBus.on('event', onEvent);
    queue.on('change', onQueue);
    req.on('close', () => { clearInterval(ping); runBus.off('event', onEvent); queue.off('change', onQueue); });
  });
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.CONSOLE_PORT ?? 4000);
  consoleApp().listen(port, () => console.log(`Operator console: http://localhost:${port}  (brain: claude-code ${config.model}${config.headed ? ', visible browser' : ''})`));
}
