import { beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { CompanyMemory } from '../src/memory/store.js';

const file = path.join(os.tmpdir(), `memory-test-${process.pid}.json`);
let m: CompanyMemory;
beforeEach(() => { CompanyMemory.reset({ file }); m = CompanyMemory.load({ file }); });

describe('company memory', () => {
  it('resolves nicknames to entities', () => {
    expect(m.entity('Rajesh')?.id).toBe('rajesh-packaging');
    expect(m.entity('RPI')?.id).toBe('rajesh-packaging');
    expect(m.entity('Swift Cargo')?.links.books).toBe('S-1003');
  });
  it('keeps replaced facts as history and shows current ones by default', () => {
    const card = m.entityCard('rajesh-packaging')!;
    expect(card).toMatch(/Current facts:[\s\S]*4\.20/);
    expect(card).toMatch(/History[\s\S]*4\.80/);
    expect(m.search('mailer box price').facts.some((f) => /4\.80/.test(f.text))).toBe(false);
    expect(m.search('mailer box price', { includeHistory: true }).facts.some((f) => /4\.80/.test(f.text))).toBe(true);
  });
  it('saves a person\'s answer as confirmed, superseding an older fact of the same kind', () => {
    const before = m.factsFor('sunrise-labels').length;
    const f = m.add({ entity: 'sunrise-labels', kind: 'expense_category', text: 'Expense category for bills: Labels and printing.', status: 'confirmed', createdBy: 'Nisha', source: { type: 'human', ref: 'test' } });
    expect(m.factsFor('sunrise-labels').length).toBe(before + 1);
    const g = m.add({ entity: 'sunrise-labels', kind: 'expense_category', text: 'Expense category for bills: Packaging.', status: 'confirmed', createdBy: 'Nisha', source: { type: 'human', ref: 'test' } });
    const reloaded = CompanyMemory.load({ file });
    expect(reloaded.data.facts.find((x) => x.id === f.id)?.supersededBy).toBe(g.id);
  });
  it('facts learned by the operator wait for confirmation', () => {
    const f = m.add({ entity: 'rajesh-packaging', kind: 'invoice_format', text: 'Invoices do not print a due date.', status: 'pending', createdBy: 'operator', source: { type: 'run', ref: 'r_test' } });
    expect(m.entityCard('rajesh-packaging')).toMatch(/Pending[\s\S]*do not print a due date/);
    m.setStatus(f.id, 'confirmed', 'Nisha');
    expect(CompanyMemory.load({ file }).data.facts.find((x) => x.id === f.id)?.status).toBe('confirmed');
  });
  it('rejects facts about unknown entities', () => {
    expect(() => m.add({ entity: 'nobody', kind: 'x', text: 'y', status: 'pending', createdBy: 'operator', source: { type: 'run', ref: 'r' } })).toThrow();
  });
});
