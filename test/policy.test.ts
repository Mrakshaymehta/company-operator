import { describe, expect, it } from 'vitest';
import { PolicyGate, fingerprint, type PolicyRule } from '../src/runtime/policy.js';
import { loadCompany } from '../src/config.js';

const rules = loadCompany().policies;
const gate = (readOnly = false) => new PolicyGate(rules, { readOnly, loginPaths: { books: '/login', mail: '/login' } });
const bill = (amount: string) => ({ system: 'books', method: 'POST', path: '/bills', fields: { supplier_id: 'S-1003', invoice_no: 'SCM-1', invoice_date: '2026-09-28', due_date: '2026-10-28', amount, category: 'Logistics' } });

describe('policy gate', () => {
  it('lets reads and sign-ins through, even when read-only', () => {
    expect(gate(true).evaluate({ system: 'books', method: 'GET', path: '/bills', fields: {} }).effect).toBe('allow');
    expect(gate(true).evaluate({ system: 'books', method: 'POST', path: '/login', fields: {} }).effect).toBe('allow');
  });
  it('blocks every change in read-only mode (the checker)', () => {
    expect(gate(true).evaluate(bill('100')).effect).toBe('read_only');
  });
  it('allows small bills and holds bills above ₹50,000 for approval', () => {
    expect(gate().evaluate(bill('46020.00')).effect).toBe('allow');
    expect(gate().evaluate(bill('1,18,000.00')).effect).toBe('require_approval');
  });
  it('an approval covers exactly the approved values, once', () => {
    const g = gate();
    const d = g.evaluate(bill('118000'));
    if (d.effect !== 'require_approval') throw new Error('expected approval');
    g.addGrant({ ruleId: d.rule.id, fingerprint: d.fingerprint, approvalId: 'ap_1' });
    expect(g.evaluate({ ...bill('118000'), fields: { ...bill('118000').fields, amount: '120000' } }).effect).toBe('require_approval');
    const ok = g.evaluate(bill('1,18,000.00'));
    expect(ok.effect).toBe('allow');
    expect(g.evaluate(bill('118000')).effect).toBe('require_approval');
  });
  it('denies deletes and bank-detail changes outright', () => {
    expect(gate().evaluate({ system: 'books', method: 'POST', path: '/bills/BILL-0001/delete', fields: {} }).effect).toBe('deny');
    expect(gate().evaluate({ system: 'books', method: 'POST', path: '/suppliers/S-1003/bank', fields: { account_no: '1' } }).effect).toBe('deny');
  });
  it('holds emails to outsiders but not internal mail or drafts', () => {
    expect(gate().evaluate({ system: 'mail', method: 'POST', path: '/send', fields: { to: 'vikram@arihantstores.example', subject: 'x', body: 'y' } }).effect).toBe('require_approval');
    expect(gate().evaluate({ system: 'mail', method: 'POST', path: '/send', fields: { to: 'nisha@kairanaturals.example', subject: 'x', body: 'y' } }).effect).toBe('allow');
    expect(gate().evaluate({ system: 'mail', method: 'POST', path: '/drafts', fields: { to: 'vikram@arihantstores.example' } }).effect).toBe('allow');
  });
  it('checks purchase order value as quantity times unit price', () => {
    const po = (q: string, p: string) => ({ system: 'books', method: 'POST', path: '/purchase-orders', fields: { supplier_id: 'S-1001', item: 'box', quantity: q, unit_price: p } });
    expect(gate().evaluate(po('10000', '4.20')).effect).toBe('allow');
    expect(gate().evaluate(po('20000', '4.20')).effect).toBe('require_approval');
  });
  it('fingerprints ignore formatting differences in amounts', () => {
    const r = rules.find((x) => x.id === 'bills-over-50k') as PolicyRule;
    expect(fingerprint(r, bill('118000').fields)).toBe(fingerprint(r, bill('1,18,000.00').fields));
  });
});
