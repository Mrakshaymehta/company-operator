// Faults switched on by the admin panel to test the operator's recovery. Each fault fires once.
import type { Request, Response, NextFunction } from 'express';

export type AppName = 'mail' | 'books';
export interface Faults {
  latencyMs: number;
  expireSessionAfter: Partial<Record<AppName, number>>; // log the user out after N authenticated requests
  failAfterSave: string[];  // e.g. "books:bills": save the record, then answer HTTP 500
  failBeforeSave: string[]; // e.g. "books:bills": answer HTTP 500 without saving
  uiVariant: Partial<Record<AppName, 'v1' | 'v2'>>; // v2 = a redesigned screen: new wording, new field order
}
export interface FiredFault { at: string; fault: string; detail: string }

const defaults = (): Faults => ({ latencyMs: 0, expireSessionAfter: {}, failAfterSave: [], failBeforeSave: [], uiVariant: {} });
let faults: Faults = defaults();
let fired: FiredFault[] = [];
// Authenticated requests seen since each logout fault was armed.
let sinceArmed: Partial<Record<AppName, number>> = {};

export const getFaults = () => faults;
export const firedFaults = () => fired;
export function resetFaults() { faults = defaults(); fired = []; sinceArmed = {}; }
export function setFaults(patch: Partial<Faults>) {
  for (const app of Object.keys(patch.expireSessionAfter ?? {}) as AppName[]) sinceArmed[app] = 0;
  faults = { ...faults, ...patch, expireSessionAfter: { ...faults.expireSessionAfter, ...(patch.expireSessionAfter ?? {}) }, uiVariant: { ...faults.uiVariant, ...(patch.uiVariant ?? {}) } };
  return faults;
}
export function recordFault(fault: string, detail: string) { fired.push({ at: new Date().toISOString(), fault, detail }); }

/** Returns true once if the named one-shot fault is armed, then disarms it. */
export function takeOneShot(kind: 'failAfterSave' | 'failBeforeSave', key: string): boolean {
  const i = faults[kind].indexOf(key);
  if (i === -1) return false;
  faults[kind] = faults[kind].filter((_, j) => j !== i);
  recordFault(kind, key);
  return true;
}

export async function latency(_req: Request, _res: Response, next: NextFunction) {
  if (faults.latencyMs > 0) await new Promise((r) => setTimeout(r, faults.latencyMs));
  next();
}

/** Counts an authenticated request; returns true once when the armed logout fault should fire. */
export function shouldExpireSession(app: AppName): boolean {
  const limit = faults.expireSessionAfter[app];
  if (!limit) return false;
  sinceArmed[app] = (sinceArmed[app] ?? 0) + 1;
  if ((sinceArmed[app] ?? 0) <= limit) return false;
  delete faults.expireSessionAfter[app];
  recordFault('expireSession', `${app} after ${limit} requests`);
  return true;
}
