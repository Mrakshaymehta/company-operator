// In-memory database for the Kaira Naturals sandbox. Reset to seed data on demand.
import { seed } from './seed.js';

export type ISODate = string; // YYYY-MM-DD

export interface Bank { accountName: string; accountNo: string; ifsc: string; bank: string }
export interface Note { at: string; by: string; text: string }
export interface Supplier {
  id: string; name: string; contactName: string; email: string; phone: string;
  address: string; gstin: string; termsDays: number; bank: Bank;
}
export interface Customer {
  id: string; name: string; contactName: string; email: string; phone: string;
  billingAddress: string; deliveryAddress: string; gstin: string; accountManager: string; notes: Note[];
}
export interface Bill {
  id: string; supplierId: string; invoiceNo: string; invoiceDate: ISODate; dueDate: ISODate;
  amount: number; category: string; notes: string; createdAt: string; createdBy: string;
}
export interface PurchaseOrder {
  id: string; supplierId: string; item: string; quantity: number; unitPrice: number; advancePct: number;
  deliveryDays: number; validUntil: ISODate | ''; total: number; notes: string; createdAt: string; createdBy: string;
}
export interface DocLine { desc: string; hsn: string; qty: number; rate: number }
export interface InvoiceDoc {
  id: string; kind: 'invoice' | 'credit_note'; supplierId: string; number: string; date: ISODate;
  dueDate?: ISODate; paymentText: string; orderRef?: string; againstInvoice?: string;
  lines: DocLine[]; tax: 'intra' | 'inter'; layout: 'classic' | 'modern';
}
export interface Attachment { filename: string; docId: string; sizeKb: number }
export interface Email {
  id: string; folder: 'inbox' | 'drafts' | 'sent'; fromName: string; fromEmail: string; to: string[];
  subject: string; date: string; body: string; attachments: Attachment[]; read: boolean; inReplyTo?: string;
}
export interface AuditEntry { at: string; app: 'mail' | 'books'; user: string; action: string; detail: Record<string, unknown> }
export interface DB {
  company: { name: string; domain: string; address: string; gstin: string };
  suppliers: Supplier[]; customers: Customer[]; bills: Bill[]; purchaseOrders: PurchaseOrder[];
  emails: Email[]; docs: Record<string, InvoiceDoc>; categories: string[];
  counters: { bill: number; po: number; email: number };
  audit: AuditEntry[];
}

let db: DB = seed();
export const getDB = (): DB => db;
export function resetDB(): DB { db = seed(); return db; }

export function audit(app: AuditEntry['app'], user: string, action: string, detail: Record<string, unknown>) {
  db.audit.push({ at: new Date().toISOString(), app, user, action, detail });
}

export function nextId(kind: 'bill' | 'po' | 'email'): string {
  db.counters[kind] += 1;
  const n = db.counters[kind];
  if (kind === 'bill') return `BILL-${String(n).padStart(4, '0')}`;
  if (kind === 'po') return `PO-${String(n).padStart(4, '0')}`;
  return `m${String(n).padStart(2, '0')}`;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtAmount = (n: number) => inr.format(n);
export const fmtINR = (n: number) => '₹' + inr.format(n);

export function docTotals(doc: InvoiceDoc) {
  const taxable = round2(doc.lines.reduce((s, l) => s + l.qty * l.rate, 0));
  const tax = round2(taxable * 0.18);
  return doc.tax === 'intra'
    ? { taxable, cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0, total: round2(taxable + tax) }
    : { taxable, cgst: 0, sgst: 0, igst: tax, total: round2(taxable + tax) };
}
export const round2 = (n: number) => Math.round(n * 100) / 100;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  return `${fmtDate(iso)}, ${time}`;
}
