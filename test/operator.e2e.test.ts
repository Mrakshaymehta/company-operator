// End to end without a model: a scripted brain drives the real runtime, real browser, real sandbox and real policy gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startSandbox } from '../sandbox/server.js';
import { loadCompany } from '../src/config.js';
import { CompanyMemory } from '../src/memory/store.js';
import { Operator } from '../src/runtime/operator.js';
import { ScriptedHuman } from '../src/runtime/human.js';
import { ScriptedBrain } from '../src/brain/scripted.js';
import { closeBrowser } from '../src/tools/browser.js';
import type { BrainRequest } from '../src/brain/types.js';

const ports = { books: 5301, mail: 5302, admin: 5399 };
const BOOKS = `http://localhost:${ports.books}`;
const MAIL = `http://localhost:${ports.mail}`;
let sb: Awaited<ReturnType<typeof startSandbox>>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-e2e-'));

beforeAll(async () => { sb = await startSandbox(ports); });
afterAll(async () => { await closeBrowser(); await sb.close(); });

/** Finds an element number in the latest page shown to the model. */
function ref(req: BrainRequest, pattern: RegExp): number {
  const obs = req.prompt.slice(req.prompt.lastIndexOf('CURRENT OBSERVATION'));
  const line = obs.split('\n').find((l) => /^\[\d+\]/.test(l) && pattern.test(l));
  if (!line) throw new Error(`No element matching ${pattern} on the current page:\n${obs.slice(0, 1500)}`);
  return Number(line.match(/^\[(\d+)\]/)![1]);
}
const act = (tool: string, args: Record<string, unknown>, reason = `scripted: ${tool}`) => ({ reason, tool, args });

describe('operator runtime (scripted brain)', () => {
  it('holds a large bill for approval, sends the identical form after approval, and passes the checker', async () => {
    const company = loadCompany();
    company.systems = company.systems.map((s) => ({ ...s, baseUrl: s.id === 'books' ? BOOKS : MAIL }));
    const memFile = path.join(tmp, 'memory.json');
    CompanyMemory.reset({ file: memFile });
    const brain = new ScriptedBrain([
      { intent: 'Enter Swift Cargo invoice', success_criteria: ['Exactly one bill for SCM-2026-1187'], entities: ['swift-cargo'], procedures: ['enter-supplier-invoice'], plan: ['find invoice', 'enter bill'], question: '', options: [] },
      act('browser_login', { system: 'mail' }),
      act('browser_open', { url: `${MAIL}/?q=SCM-2026-1187` }),
      (r: BrainRequest) => act('browser_click', { ref: ref(r, /Invoice SCM-2026-1187/) }),
      (r: BrainRequest) => act('browser_click', { ref: ref(r, /Download SCM-2026-1187\.pdf/) }),
      act('files_read', { path: 'downloads/SCM-2026-1187.pdf' }),
      act('browser_login', { system: 'books' }),
      act('browser_open', { url: `${BOOKS}/bills/new` }),
      (r: BrainRequest) => act('browser_fill_form', {
        fields: [
          { ref: ref(r, /select "Supplier"/), value: 'Swift Cargo Movers' },
          { ref: ref(r, /"Supplier invoice no\."/), value: 'SCM-2026-1187' },
          { ref: ref(r, /"Invoice date"/), value: '2026-09-28' },
          { ref: ref(r, /"Due date"/), value: '2026-10-28' },
          { ref: ref(r, /"Amount/), value: '118000.00' },
          { ref: ref(r, /select "Category"/), value: 'Logistics' },
        ],
        submit_ref: ref(r, /button "Save bill"/),
      }),
      (r: BrainRequest) => { expect(r.prompt).toMatch(/APPROVED by/); return act('browser_click', { ref: ref(r, /button "Save bill"/) }); },
      (r: BrainRequest) => { expect(r.prompt).toMatch(/Bill BILL-0031 saved/); return act('finish', { status: 'done', summary: 'Entered SCM-2026-1187 as BILL-0031.', evidence: [{ criterion: 'one bill', proof: 'BILL-0031' }] }); },
      // checker
      act('browser_login', { system: 'books' }),
      (r: BrainRequest) => { expect(r.prompt).toMatch(/RUNTIME RECORDS[\s\S]*approved by Approver/); return act('browser_open', { url: `${BOOKS}/bills/BILL-0031` }); },
      (r: BrainRequest) => { expect(r.prompt).toMatch(/SCM-2026-1187/); return act('verdict', { overall: 'pass', criteria: [{ criterion: 'Exactly one bill for SCM-2026-1187', status: 'pass', evidence: 'BILL-0031 page' }], notes: '' }); },
    ]);
    const human = new ScriptedHuman({ approvals: 'approve', name: 'Approver' });
    const op = new Operator({ brain, human, memory: CompanyMemory.load({ file: memFile }), company, runsDir: path.join(tmp, 'runs'), options: { headed: false } });

    const run = await op.start('Enter the latest invoice from Swift Cargo.');

    expect(run.status).toBe('completed');
    expect(human.approvalsSeen).toHaveLength(1);
    expect(human.approvalsSeen[0].fields.amount).toBe('118000.00');
    expect(run.approvals[0]).toMatchObject({ ruleId: 'bills-over-50k', decision: 'approved' });
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]).toMatchObject({ path: '/bills', approvalId: run.approvals[0].id });
    const truth = await fetch(`http://localhost:${ports.admin}/state`).then((r) => r.json());
    expect(truth.bills.filter((b: { invoiceNo: string }) => b.invoiceNo === 'SCM-2026-1187')).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, 'runs', run.id, 'report.md'))).toBe(true);
  }, 120_000);
});
