import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { WorkQueue, type Job } from '../src/console/queue.js';

const file = () => path.join(os.tmpdir(), `queue-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('work queue', () => {
  it('runs one task at a time, in order', async () => {
    const order: string[] = []; const release: (() => void)[] = [];
    const q = new WorkQueue(file(), (job: Job, onCreated) => { order.push(job.goal); onCreated(`r_${job.goal}`); return new Promise<void>((r) => release.push(r)); });
    q.start(); q.stop();
    const a = q.enqueue('a'); const b = q.enqueue('b');
    await tick();
    expect(a.status).toBe('running'); expect(b.status).toBe('queued'); expect(q.position(b)).toBe(1);
    release[0](); await tick();
    expect(a.status).toBe('done'); expect(b.status).toBe('running'); expect(order).toEqual(['a', 'b']);
  });
  it('fires due schedules once, without piling up', async () => {
    const q = new WorkQueue(file(), () => new Promise<void>(() => undefined));
    q.stop();
    const s = q.addSchedule('check inbox', 5);
    q.tick(); q.tick();
    expect(q.jobs.filter((j) => j.scheduleId === s.id)).toHaveLength(1);
  });
  it('marks tasks that were running at a crash as interrupted on reload', async () => {
    const f = file();
    const q = new WorkQueue(f, () => new Promise<void>(() => undefined));
    q.enqueue('x'); await tick();
    const reloaded = new WorkQueue(f, () => Promise.resolve());
    expect(reloaded.jobs[0].status).toBe('interrupted');
  });
});
