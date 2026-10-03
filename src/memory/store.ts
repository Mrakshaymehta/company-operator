// Company memory: entities, dated facts with sources, and procedures. Facts are never deleted; replaced facts keep history.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type Shelf = 'people' | 'things' | 'promises' | 'rules' | 'money' | 'sources';
export interface Source { type: 'email' | 'system' | 'human' | 'policy' | 'document' | 'run'; ref: string; date?: string; by?: string; quote?: string }
export interface Fact {
  id: string; entity: string; shelf: Shelf; kind: string; text: string; source: Source;
  status: 'confirmed' | 'pending' | 'rejected'; validFrom?: string; validTo?: string; supersededBy?: string;
  createdAt?: string; createdBy?: string; runId?: string;
}
export interface Entity { id: string; type: string; name: string; aliases: string[]; summary: string; links: Record<string, string> }
export interface Procedure { id: string; title: string; summary: string; file: string }
export interface MemoryData { company: { name: string; summary: string; domain: string }; entities: Entity[]; facts: Fact[]; procedures: Procedure[] }

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'is', 'it', 'our', 'we', 'me', 'my', 'from', 'into', 'with', 'what', 'who', 'how', 'latest', 'please', 'their', 'them', 'this', 'that', 'be', 'by', 'at', 'as', 'once', 'done', 'tell', 'enter', 'find']);
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9₹.\/-]+/g) ?? []).map((t) => t.replace(/[.]+$/, '')).filter((t) => t.length > 1 && !STOP.has(t));

export class CompanyMemory {
  constructor(public data: MemoryData, private file: string | null, private seedDir: string) {}

  static seedPath(companyDir = config.companyDir) { return path.join(companyDir, 'memory', 'seed.json'); }

  /** Loads the live memory file, creating it from the company seed if it does not exist yet. */
  static load(opts: { file?: string; companyDir?: string } = {}): CompanyMemory {
    const companyDir = opts.companyDir ?? config.companyDir;
    const file = opts.file ?? path.join(config.dataDir, 'memory.json');
    if (!fs.existsSync(file)) CompanyMemory.reset({ file, companyDir });
    return new CompanyMemory(JSON.parse(fs.readFileSync(file, 'utf8')), file, path.join(companyDir, 'memory'));
  }
  static reset(opts: { file?: string; companyDir?: string } = {}) {
    const companyDir = opts.companyDir ?? config.companyDir;
    const file = opts.file ?? path.join(config.dataDir, 'memory.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(CompanyMemory.seedPath(companyDir), file);
  }
  /** Reloads from disk so a long-running process sees edits made elsewhere (console, CLI). */
  refresh() { if (this.file && fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  save() { if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }

  entity(idOrName: string): Entity | undefined {
    const q = idOrName.trim().toLowerCase();
    const all = this.data.entities;
    return all.find((e) => e.id === q) ?? all.find((e) => e.name.toLowerCase() === q || e.aliases.some((a) => a.toLowerCase() === q))
      ?? all.find((e) => e.name.toLowerCase().includes(q) || q.includes(e.name.toLowerCase()) || e.aliases.some((a) => q.includes(a.toLowerCase()) && a.length > 3));
  }
  procedure(id: string) { return this.data.procedures.find((p) => p.id === id || p.title.toLowerCase() === id.toLowerCase()); }
  procedureText(id: string): string | undefined {
    const p = this.procedure(id);
    return p ? fs.readFileSync(path.join(this.seedDir, p.file), 'utf8') : undefined;
  }
  isCurrent(f: Fact, today = new Date().toISOString().slice(0, 10)) {
    return f.status !== 'rejected' && !f.supersededBy && (!f.validTo || f.validTo >= today);
  }
  factsFor(entityId: string) { return this.data.facts.filter((f) => f.entity === entityId); }
  policies() { return this.data.facts.filter((f) => f.shelf === 'rules' && f.entity === 'kaira-naturals' && this.isCurrent(f)); }

  formatSource(s: Source) {
    return [s.ref, s.by, s.date].filter(Boolean).join(', ') + (s.quote ? `. Quote: "${s.quote}"` : '');
  }
  formatFact(f: Fact) {
    const e = this.entity(f.entity);
    const valid = f.validFrom || f.validTo ? ` (valid ${f.validFrom ?? '?'} to ${f.validTo ?? 'now'})` : '';
    const status = f.supersededBy ? `replaced by ${f.supersededBy}` : f.status;
    return `[${f.id}] ${e?.name ?? f.entity}: ${f.text}${valid}. Source: ${this.formatSource(f.source)}. Status: ${status}.`;
  }

  /** A compact table of contents, used when the operator first reads a task. */
  index(): string {
    const ents = this.data.entities.map((e) => `- ${e.id}: ${e.name} (${e.type}; also called ${e.aliases.join(', ') || 'nothing else'})${e.links.books ? `, Kaira Books code ${e.links.books}` : ''}. ${e.summary}`).join('\n');
    const procs = this.data.procedures.map((p) => `- ${p.id}: ${p.title}. ${p.summary}`).join('\n');
    const pols = this.policies().map((f) => `- ${f.text}`).join('\n');
    return `ENTITIES\n${ents}\n\nPROCEDURES\n${procs}\n\nPOLICIES\n${pols}`;
  }

  /** Everything known about one entity: current facts, replaced facts and open promises. */
  entityCard(idOrName: string): string | undefined {
    const e = this.entity(idOrName);
    if (!e) return undefined;
    const facts = this.factsFor(e.id);
    const current = facts.filter((f) => this.isCurrent(f) && f.status !== 'pending');
    const pending = facts.filter((f) => f.status === 'pending');
    const old = facts.filter((f) => !this.isCurrent(f) && f.status !== 'pending');
    const lines = [`${e.name} [${e.id}] (${e.type}). Also called: ${e.aliases.join(', ') || 'none'}. ${e.summary}${e.links.books ? ` Kaira Books code: ${e.links.books}.` : ''}`];
    lines.push('Current facts:', ...(current.length ? current.map((f) => '  ' + this.formatFact(f)) : ['  none recorded']));
    if (pending.length) lines.push('Pending (not yet confirmed by a person):', ...pending.map((f) => '  ' + this.formatFact(f)));
    if (old.length) lines.push('History (replaced or expired):', ...old.map((f) => '  ' + this.formatFact(f)));
    return lines.join('\n');
  }

  search(query: string, opts: { includeHistory?: boolean; limit?: number } = {}) {
    const q = tokens(query);
    const limit = opts.limit ?? 8;
    const score = (text: string) => { const t = new Set(tokens(text)); return q.reduce((s, w) => s + (t.has(w) ? 1 : [...t].some((x) => x.includes(w) || w.includes(x)) ? 0.4 : 0), 0); };
    const entities = this.data.entities.map((e) => ({ e, s: score(`${e.name} ${e.aliases.join(' ')} ${e.summary} ${e.id}`) * 1.5 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 4);
    const facts = this.data.facts.filter((f) => opts.includeHistory || this.isCurrent(f))
      .map((f) => { const e = this.entity(f.entity); return { f, s: score(`${f.text} ${f.kind} ${e?.name ?? ''} ${e?.aliases.join(' ') ?? ''}`) }; })
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
    const procs = this.data.procedures.map((p) => ({ p, s: score(`${p.title} ${p.summary}`) })).filter((x) => x.s > 0.5).sort((a, b) => b.s - a.s).slice(0, 3);
    return { entities: entities.map((x) => x.e), facts: facts.map((x) => x.f), procedures: procs.map((x) => x.p) };
  }

  private nextFactId() { return `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

  /** Adds a fact. Facts learned by the operator start as pending; answers from people are confirmed. */
  add(input: { entity: string; kind: string; text: string; shelf?: Shelf; source: Source; status: Fact['status']; runId?: string; createdBy: string }): Fact {
    const e = this.entity(input.entity);
    if (!e) throw new Error(`Unknown entity "${input.entity}". Use an id from company memory.`);
    const fact: Fact = { id: this.nextFactId(), entity: e.id, shelf: input.shelf ?? 'things', kind: input.kind, text: input.text, source: input.source,
      status: input.status, validFrom: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString(), createdBy: input.createdBy, runId: input.runId };
    // A confirmed fact of the same kind replaces the older one, keeping it as history.
    if (fact.status === 'confirmed') {
      for (const old of this.data.facts) if (old.entity === fact.entity && old.kind === fact.kind && this.isCurrent(old) && old.status === 'confirmed') old.supersededBy = fact.id;
    }
    this.data.facts.push(fact);
    this.save();
    return fact;
  }
  setStatus(id: string, status: 'confirmed' | 'rejected', by: string): Fact | undefined {
    const f = this.data.facts.find((x) => x.id === id);
    if (!f) return undefined;
    if (status === 'confirmed') for (const old of this.data.facts) if (old !== f && old.entity === f.entity && old.kind === f.kind && this.isCurrent(old) && old.status === 'confirmed') old.supersededBy = f.id;
    f.status = status;
    f.source = { ...f.source, ref: `${f.source.ref} (${status} by ${by})` };
    this.save();
    return f;
  }
}
