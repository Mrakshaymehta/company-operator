// Background work: a durable task queue and interval schedules. Tasks run one at a time per company,
// so two runs never fight over the same records. Persisted to data/queue.json so restarts keep the queue.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface Job {
  id: string; goal: string; kind: 'start' | 'resume'; resumeRunId?: string; source: 'person' | 'schedule'; scheduleId?: string; model?: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'; runId?: string; createdAt: string; startedAt?: string; endedAt?: string; error?: string;
}
export interface Schedule { id: string; goal: string; everyMinutes: number; enabled: boolean; createdAt: string; lastRunAt?: string }
type Starter = (job: Job, onCreated: (runId: string) => void) => Promise<void>;

const rid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export class WorkQueue extends EventEmitter {
  jobs: Job[] = [];
  schedules: Schedule[] = [];
  private running = 0;
  private timer?: NodeJS.Timeout;

  constructor(private file: string, private starter: Starter, private concurrency = 1) {
    super();
    this.load();
  }

  private load() {
    if (fs.existsSync(this.file)) {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.jobs = (j.jobs ?? []).map((x: Job) => (x.status === 'running' ? { ...x, status: 'interrupted' } : x));
      this.schedules = j.schedules ?? [];
    }
    if (!this.schedules.length) {
      this.schedules.push({ id: 'sch_inbox', goal: 'Check the accounts inbox for supplier invoices that are not yet in Kaira Books, and enter them.', everyMinutes: 5, enabled: false, createdAt: new Date().toISOString() });
    }
    this.save();
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ jobs: this.jobs.slice(-200), schedules: this.schedules }, null, 2));
    this.emit('change');
  }

  start() { this.pump(); this.timer = setInterval(() => this.tick(), 15000); }
  stop() { clearInterval(this.timer); }

  enqueue(goal: string, opts: Partial<Pick<Job, 'source' | 'scheduleId' | 'model' | 'kind' | 'resumeRunId'>> = {}): Job {
    const job: Job = { id: rid('job'), goal, kind: opts.kind ?? 'start', resumeRunId: opts.resumeRunId, source: opts.source ?? 'person', scheduleId: opts.scheduleId, model: opts.model, status: 'queued', createdAt: new Date().toISOString() };
    this.jobs.push(job);
    this.save();
    this.pump();
    return job;
  }
  position(job: Job) { return this.jobs.filter((j) => j.status === 'queued').indexOf(job) + 1; }

  /** Resolves with the run id if the job starts within the wait, otherwise undefined (still queued). */
  waitForRun(job: Job, ms = 5000): Promise<string | undefined> {
    if (job.runId) return Promise.resolve(job.runId);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('change', check); resolve(undefined); }, ms);
      const check = () => { if (job.runId) { clearTimeout(t); this.off('change', check); resolve(job.runId); } };
      this.on('change', check);
    });
  }

  private pump() {
    while (this.running < this.concurrency) {
      const job = this.jobs.find((j) => j.status === 'queued');
      if (!job) return;
      this.running++;
      job.status = 'running'; job.startedAt = new Date().toISOString();
      if (job.resumeRunId) job.runId = job.resumeRunId;
      this.save();
      this.starter(job, (runId) => { job.runId = runId; this.save(); })
        .then(() => { job.status = 'done'; })
        .catch((e) => { job.status = 'failed'; job.error = (e as Error).message; })
        .finally(() => { job.endedAt = new Date().toISOString(); this.running--; this.save(); this.pump(); });
    }
  }

  tick(now = Date.now()) {
    for (const s of this.schedules) {
      if (!s.enabled) continue;
      const due = !s.lastRunAt || now - Date.parse(s.lastRunAt) >= s.everyMinutes * 60000;
      const pending = this.jobs.some((j) => j.scheduleId === s.id && (j.status === 'queued' || j.status === 'running'));
      if (due && !pending) { s.lastRunAt = new Date(now).toISOString(); this.enqueue(s.goal, { source: 'schedule', scheduleId: s.id }); }
    }
  }

  addSchedule(goal: string, everyMinutes: number) {
    const s: Schedule = { id: rid('sch'), goal, everyMinutes: Math.max(1, Math.round(everyMinutes)), enabled: true, createdAt: new Date().toISOString() };
    this.schedules.push(s); this.save(); return s;
  }
  updateSchedule(id: string, patch: Partial<Pick<Schedule, 'enabled' | 'everyMinutes' | 'goal'>>) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return undefined;
    Object.assign(s, patch);
    if (patch.enabled) s.lastRunAt = undefined; // run soon after it is switched on
    this.save(); return s;
  }
  removeSchedule(id: string) { this.schedules = this.schedules.filter((s) => s.id !== id); this.save(); }
  runNow(id: string) { const s = this.schedules.find((x) => x.id === id); if (!s) return undefined; s.lastRunAt = new Date().toISOString(); return this.enqueue(s.goal, { source: 'schedule', scheduleId: s.id }); }
}
