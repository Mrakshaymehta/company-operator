// Policy gate: checks every request the browser tries to send against the company's rules (company/policies.json).
// It runs in our code, on the real outgoing request, so the model cannot talk its way around it.
import { createHash } from 'node:crypto';

export type Condition =
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'eq' | 'neq' | 'contains' | 'not_all_end_with'; value: string | number }
  | { product: [string, string]; op: 'gt' | 'gte' | 'lt'; value: number }
  | { any: Condition[] }
  | { all: Condition[] };

export interface PolicyRule {
  id: string; description: string; approver?: string;
  match: { system?: string; method?: string; path: string };
  when?: Condition;
  effect: 'require_approval' | 'deny';
  show?: string[]; bind?: string[];
}
export interface OutgoingRequest { system: string; method: string; path: string; fields: Record<string, string> }
export interface Grant { ruleId: string; fingerprint: string; approvalId: string; used: boolean }
export type Decision =
  | { effect: 'allow'; request: OutgoingRequest; grant?: Grant }
  | { effect: 'deny'; request: OutgoingRequest; rule: PolicyRule; reason: string }
  | { effect: 'require_approval'; request: OutgoingRequest; rule: PolicyRule; fingerprint: string; reason: string }
  | { effect: 'read_only'; request: OutgoingRequest; reason: string };

export const parseNumber = (v: unknown) => {
  const s = String(v ?? '').replace(/₹|INR|Rs\.?|,|\s/gi, '');
  return s === '' ? NaN : Number(s);
};

function holds(c: Condition, f: Record<string, string>): boolean {
  if ('any' in c) return c.any.some((x) => holds(x, f));
  if ('all' in c) return c.all.every((x) => holds(x, f));
  if ('product' in c) {
    const v = parseNumber(f[c.product[0]]) * parseNumber(f[c.product[1]]);
    if (Number.isNaN(v)) return false;
    return c.op === 'gt' ? v > c.value : c.op === 'gte' ? v >= c.value : v < c.value;
  }
  const raw = f[c.field] ?? '';
  switch (c.op) {
    case 'gt': case 'gte': case 'lt': {
      const n = parseNumber(raw);
      if (Number.isNaN(n)) return true; // unreadable amounts are treated as risky
      return c.op === 'gt' ? n > Number(c.value) : c.op === 'gte' ? n >= Number(c.value) : n < Number(c.value);
    }
    case 'eq': return raw.trim().toLowerCase() === String(c.value).toLowerCase();
    case 'neq': return raw.trim().toLowerCase() !== String(c.value).toLowerCase();
    case 'contains': return raw.toLowerCase().includes(String(c.value).toLowerCase());
    case 'not_all_end_with': {
      const parts = raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      return parts.length === 0 || parts.some((p) => !p.endsWith(String(c.value).toLowerCase()));
    }
  }
}

/** The same values always give the same fingerprint, so an approval covers exactly what the person saw. */
export function fingerprint(rule: PolicyRule, fields: Record<string, string>) {
  const keys = rule.bind ?? Object.keys(fields).sort();
  const norm = keys.map((k) => {
    const v = String(fields[k] ?? '').trim();
    const n = parseNumber(v);
    return `${k}=${/^[₹\d.,\sINRs]+$/i.test(v) && !Number.isNaN(n) ? n.toFixed(2) : v.toLowerCase().replace(/\s+/g, ' ')}`;
  });
  return createHash('sha256').update(`${rule.id}|${norm.join('|')}`).digest('hex').slice(0, 16);
}

export class PolicyGate {
  grants: Grant[] = [];
  constructor(public rules: PolicyRule[], private opts: { readOnly: boolean; loginPaths: Record<string, string> }) {}

  addGrant(g: Omit<Grant, 'used'>) { this.grants.push({ ...g, used: false }); }

  evaluate(req: OutgoingRequest): Decision {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return { effect: 'allow', request: req };
    const isLogin = this.opts.loginPaths[req.system] === req.path;
    if (isLogin) return { effect: 'allow', request: req };
    if (this.opts.readOnly) return { effect: 'read_only', request: req, reason: 'This browser session is read-only. It can look but cannot change anything.' };
    for (const rule of this.rules) {
      if (rule.match.system && rule.match.system !== req.system) continue;
      if (rule.match.method && rule.match.method.toUpperCase() !== method) continue;
      if (!new RegExp(rule.match.path).test(req.path)) continue;
      if (rule.when && !holds(rule.when, req.fields)) continue;
      if (rule.effect === 'deny') return { effect: 'deny', request: req, rule, reason: rule.description };
      const fp = fingerprint(rule, req.fields);
      const grant = this.grants.find((g) => g.ruleId === rule.id && g.fingerprint === fp && !g.used);
      if (grant) { grant.used = true; return { effect: 'allow', request: req, grant }; }
      return { effect: 'require_approval', request: req, rule, fingerprint: fp, reason: rule.description };
    }
    return { effect: 'allow', request: req };
  }
}
