// Central configuration. Everything company-specific lives in company/; this file only holds paths and knobs.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const config = {
  root: ROOT,
  companyDir: process.env.OPERATOR_COMPANY_DIR ?? path.join(ROOT, 'company'),
  runsDir: process.env.OPERATOR_RUNS_DIR ?? path.join(ROOT, 'runs'),
  dataDir: process.env.OPERATOR_DATA_DIR ?? path.join(ROOT, 'data'),
  brain: process.env.OPERATOR_BRAIN ?? 'claude-code',
  model: process.env.OPERATOR_MODEL ?? 'sonnet',
  verifierModel: process.env.OPERATOR_VERIFIER_MODEL ?? process.env.OPERATOR_MODEL ?? 'sonnet',
  maxSteps: Number(process.env.OPERATOR_MAX_STEPS ?? 60),
  maxMinutes: Number(process.env.OPERATOR_MAX_MINUTES ?? 30),
  verifierMaxSteps: Number(process.env.OPERATOR_VERIFIER_MAX_STEPS ?? 16),
  fixRounds: Number(process.env.OPERATOR_FIX_ROUNDS ?? 1),
  headed: process.env.HEADED === '1',
  slowMo: Number(process.env.SLOWMO ?? 0),
  humanName: process.env.OPERATOR_HUMAN ?? 'Nisha Kapoor',
  adminUrl: process.env.SANDBOX_ADMIN_URL ?? 'http://localhost:4199',
};

export interface SystemConfig {
  id: string; name: string; baseUrl: string; purpose: string;
  login: { path: string; usernameField: string; passwordField: string };
}
export interface CompanyConfig {
  company: string;
  systems: SystemConfig[];
  vault: Record<string, { username: string; password: string }>;
  policies: import('./runtime/policy.js').PolicyRule[];
}

export function loadCompany(dir = config.companyDir): CompanyConfig {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const systems = read('systems.json');
  const vault = read('vault.json');
  delete vault._comment;
  return { company: systems.company, systems: systems.systems, vault, policies: read('policies.json').rules };
}
