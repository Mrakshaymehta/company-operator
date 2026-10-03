import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSandbox } from '../sandbox/server.js';

const ports = { books: 5101, mail: 5102, admin: 5199 };
let sb: Awaited<ReturnType<typeof startSandbox>>;
beforeAll(async () => { sb = await startSandbox(ports); });
afterAll(async () => { await sb.close(); });

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function login(app: 'books' | 'mail') {
  const creds = app === 'books' ? { email: 'ops.agent@kairanaturals.example', password: 'kaira-books-2026' } : { email: 'accounts@kairanaturals.example', password: 'kaira-mail-2026' };
  const r = await fetch(`http://localhost:${ports[app]}/login`, { method: 'POST', body: form(creds), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}
const post = (url: string, cookie: string, body: Record<string, string>) => fetch(url, { method: 'POST', body: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, redirect: 'manual' });
const admin = (p: string, body?: unknown) => fetch(`http://localhost:${ports.admin}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then((r) => r.json());
const bill = { supplier_id: 'S-1001', invoice_no: 'RPI/26-27/0468', invoice_date: '2026-09-30', due_date: '2026-11-14', amount: '46,020.00', category: 'Packaging' };

describe('Kaira Naturals sandbox', () => {
  it('requires sign-in', async () => {
    const r = await fetch(`http://localhost:${ports.books}/bills`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/login/);
  });
  it('creates a bill and refuses a duplicate', async () => {
    await admin('/reset', {});
    const cookie = await login('books');
    expect((await post(`http://localhost:${ports.books}/bills`, cookie, bill)).status).toBe(302);
    const dup = await post(`http://localhost:${ports.books}/bills`, cookie, bill);
    expect(dup.status).toBe(409);
    expect(await dup.text()).toMatch(/already exists/);
  });
  it('serves invoice PDFs as downloads', async () => {
    const cookie = await login('mail');
    const r = await fetch(`http://localhost:${ports.mail}/m/m11/attachments/0`, { headers: { cookie } });
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/attachment/);
  });
  it('fault: server error after the save still stores the record', async () => {
    await admin('/reset', {});
    await admin('/faults', { failAfterSave: ['books:bills'] });
    const cookie = await login('books');
    expect((await post(`http://localhost:${ports.books}/bills`, cookie, bill)).status).toBe(500);
    const state = await admin('/state');
    expect(state.bills.filter((b: { invoiceNo: string }) => b.invoiceNo === 'RPI/26-27/0468')).toHaveLength(1);
  });
  it('redesigned screen: same data and URLs, new wording', async () => {
    await admin('/reset', {});
    await admin('/faults', { uiVariant: { books: 'v2' } });
    const cookie = await login('books');
    const html = await (await fetch(`http://localhost:${ports.books}/bills/new`, { headers: { cookie } })).text();
    expect(html).toMatch(/Record a payable/);
    expect(html).toMatch(/Vendor invoice #/);
    expect(html).not.toMatch(/Supplier invoice no\./);
    await admin('/reset', {});
  });
  it('fault: logs the user out after N more requests', async () => {
    await admin('/reset', {});
    const cookie = await login('books');
    await admin('/faults', { expireSessionAfter: { books: 1 } });
    expect((await fetch(`http://localhost:${ports.books}/bills`, { headers: { cookie }, redirect: 'manual' })).status).toBe(200);
    const r = await fetch(`http://localhost:${ports.books}/bills`, { headers: { cookie }, redirect: 'manual' });
    expect(r.headers.get('location')).toMatch(/expired=1/);
  });
});
