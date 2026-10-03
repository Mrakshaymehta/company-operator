// New emails that can "arrive" during a demo, to show the operator picking up work on its own.
import { getDB, nextId, type Email, type InvoiceDoc } from './store.js';

interface Delivery { label: string; doc: InvoiceDoc; email: Pick<Email, 'fromName' | 'fromEmail' | 'subject' | 'body' | 'attachments'> }

export const DELIVERIES: Record<string, Delivery> = {
  'greenleaf-invoice': {
    label: 'Greenleaf Botanicals sends invoice GB/1236 (₹27,140, no due date printed)',
    doc: {
      id: 'd-gb-1236', kind: 'invoice', supplierId: 'S-1004', number: 'GB/1236', date: '2026-10-03', paymentText: 'Payment: As per agreed credit terms.',
      tax: 'inter', layout: 'classic', lines: [{ desc: 'Cold-pressed rosehip oil, 5 L cans', hsn: '1515', qty: 10, rate: 2300 }],
    },
    email: { fromName: 'Sunita Rawat', fromEmail: 'orders@greenleafbotanicals.example', subject: 'Invoice GB/1236 for rosehip oil',
      body: 'Dear Kaira team,\n\nPlease find attached invoice GB/1236 for the 10 cans of rosehip oil dispatched today.\n\nWarm regards,\nSunita Rawat\nGreenleaf Botanicals', attachments: [{ filename: 'GB-1236.pdf', docId: 'd-gb-1236', sizeKb: 41 }] },
  },
  'pixel-invoice': {
    label: 'Pixel & Post Studio sends invoice PPS-0952 (₹17,700, due date printed)',
    doc: {
      id: 'd-pps-0952', kind: 'invoice', supplierId: 'S-1005', number: 'PPS-0952', date: '2026-10-02', dueDate: '2026-10-09', paymentText: 'Please pay within 7 days.',
      tax: 'inter', layout: 'modern', lines: [{ desc: 'Festive campaign creatives (12 posts and 4 reels)', hsn: '998361', qty: 1, rate: 15000 }],
    },
    email: { fromName: 'Arjun Rao', fromEmail: 'hello@pixelandpost.example', subject: 'Invoice PPS-0952 - festive creatives',
      body: 'Hi Priya,\n\nAttached is our invoice PPS-0952 for the festive campaign creatives.\n\nCheers,\nArjun\nPixel & Post Studio', attachments: [{ filename: 'PPS-0952.pdf', docId: 'd-pps-0952', sizeKb: 36 }] },
  },
};

export function listDeliveries() {
  const db = getDB();
  return Object.entries(DELIVERIES).map(([kind, d]) => ({ kind, label: d.label, delivered: !!db.docs[d.doc.id] }));
}

export function deliver(kind: string): { ok: boolean; message: string } {
  const d = DELIVERIES[kind];
  if (!d) return { ok: false, message: `Unknown delivery "${kind}"` };
  const db = getDB();
  if (db.docs[d.doc.id]) return { ok: false, message: 'Already delivered. Reset the company to deliver it again.' };
  db.docs[d.doc.id] = d.doc;
  db.emails.push({ ...d.email, id: nextId('email'), folder: 'inbox', to: ['accounts@kairanaturals.example'], date: new Date().toISOString(), read: false });
  return { ok: true, message: `New email in Kaira Mail: ${d.email.subject}` };
}
