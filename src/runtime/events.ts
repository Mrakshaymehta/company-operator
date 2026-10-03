// The diary: one append-only JSONL file per run. Every decision, action, result, approval and answer is written here.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { EventInput, RunEvent } from './types.js';

/** Live feed of every event appended in this process, used by the terminal printer and the web console. */
export const runBus = new EventEmitter();
runBus.setMaxListeners(200);

export class RunStore {
  private seq = 0;
  constructor(public runId: string, public dir: string) {
    if (fs.existsSync(this.eventsFile)) this.seq = this.read().length;
  }
  get eventsFile() { return path.join(this.dir, 'events.jsonl'); }

  static newId() {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000); // IST, so ids read naturally for the Kaira team
    const p = (n: number) => String(n).padStart(2, '0');
    return `r_${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}_${Math.random().toString(36).slice(2, 5)}`;
  }
  static create(baseDir = config.runsDir) {
    const id = RunStore.newId();
    const dir = path.join(baseDir, id);
    for (const sub of ['screenshots', 'downloads', 'outputs']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    return new RunStore(id, dir);
  }
  static open(runId: string, baseDir = config.runsDir) {
    const dir = path.join(baseDir, runId);
    if (!fs.existsSync(path.join(dir, 'events.jsonl'))) throw new Error(`No run called ${runId} in ${baseDir}`);
    for (const sub of ['screenshots', 'downloads', 'outputs']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    return new RunStore(runId, dir);
  }
  static list(baseDir = config.runsDir): string[] {
    if (!fs.existsSync(baseDir)) return [];
    return fs.readdirSync(baseDir).filter((d) => fs.existsSync(path.join(baseDir, d, 'events.jsonl'))).sort().reverse();
  }

  append(e: EventInput): RunEvent {
    const event = { seq: ++this.seq, at: new Date().toISOString(), runId: this.runId, ...e } as RunEvent;
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n');
    runBus.emit('event', event);
    return event;
  }
  read(): RunEvent[] {
    if (!fs.existsSync(this.eventsFile)) return [];
    return fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  path(...parts: string[]) { return path.join(this.dir, ...parts); }
  rel(abs: string) { return path.relative(this.dir, abs); }
}
