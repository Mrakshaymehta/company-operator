// Kaira Books: the accounts system of record. Bills, suppliers, customers, purchase orders.
import express from 'express';
import { getDB, audit, nextId, fmtINR, fmtDate, round2, type Bill, type PurchaseOrder } from './store.js';
import { requireAuth, checkLogin, startSession, endSession, setFlash, takeFlash } from './sessions.js';
import { latency, takeOneShot, getFaults } from './faults.js';
import { esc, layout, loginPage, flashBox, errorBox, serverErrorPage } from './html.js';

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const parseMoney = (s: string) => {
  const cleaned = String(s ?? '').replace(/₹|INR|Rs\.?|,|\s/gi, '');
  return /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : NaN;
};
const norm = (s: string) => String(s ?? '').trim().toLowerCase();

// Screen wording. "v2" is a redesign: same data and URLs, different words and field order, like a real software update.
const WORDS = {
  v1: { home: 'Dashboard', bills: 'Bills', suppliers: 'Suppliers', customers: 'Customers', pos: 'Purchase orders', bill: 'Bill', newBill: 'New bill', search: 'Search bills',
    supplier: 'Supplier', invoiceNo: 'Supplier invoice no.', invoiceDate: 'Invoice date', dueDate: 'Due date', amount: 'Amount (₹, including GST)', amountCol: 'Amount',
    category: 'Category', notes: 'Notes', save: 'Save bill', cancel: 'Cancel', saved: (id: string) => `Bill ${id} saved.`, terms: 'Payment terms', termsText: (d: number) => `${d} days from invoice date`,
    order: ['supplier_id', 'invoice_no', 'invoice_date', 'due_date', 'amount', 'category'] },
  v2: { home: 'Home', bills: 'Payables', suppliers: 'Vendors', customers: 'Clients', pos: 'POs', bill: 'Payable', newBill: 'Record a payable', search: 'Find a payable',
    supplier: 'Vendor', invoiceNo: 'Vendor invoice #', invoiceDate: 'Billed on', dueDate: 'Pay by', amount: 'Total payable (INR, incl. tax)', amountCol: 'Total',
    category: 'Expense type', notes: 'Memo', save: 'Record payable', cancel: 'Discard', saved: (id: string) => `Payable ${id} recorded.`, terms: 'Credit period', termsText: (d: number) => `Net ${d}`,
    order: ['amount', 'supplier_id', 'category', 'invoice_no', 'due_date', 'invoice_date'] },
};
const words = () => WORDS[getFaults().uiVariant.books === 'v2' ? 'v2' : 'v1'];

export function booksApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(latency);

  app.get('/login', (req, res) => res.send(loginPage('books', { expired: req.query.expired === '1', next: String(req.query.next ?? '/') })));
  app.post('/login', (req, res) => {
    const { email = '', password = '', next = '/' } = req.body ?? {};
    if (!checkLogin('books', email, password)) return res.status(401).send(loginPage('books', { error: 'Wrong email or password.', next }));
    startSession(res, 'books', email.trim().toLowerCase());
    res.redirect(String(next).startsWith('/') ? next : '/');
  });
  app.post('/logout', (req, res) => { endSession(req, res, 'books'); res.redirect('/login'); });

  app.use(requireAuth('books'));

  const nav = (on: string) => { const w = words(); return [['/', w.home], ['/bills', w.bills], ['/suppliers', w.suppliers], ['/customers', w.customers], ['/purchase-orders', w.pos]]
    .map(([href, label]) => `<a href="${href}" class="${on === href ? 'on' : ''}">${label}</a>`).join(''); };
  const page = (res: express.Response, title: string, on: string, body: string, status = 200) =>
    res.status(status).send(layout({ app: 'books', title, user: res.locals.user, nav: nav(on), body: flashBox(takeFlash(res)) + body }));
  const supplierName = (id: string) => getDB().suppliers.find((s) => s.id === id)?.name ?? id;
  const supplierOptions = (selected = '') => `<option value="">Select supplier</option>` +
    getDB().suppliers.map((s) => `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${esc(s.name)} (${s.id})</option>`).join('');
  const billRow = (b: Bill) => `<tr><td><a href="/bills/${b.id}">${b.id}</a></td><td>${esc(supplierName(b.supplierId))}</td><td>${esc(b.invoiceNo)}</td>
<td>${fmtDate(b.invoiceDate)}</td><td>${fmtDate(b.dueDate)}</td><td style="text-align:right">${fmtINR(b.amount)}</td><td>${esc(b.category)}</td></tr>`;
  const billTable = (bills: Bill[]) => { const w = words(); return `<div class="card" style="padding:0;overflow-x:auto"><table><thead><tr><th>${w.bill}</th><th>${w.supplier}</th><th>${w.invoiceNo}</th><th>${w.invoiceDate}</th><th>${w.dueDate}</th><th style="text-align:right">${w.amountCol}</th><th>${w.category}</th></tr></thead>
<tbody>${bills.map(billRow).join('') || '<tr><td colspan="7" class="muted">Nothing found.</td></tr>'}</tbody></table></div>`; };

  // Dashboard
  app.get('/', (_req, res) => {
    const db = getDB();
    const recent = [...db.bills].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
    page(res, 'Dashboard', '/', `<h1>Dashboard</h1>
<div class="grid"><div class="card"><div class="muted">Bills</div><div style="font-size:26px;font-weight:700">${db.bills.length}</div><a href="/bills/new">New bill</a></div>
<div class="card"><div class="muted">Suppliers</div><div style="font-size:26px;font-weight:700">${db.suppliers.length}</div><a href="/suppliers">View suppliers</a></div>
<div class="card"><div class="muted">Customers</div><div style="font-size:26px;font-weight:700">${db.customers.length}</div><a href="/customers">View customers</a></div>
<div class="card"><div class="muted">Purchase orders</div><div style="font-size:26px;font-weight:700">${db.purchaseOrders.length}</div><a href="/purchase-orders/new">New purchase order</a></div></div>
<h2 style="font-size:18px">Recently added bills</h2>${billTable(recent)}`);
  });

  // Bills
  app.get('/bills', (req, res) => {
    const q = norm(String(req.query.q ?? ''));
    let bills = [...getDB().bills].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
    if (q) bills = bills.filter((b) => [b.id, b.invoiceNo, supplierName(b.supplierId), b.supplierId, b.notes, b.category].some((f) => norm(f).includes(q)));
    const w = words();
    page(res, w.bills, '/bills', `<div class="row" style="justify-content:space-between"><h1>${w.bills}</h1><a class="btn btn-primary" href="/bills/new">${w.newBill}</a></div>
<form method="get" action="/bills" class="row" role="search" style="margin-bottom:12px"><label for="q" style="margin:0">${w.search}</label>
<input id="q" name="q" value="${esc(req.query.q ?? '')}" placeholder="Bill number, supplier or invoice number" style="max-width:380px"><button class="btn" type="submit">Search</button>
${q ? '<a href="/bills">Clear search</a>' : ''}</form>
<p class="muted">${bills.length} bill${bills.length === 1 ? '' : 's'}${q ? ` matching "${esc(req.query.q)}"` : ''}</p>${billTable(bills)}`);
  });

  const billForm = (v: Record<string, string> = {}, errors: string[] = []) => {
    const w = words();
    const fields: Record<string, string> = {
      supplier_id: `<div class="field"><label for="supplier_id">${w.supplier}</label><select id="supplier_id" name="supplier_id">${supplierOptions(v.supplier_id)}</select></div>`,
      invoice_no: `<div class="field"><label for="invoice_no">${w.invoiceNo}</label><input id="invoice_no" name="invoice_no" value="${esc(v.invoice_no)}"></div>`,
      invoice_date: `<div class="field"><label for="invoice_date">${w.invoiceDate}</label><input id="invoice_date" name="invoice_date" type="date" value="${esc(v.invoice_date)}"></div>`,
      due_date: `<div class="field"><label for="due_date">${w.dueDate}</label><input id="due_date" name="due_date" type="date" value="${esc(v.due_date)}"></div>`,
      amount: `<div class="field"><label for="amount">${w.amount}</label><input id="amount" name="amount" inputmode="decimal" value="${esc(v.amount)}"></div>`,
      category: `<div class="field"><label for="category">${w.category}</label><select id="category" name="category"><option value="">Select</option>
${getDB().categories.map((c) => `<option${c === v.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`,
    };
    return `<p><a href="/bills">${w.bills}</a> › ${w.newBill}</p><h1>${w.newBill}</h1>${errorBox(errors)}
<form method="post" action="/bills" class="card"><div class="grid">${w.order.map((k) => fields[k]).join('')}</div>
<div class="field"><label for="notes">${w.notes}</label><textarea id="notes" name="notes" rows="2">${esc(v.notes)}</textarea></div>
<div class="row"><button class="btn btn-primary" type="submit">${w.save}</button><a href="/bills">${w.cancel}</a></div></form>`;
  };

  app.get('/bills/new', (_req, res) => page(res, words().newBill, '/bills', billForm()));

  app.post('/bills', (req, res) => {
    const v = req.body ?? {};
    if (takeOneShot('failBeforeSave', 'books:bills')) return res.status(500).send(serverErrorPage('books'));
    const db = getDB();
    const errors: string[] = [];
    const supplier = db.suppliers.find((s) => s.id === v.supplier_id);
    if (!supplier) errors.push('Choose a supplier.');
    if (!String(v.invoice_no ?? '').trim()) errors.push('Enter the supplier invoice number.');
    if (!isDate(v.invoice_date)) errors.push('Enter the invoice date as YYYY-MM-DD.');
    if (!isDate(v.due_date)) errors.push('Enter the due date as YYYY-MM-DD.');
    if (isDate(v.invoice_date) && isDate(v.due_date) && v.due_date < v.invoice_date) errors.push('The due date cannot be before the invoice date.');
    const amount = parseMoney(v.amount);
    if (!(amount > 0)) errors.push('Enter the amount as a number, for example 46020.00.');
    if (!db.categories.includes(v.category)) errors.push('Choose a category.');
    if (errors.length) return page(res, 'New bill', '/bills', billForm(v, errors), 422);
    const dup = db.bills.find((b) => b.supplierId === supplier!.id && norm(b.invoiceNo) === norm(v.invoice_no));
    if (dup) return page(res, 'New bill', '/bills', billForm(v, [`A bill with supplier invoice no. ${v.invoice_no.trim()} already exists for ${supplier!.name} (${dup.id}).`]), 409);
    const bill: Bill = { id: nextId('bill'), supplierId: supplier!.id, invoiceNo: v.invoice_no.trim(), invoiceDate: v.invoice_date, dueDate: v.due_date,
      amount: round2(amount), category: v.category, notes: String(v.notes ?? '').trim(), createdAt: new Date().toISOString(), createdBy: res.locals.user };
    db.bills.push(bill);
    audit('books', res.locals.user, 'bill.create', { ...bill });
    if (takeOneShot('failAfterSave', 'books:bills')) return res.status(500).send(serverErrorPage('books'));
    setFlash(res, words().saved(bill.id));
    res.redirect(`/bills/${bill.id}`);
  });

  app.get('/bills/:id', (req, res) => {
    const b = getDB().bills.find((x) => x.id === req.params.id);
    if (!b) return page(res, 'Not found', '/bills', '<h1>Bill not found</h1>', 404);
    const w = words();
    page(res, b.id, '/bills', `<p><a href="/bills">${w.bills}</a> › ${b.id}</p><h1>${w.bill} ${b.id}</h1><div class="card"><dl>
<dt>${w.supplier}</dt><dd><a href="/suppliers/${b.supplierId}">${esc(supplierName(b.supplierId))}</a> (${b.supplierId})</dd>
<dt>${w.invoiceNo}</dt><dd>${esc(b.invoiceNo)}</dd><dt>${w.invoiceDate}</dt><dd>${fmtDate(b.invoiceDate)} (${b.invoiceDate})</dd>
<dt>${w.dueDate}</dt><dd>${fmtDate(b.dueDate)} (${b.dueDate})</dd><dt>${w.amountCol}</dt><dd>${fmtINR(b.amount)}</dd><dt>${w.category}</dt><dd>${esc(b.category)}</dd>
<dt>${w.notes}</dt><dd>${esc(b.notes) || '<span class="muted">None</span>'}</dd><dt>Added by</dt><dd>${esc(b.createdBy)}</dd></dl></div>
<form method="post" action="/bills/${b.id}/delete"><button class="btn" type="submit">Delete bill</button></form>`);
  });

  app.post('/bills/:id/delete', (req, res) => {
    const db = getDB();
    const b = db.bills.find((x) => x.id === req.params.id);
    if (b) { db.bills = db.bills.filter((x) => x.id !== b.id); audit('books', res.locals.user, 'bill.delete', { id: b.id }); setFlash(res, `Bill ${b.id} deleted.`); }
    res.redirect('/bills');
  });

  // Suppliers
  app.get('/suppliers', (_req, res) => {
    const rows = getDB().suppliers.map((s) => `<tr><td>${s.id}</td><td><a href="/suppliers/${s.id}">${esc(s.name)}</a></td><td>${esc(s.contactName)}</td><td>${esc(s.email)}</td><td>${s.termsDays} days</td></tr>`).join('');
    page(res, 'Suppliers', '/suppliers', `<h1>Suppliers</h1><div class="card" style="padding:0;overflow-x:auto"><table><thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Email</th><th>Payment terms</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  });
  app.get('/suppliers/:id', (req, res) => {
    const s = getDB().suppliers.find((x) => x.id === req.params.id);
    if (!s) return page(res, 'Not found', '/suppliers', '<h1>Supplier not found</h1>', 404);
    const bills = getDB().bills.filter((b) => b.supplierId === s.id).sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
    page(res, s.name, '/suppliers', `<p><a href="/suppliers">Suppliers</a> › ${s.id}</p><h1>${esc(s.name)}</h1><div class="card"><dl>
<dt>Supplier code</dt><dd>${s.id}</dd><dt>${words().terms}</dt><dd>${words().termsText(s.termsDays)}</dd><dt>Contact</dt><dd>${esc(s.contactName)}</dd>
<dt>Email</dt><dd>${esc(s.email)}</dd><dt>Phone</dt><dd>${esc(s.phone)}</dd><dt>Address</dt><dd>${esc(s.address)}</dd><dt>GSTIN</dt><dd>${esc(s.gstin)}</dd>
<dt>Bank account</dt><dd>${esc(s.bank.accountName)}, A/C ${esc(s.bank.accountNo)}, IFSC ${esc(s.bank.ifsc)}, ${esc(s.bank.bank)}</dd></dl>
<p class="row" style="margin-top:14px"><a class="btn" href="/suppliers/${s.id}/edit">Edit contact details</a><a class="btn" href="/suppliers/${s.id}/bank">Change bank details</a></p></div>
<h2 style="font-size:18px">Bills from this supplier</h2>${billTable(bills)}`);
  });
  app.get('/suppliers/:id/edit', (req, res) => {
    const s = getDB().suppliers.find((x) => x.id === req.params.id);
    if (!s) return page(res, 'Not found', '/suppliers', '<h1>Supplier not found</h1>', 404);
    page(res, `Edit ${s.name}`, '/suppliers', `<h1>Edit contact details: ${esc(s.name)}</h1><form method="post" action="/suppliers/${s.id}" class="card">
<div class="field"><label for="contact_name">Contact name</label><input id="contact_name" name="contact_name" value="${esc(s.contactName)}"></div>
<div class="field"><label for="email">Email</label><input id="email" name="email" value="${esc(s.email)}"></div>
<div class="field"><label for="phone">Phone</label><input id="phone" name="phone" value="${esc(s.phone)}"></div>
<button class="btn btn-primary" type="submit">Save contact details</button></form>`);
  });
  app.post('/suppliers/:id', (req, res) => {
    const s = getDB().suppliers.find((x) => x.id === req.params.id);
    if (!s) return page(res, 'Not found', '/suppliers', '<h1>Supplier not found</h1>', 404);
    const before = { contactName: s.contactName, email: s.email, phone: s.phone };
    s.contactName = String(req.body.contact_name ?? s.contactName).trim(); s.email = String(req.body.email ?? s.email).trim(); s.phone = String(req.body.phone ?? s.phone).trim();
    audit('books', res.locals.user, 'supplier.update', { id: s.id, before, after: { contactName: s.contactName, email: s.email, phone: s.phone } });
    setFlash(res, 'Supplier contact details saved.'); res.redirect(`/suppliers/${s.id}`);
  });
  app.get('/suppliers/:id/bank', (req, res) => {
    const s = getDB().suppliers.find((x) => x.id === req.params.id);
    if (!s) return page(res, 'Not found', '/suppliers', '<h1>Supplier not found</h1>', 404);
    page(res, `Bank details: ${s.name}`, '/suppliers', `<h1>Change bank details: ${esc(s.name)}</h1><form method="post" action="/suppliers/${s.id}/bank" class="card">
<div class="field"><label for="account_name">Account name</label><input id="account_name" name="account_name" value="${esc(s.bank.accountName)}"></div>
<div class="field"><label for="account_no">Account number</label><input id="account_no" name="account_no" value="${esc(s.bank.accountNo)}"></div>
<div class="field"><label for="ifsc">IFSC</label><input id="ifsc" name="ifsc" value="${esc(s.bank.ifsc)}"></div>
<div class="field"><label for="bank">Bank and branch</label><input id="bank" name="bank" value="${esc(s.bank.bank)}"></div>
<button class="btn btn-primary" type="submit">Save bank details</button></form>`);
  });
  app.post('/suppliers/:id/bank', (req, res) => {
    const s = getDB().suppliers.find((x) => x.id === req.params.id);
    if (!s) return page(res, 'Not found', '/suppliers', '<h1>Supplier not found</h1>', 404);
    const before = { ...s.bank };
    s.bank = { accountName: String(req.body.account_name ?? '').trim(), accountNo: String(req.body.account_no ?? '').trim(), ifsc: String(req.body.ifsc ?? '').trim(), bank: String(req.body.bank ?? '').trim() };
    audit('books', res.locals.user, 'supplier.bank_change', { id: s.id, before, after: s.bank });
    setFlash(res, 'Bank details saved.'); res.redirect(`/suppliers/${s.id}`);
  });

  // Customers
  app.get('/customers', (_req, res) => {
    const rows = getDB().customers.map((c) => `<tr><td>${c.id}</td><td><a href="/customers/${c.id}">${esc(c.name)}</a></td><td>${esc(c.contactName)}</td><td>${esc(c.email)}</td><td>${esc(c.accountManager)}</td></tr>`).join('');
    page(res, 'Customers', '/customers', `<h1>Customers</h1><div class="card" style="padding:0;overflow-x:auto"><table><thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Email</th><th>Account manager</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  });
  app.get('/customers/:id', (req, res) => {
    const c = getDB().customers.find((x) => x.id === req.params.id);
    if (!c) return page(res, 'Not found', '/customers', '<h1>Customer not found</h1>', 404);
    const notes = c.notes.map((n) => `<li>${esc(fmtDate(n.at))}, ${esc(n.by)}: ${esc(n.text)}</li>`).join('');
    page(res, c.name, '/customers', `<p><a href="/customers">Customers</a> › ${c.id}</p><h1>${esc(c.name)}</h1><div class="card"><dl>
<dt>Customer code</dt><dd>${c.id}</dd><dt>Contact</dt><dd>${esc(c.contactName)}</dd><dt>Email</dt><dd>${esc(c.email)}</dd><dt>Phone</dt><dd>${esc(c.phone)}</dd>
<dt>Billing address</dt><dd>${esc(c.billingAddress)}</dd><dt>Delivery address</dt><dd>${esc(c.deliveryAddress)}</dd><dt>GSTIN</dt><dd>${esc(c.gstin)}</dd>
<dt>Account manager</dt><dd>${esc(c.accountManager)}</dd></dl><p style="margin-top:14px"><a class="btn" href="/customers/${c.id}/edit">Edit customer</a></p></div>
<div class="card"><h2 style="font-size:16px;margin-top:0">Notes</h2>${notes ? `<ul>${notes}</ul>` : '<p class="muted">No notes yet.</p>'}</div>`);
  });
  app.get('/customers/:id/edit', (req, res) => {
    const c = getDB().customers.find((x) => x.id === req.params.id);
    if (!c) return page(res, 'Not found', '/customers', '<h1>Customer not found</h1>', 404);
    page(res, `Edit ${c.name}`, '/customers', `<h1>Edit customer: ${esc(c.name)}</h1><form method="post" action="/customers/${c.id}" class="card">
<div class="grid"><div class="field"><label for="contact_name">Contact name</label><input id="contact_name" name="contact_name" value="${esc(c.contactName)}"></div>
<div class="field"><label for="email">Email</label><input id="email" name="email" value="${esc(c.email)}"></div>
<div class="field"><label for="phone">Phone</label><input id="phone" name="phone" value="${esc(c.phone)}"></div></div>
<div class="field"><label for="billing_address">Billing address</label><textarea id="billing_address" name="billing_address" rows="2">${esc(c.billingAddress)}</textarea></div>
<div class="field"><label for="delivery_address">Delivery address</label><textarea id="delivery_address" name="delivery_address" rows="2">${esc(c.deliveryAddress)}</textarea></div>
<div class="field"><label for="note">Add a note (optional)</label><textarea id="note" name="note" rows="2" placeholder="What changed and why"></textarea></div>
<button class="btn btn-primary" type="submit">Save customer</button></form>`);
  });
  app.post('/customers/:id', (req, res) => {
    const c = getDB().customers.find((x) => x.id === req.params.id);
    if (!c) return page(res, 'Not found', '/customers', '<h1>Customer not found</h1>', 404);
    const fields = { contactName: 'contact_name', email: 'email', phone: 'phone', billingAddress: 'billing_address', deliveryAddress: 'delivery_address' } as const;
    const changes: Record<string, { from: string; to: string }> = {};
    for (const [key, name] of Object.entries(fields)) {
      const val = req.body[name];
      if (val === undefined) continue;
      const next = String(val).trim();
      if (next !== c[key as keyof typeof fields]) { changes[key] = { from: c[key as keyof typeof fields], to: next }; (c as unknown as Record<string, string>)[key] = next; }
    }
    const note = String(req.body.note ?? '').trim();
    if (note) c.notes.push({ at: new Date().toISOString(), by: res.locals.user, text: note });
    audit('books', res.locals.user, 'customer.update', { id: c.id, changes, note: note || undefined });
    setFlash(res, 'Customer saved.'); res.redirect(`/customers/${c.id}`);
  });

  // Purchase orders
  const poRow = (p: PurchaseOrder) => `<tr><td><a href="/purchase-orders/${p.id}">${p.id}</a></td><td>${esc(supplierName(p.supplierId))}</td><td>${esc(p.item)}</td>
<td style="text-align:right">${p.quantity.toLocaleString('en-IN')}</td><td style="text-align:right">${fmtINR(p.unitPrice)}</td><td style="text-align:right">${fmtINR(p.total)}</td></tr>`;
  app.get('/purchase-orders', (_req, res) => {
    const pos = [...getDB().purchaseOrders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    page(res, 'Purchase orders', '/purchase-orders', `<div class="row" style="justify-content:space-between"><h1>Purchase orders</h1><a class="btn btn-primary" href="/purchase-orders/new">New purchase order</a></div>
<div class="card" style="padding:0;overflow-x:auto"><table><thead><tr><th>PO</th><th>Supplier</th><th>Item</th><th style="text-align:right">Quantity</th><th style="text-align:right">Unit price</th><th style="text-align:right">Total</th></tr></thead><tbody>${pos.map(poRow).join('')}</tbody></table></div>`);
  });
  const poForm = (v: Record<string, string> = {}, errors: string[] = []) => `<p><a href="/purchase-orders">Purchase orders</a> › New</p><h1>New purchase order</h1>${errorBox(errors)}
<form method="post" action="/purchase-orders" class="card"><div class="grid">
<div class="field"><label for="supplier_id">Supplier</label><select id="supplier_id" name="supplier_id">${supplierOptions(v.supplier_id)}</select></div>
<div class="field"><label for="item">Item</label><input id="item" name="item" value="${esc(v.item)}"></div>
<div class="field"><label for="quantity">Quantity</label><input id="quantity" name="quantity" inputmode="numeric" value="${esc(v.quantity)}"></div>
<div class="field"><label for="unit_price">Unit price (₹, before GST)</label><input id="unit_price" name="unit_price" inputmode="decimal" value="${esc(v.unit_price)}"></div>
<div class="field"><label for="advance_pct">Advance (%)</label><input id="advance_pct" name="advance_pct" inputmode="numeric" value="${esc(v.advance_pct)}"></div>
<div class="field"><label for="delivery_days">Delivery (days from order)</label><input id="delivery_days" name="delivery_days" inputmode="numeric" value="${esc(v.delivery_days)}"></div>
<div class="field"><label for="valid_until">Price valid until</label><input id="valid_until" name="valid_until" type="date" value="${esc(v.valid_until)}"></div></div>
<div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes" rows="2">${esc(v.notes)}</textarea></div>
<div class="row"><button class="btn btn-primary" type="submit">Create purchase order</button><a href="/purchase-orders">Cancel</a></div></form>`;
  app.get('/purchase-orders/new', (_req, res) => page(res, 'New purchase order', '/purchase-orders', poForm()));
  app.post('/purchase-orders', (req, res) => {
    const v = req.body ?? {};
    const db = getDB();
    const errors: string[] = [];
    const supplier = db.suppliers.find((s) => s.id === v.supplier_id);
    if (!supplier) errors.push('Choose a supplier.');
    if (!String(v.item ?? '').trim()) errors.push('Describe the item.');
    const qty = Number(String(v.quantity ?? '').replace(/,/g, ''));
    if (!(Number.isInteger(qty) && qty > 0)) errors.push('Enter the quantity as a whole number.');
    const price = parseMoney(v.unit_price);
    if (!(price > 0)) errors.push('Enter the unit price as a number.');
    const adv = Number(v.advance_pct || 0);
    if (!(adv >= 0 && adv <= 100)) errors.push('Advance must be between 0 and 100.');
    const days = Number(v.delivery_days || 0);
    if (!(Number.isInteger(days) && days >= 0)) errors.push('Enter delivery days as a whole number.');
    if (v.valid_until && !isDate(v.valid_until)) errors.push('Enter the price validity date as YYYY-MM-DD.');
    if (errors.length) return page(res, 'New purchase order', '/purchase-orders', poForm(v, errors), 422);
    const po: PurchaseOrder = { id: nextId('po'), supplierId: supplier!.id, item: v.item.trim(), quantity: qty, unitPrice: price, advancePct: adv, deliveryDays: days,
      validUntil: v.valid_until || '', total: round2(qty * price), notes: String(v.notes ?? '').trim(), createdAt: new Date().toISOString(), createdBy: res.locals.user };
    db.purchaseOrders.push(po);
    audit('books', res.locals.user, 'po.create', { ...po });
    setFlash(res, `Purchase order ${po.id} created.`); res.redirect(`/purchase-orders/${po.id}`);
  });
  app.get('/purchase-orders/:id', (req, res) => {
    const p = getDB().purchaseOrders.find((x) => x.id === req.params.id);
    if (!p) return page(res, 'Not found', '/purchase-orders', '<h1>Purchase order not found</h1>', 404);
    page(res, p.id, '/purchase-orders', `<p><a href="/purchase-orders">Purchase orders</a> › ${p.id}</p><h1>Purchase order ${p.id}</h1><div class="card"><dl>
<dt>Supplier</dt><dd>${esc(supplierName(p.supplierId))} (${p.supplierId})</dd><dt>Item</dt><dd>${esc(p.item)}</dd><dt>Quantity</dt><dd>${p.quantity.toLocaleString('en-IN')}</dd>
<dt>Unit price</dt><dd>${fmtINR(p.unitPrice)} before GST</dd><dt>Total</dt><dd>${fmtINR(p.total)} before GST</dd><dt>Advance</dt><dd>${p.advancePct}%</dd>
<dt>Delivery</dt><dd>${p.deliveryDays} days from order</dd><dt>Price valid until</dt><dd>${p.validUntil ? fmtDate(p.validUntil) : '<span class="muted">Not set</span>'}</dd>
<dt>Notes</dt><dd>${esc(p.notes) || '<span class="muted">None</span>'}</dd><dt>Created by</dt><dd>${esc(p.createdBy)}</dd></dl></div>`);
  });

  return app;
}
