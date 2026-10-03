// Renders invoice and credit-note PDFs with pdfkit. Two layouts so the operator meets more than one format.
import PDFDocument from 'pdfkit';
import { getDB, docTotals, fmtAmount, type InvoiceDoc, type Supplier } from './store.js';

type Doc = InstanceType<typeof PDFDocument>;

export function renderDocPdf(doc: InvoiceDoc): Promise<Buffer> {
  const db = getDB();
  const sup = db.suppliers.find((s) => s.id === doc.supplierId);
  if (!sup) throw new Error(`Unknown supplier ${doc.supplierId}`);
  const title = `${doc.kind === 'invoice' ? 'Invoice' : 'Credit note'} ${doc.number}`;
  const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title, Author: sup.name } });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    if (doc.layout === 'classic') classic(pdf, doc, sup); else modern(pdf, doc, sup);
    pdf.end();
  });
}

const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('-');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

function billTo(pdf: Doc, x: number, y: number) {
  const c = getDB().company;
  pdf.font('Helvetica-Bold').fontSize(9).fillColor('#555').text('BILL TO', x, y);
  pdf.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(c.name, x, y + 13);
  pdf.font('Helvetica').fontSize(9).text(c.address, x, y + 27, { width: 240 });
  pdf.text(`GSTIN: ${c.gstin}`, x, y + 52);
}

function table(pdf: Doc, doc: InvoiceDoc, top: number, rateLabel: string) {
  const cols = [
    { k: '#', x: 48, w: 20, a: 'left' as const },
    { k: 'Description', x: 70, w: 230, a: 'left' as const },
    { k: 'HSN/SAC', x: 302, w: 52, a: 'left' as const },
    { k: 'Qty', x: 356, w: 52, a: 'right' as const },
    { k: rateLabel, x: 410, w: 62, a: 'right' as const },
    { k: 'Amount (INR)', x: 474, w: 74, a: 'right' as const },
  ];
  pdf.rect(48, top, 500, 18).fill('#EEEEEE').fillColor('#000');
  pdf.font('Helvetica-Bold').fontSize(8.5);
  cols.forEach((c) => pdf.text(c.k, c.x, top + 5, { width: c.w, align: c.a }));
  let y = top + 24;
  pdf.font('Helvetica').fontSize(9);
  doc.lines.forEach((l, i) => {
    const vals = [String(i + 1), l.desc, l.hsn, l.qty.toLocaleString('en-IN'), fmtAmount(l.rate), fmtAmount(l.qty * l.rate)];
    cols.forEach((c, j) => pdf.text(vals[j], c.x, y, { width: c.w, align: c.a }));
    y += 22;
  });
  pdf.moveTo(48, y).lineTo(548, y).strokeColor('#CCCCCC').stroke();
  return y + 8;
}

function totals(pdf: Doc, doc: InvoiceDoc, y: number) {
  const t = docTotals(doc);
  const rows: [string, number][] = [['Taxable value', t.taxable]];
  if (doc.tax === 'intra') { rows.push(['CGST @ 9%', t.cgst], ['SGST @ 9%', t.sgst]); } else { rows.push(['IGST @ 18%', t.igst]); }
  pdf.font('Helvetica').fontSize(9.5);
  for (const [k, v] of rows) { pdf.text(k, 330, y, { width: 140, align: 'right' }); pdf.text(fmtAmount(v), 474, y, { width: 74, align: 'right' }); y += 16; }
  pdf.moveTo(330, y).lineTo(548, y).strokeColor('#000').stroke();
  y += 6;
  pdf.font('Helvetica-Bold').fontSize(11);
  pdf.text(doc.kind === 'invoice' ? 'TOTAL (INR)' : 'CREDIT TOTAL (INR)', 300, y, { width: 170, align: 'right' });
  pdf.text(fmtAmount(t.total), 464, y, { width: 84, align: 'right' });
  y += 24;
  pdf.font('Helvetica').fontSize(9).text(`Amount in words: Rupees ${indianWords(t.total)} Only`, 48, y, { width: 500 });
  return y + 22;
}

function classic(pdf: Doc, doc: InvoiceDoc, sup: Supplier) {
  pdf.font('Helvetica-Bold').fontSize(16).text(sup.name.toUpperCase(), 48, 48);
  pdf.font('Helvetica').fontSize(9).fillColor('#444').text(sup.address, 48, 70)
    .text(`GSTIN: ${sup.gstin}   |   ${sup.email}   |   Ph: ${sup.phone}`, 48, 83);
  pdf.moveTo(48, 100).lineTo(548, 100).strokeColor('#000').lineWidth(1.5).stroke().lineWidth(1);
  pdf.fillColor('#000').font('Helvetica-Bold').fontSize(14).text(doc.kind === 'invoice' ? 'TAX INVOICE' : 'CREDIT NOTE', 48, 112, { width: 500, align: 'right' });
  pdf.font('Helvetica').fontSize(10);
  pdf.text(`${doc.kind === 'invoice' ? 'Invoice No' : 'Credit Note No'}: ${doc.number}`, 48, 140);
  pdf.text(`Date: ${ddmmyyyy(doc.date)}`, 48, 155);
  if (doc.orderRef) pdf.text(`Your Order Ref: ${doc.orderRef}`, 48, 170);
  if (doc.againstInvoice) pdf.text(`Against Invoice: ${doc.againstInvoice}`, 48, 170);
  pdf.text('Place of Supply: Rajasthan (08)', 48, 185);
  billTo(pdf, 330, 140);
  const y = table(pdf, doc, 222, 'Rate (INR)');
  const y2 = totals(pdf, doc, y + 4);
  pdf.font('Helvetica').fontSize(9.5).text(doc.paymentText, 48, y2);
  pdf.fontSize(8).fillColor('#666').text('This is a computer-generated document and does not require a signature.', 48, 770, { width: 500, align: 'center' });
}

function modern(pdf: Doc, doc: InvoiceDoc, sup: Supplier) {
  const t = docTotals(doc);
  pdf.font('Helvetica-Bold').fontSize(26).fillColor('#1F3A5F').text(doc.kind === 'invoice' ? 'INVOICE' : 'CREDIT NOTE', 48, 48);
  pdf.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(sup.name, 300, 50, { width: 248, align: 'right' });
  pdf.font('Helvetica').fontSize(8.5).fillColor('#444').text(sup.address, 300, 65, { width: 248, align: 'right' })
    .text(`GSTIN ${sup.gstin}`, 300, 90, { width: 248, align: 'right' }).text(sup.email, 300, 102, { width: 248, align: 'right' });
  const boxes: [string, string][] = [
    ['Invoice number', doc.number],
    ['Invoice date', longDate(doc.date)],
    ['Due date', doc.dueDate ? longDate(doc.dueDate) : 'On receipt'],
    ['Amount due', `INR ${fmtAmount(t.total)}`],
  ];
  boxes.forEach(([k, v], i) => {
    const x = 48 + i * 126;
    pdf.rect(x, 130, 120, 44).strokeColor('#C9D3E0').stroke();
    pdf.font('Helvetica').fontSize(8).fillColor('#555').text(k.toUpperCase(), x + 8, 138, { width: 104 });
    pdf.font('Helvetica-Bold').fontSize(10.5).fillColor('#000').text(v, x + 8, 153, { width: 104 });
  });
  billTo(pdf, 48, 192);
  const y = table(pdf, doc, 270, 'Unit price');
  const y2 = totals(pdf, doc, y + 4);
  pdf.font('Helvetica').fontSize(9.5).fillColor('#000').text(doc.paymentText, 48, y2);
  pdf.text(`Bank: ${sup.bank.bank} | A/C ${sup.bank.accountNo} | IFSC ${sup.bank.ifsc}`, 48, y2 + 15);
  pdf.fontSize(8).fillColor('#666').text('Thank you for your business.', 48, 770, { width: 500, align: 'center' });
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const three = (n: number) => { const h = Math.floor(n / 100), r = n % 100; return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? two(r) : ''); };
export function indianWords(amount: number): string {
  let n = Math.floor(amount);
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(two(crore) + ' Crore');
  if (lakh) parts.push(two(lakh) + ' Lakh');
  if (thousand) parts.push(two(thousand) + ' Thousand');
  if (n) parts.push(three(n));
  const paise = Math.round((amount - Math.floor(amount)) * 100);
  return parts.join(' ') + (paise ? ` and ${two(paise)} Paise` : '');
}
