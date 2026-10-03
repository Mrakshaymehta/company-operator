// Kaira Mail: the shared accounts inbox. Login, search, read, download attachments, reply, draft, send.
import express from 'express';
import { getDB, audit, nextId, fmtDate, fmtDateTime, type Email } from './store.js';
import { requireAuth, checkLogin, startSession, endSession, setFlash, takeFlash } from './sessions.js';
import { latency } from './faults.js';
import { esc, layout, loginPage, flashBox, errorBox } from './html.js';
import { renderDocPdf } from './pdf.js';

const ACC = 'accounts@kairanaturals.example';

export function mailApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(latency);

  app.get('/login', (req, res) => {
    res.send(loginPage('mail', { expired: req.query.expired === '1', next: String(req.query.next ?? '/') }));
  });
  app.post('/login', (req, res) => {
    const { email = '', password = '', next = '/' } = req.body ?? {};
    if (!checkLogin('mail', email, password)) return res.status(401).send(loginPage('mail', { error: 'Wrong email or password.', next }));
    startSession(res, 'mail', email.trim().toLowerCase());
    res.redirect(String(next).startsWith('/') ? next : '/');
  });
  app.post('/logout', (req, res) => { endSession(req, res, 'mail'); res.redirect('/login'); });

  app.use(requireAuth('mail'));

  const nav = (folder: string) => {
    const db = getDB();
    const count = (f: Email['folder']) => db.emails.filter((e) => e.folder === f).length;
    const link = (f: string, label: string, n: number) => `<a href="/?folder=${f}" class="${folder === f ? 'on' : ''}">${label} (${n})</a>`;
    return `${link('inbox', 'Inbox', count('inbox'))}${link('drafts', 'Drafts', count('drafts'))}${link('sent', 'Sent', count('sent'))}<a href="/compose">Compose</a>`;
  };
  const page = (res: express.Response, title: string, folder: string, body: string) =>
    res.send(layout({ app: 'mail', title, user: res.locals.user, nav: nav(folder), body: flashBox(takeFlash(res)) + body }));

  app.get('/', (req, res) => {
    const folder = (['inbox', 'drafts', 'sent'].includes(String(req.query.folder)) ? req.query.folder : 'inbox') as Email['folder'];
    const q = String(req.query.q ?? '').trim();
    const needle = q.toLowerCase();
    let list = getDB().emails.filter((e) => e.folder === folder);
    if (needle) {
      list = list.filter((e) => [e.subject, e.fromName, e.fromEmail, e.body, e.to.join(' '), ...e.attachments.map((a) => a.filename)]
        .join(' ').toLowerCase().includes(needle));
    }
    list = [...list].sort((a, b) => b.date.localeCompare(a.date));
    const rows = list.map((e) => {
      const who = folder === 'inbox' ? e.fromName : `To: ${e.to.join(', ')}`;
      const att = e.attachments.length ? ` · ${e.attachments.length} attachment${e.attachments.length > 1 ? 's' : ''}` : '';
      return `<tr${e.read ? '' : ' style="font-weight:600"'}><td><a href="/m/${e.id}">${esc(who)} · ${esc(e.subject)} · ${esc(fmtDate(e.date))}${att}</a></td></tr>`;
    }).join('');
    page(res, folder === 'inbox' ? 'Inbox' : folder[0].toUpperCase() + folder.slice(1), folder, `
<form method="get" action="/" class="row" role="search" style="margin-bottom:14px"><input type="hidden" name="folder" value="${folder}">
<label for="q" style="margin:0">Search mail</label><input id="q" name="q" value="${esc(q)}" style="max-width:360px"><button class="btn" type="submit">Search</button>
${q ? `<a href="/?folder=${folder}">Clear search</a>` : ''}</form>
<p class="muted">${list.length} message${list.length === 1 ? '' : 's'}${q ? ` matching "${esc(q)}"` : ''} in ${folder}</p>
<div class="card" style="padding:0"><table><tbody>${rows || '<tr><td class="muted">No messages.</td></tr>'}</tbody></table></div>`);
  });

  app.get('/m/:id', (req, res) => {
    const e = getDB().emails.find((m) => m.id === req.params.id);
    if (!e) return res.status(404).send(layout({ app: 'mail', title: 'Not found', user: res.locals.user, nav: nav('inbox'), body: '<h1>Message not found</h1>' }));
    e.read = true;
    const atts = e.attachments.map((a, i) => `<li><a href="/m/${e.id}/attachments/${i}">Download ${esc(a.filename)}</a> <span class="muted">(${a.sizeKb} KB, PDF)</span></li>`).join('');
    page(res, e.subject, e.folder, `<p><a href="/?folder=${e.folder}">Back to ${e.folder}</a></p>
<div class="card"><h1>${esc(e.subject)}</h1>
<dl><dt>From</dt><dd>${esc(e.fromName)} &lt;${esc(e.fromEmail)}&gt;</dd><dt>To</dt><dd>${esc(e.to.join(', '))}</dd><dt>Date</dt><dd>${esc(fmtDateTime(e.date))}</dd></dl>
<div style="white-space:pre-wrap;margin-top:18px">${esc(e.body)}</div>
${atts ? `<h2 style="font-size:16px;margin-top:20px">Attachments</h2><ul>${atts}</ul>` : '<p class="muted" style="margin-top:20px">No attachments.</p>'}
${e.folder === 'inbox' ? `<p style="margin-top:18px"><a class="btn" href="/compose?reply=${e.id}">Reply</a></p>` : ''}</div>`);
  });

  app.get('/m/:id/attachments/:n', async (req, res) => {
    const e = getDB().emails.find((m) => m.id === req.params.id);
    const a = e?.attachments[Number(req.params.n)];
    const doc = a ? getDB().docs[a.docId] : undefined;
    if (!a || !doc) return res.status(404).send('Attachment not found');
    const pdf = await renderDocPdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${a.filename}"`);
    res.send(pdf);
  });

  const composeForm = (v: { to?: string; subject?: string; body?: string; inReplyTo?: string }, errors: string[] = []) => `
<h1>${v.inReplyTo ? 'Reply' : 'New message'}</h1>${errorBox(errors)}
<form method="post" action="/send" class="card"><input type="hidden" name="in_reply_to" value="${esc(v.inReplyTo ?? '')}">
<div class="field"><label for="to">To</label><input id="to" name="to" value="${esc(v.to ?? '')}"></div>
<div class="field"><label for="subject">Subject</label><input id="subject" name="subject" value="${esc(v.subject ?? '')}"></div>
<div class="field"><label for="body">Message</label><textarea id="body" name="body" rows="12">${esc(v.body ?? '')}</textarea></div>
<div class="row"><button class="btn btn-primary" type="submit">Send</button><button class="btn" type="submit" formaction="/drafts">Save draft</button><a href="/">Cancel</a></div></form>`;

  app.get('/compose', (req, res) => {
    const orig = getDB().emails.find((m) => m.id === req.query.reply);
    const v = orig
      ? { to: orig.fromEmail, subject: orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`, inReplyTo: orig.id,
          body: `\n\nOn ${fmtDateTime(orig.date)}, ${orig.fromName} wrote:\n${orig.body.split('\n').map((l) => `> ${l}`).join('\n')}` }
      : {};
    page(res, 'Compose', '', composeForm(v));
  });

  const save = (folder: 'drafts' | 'sent') => (req: express.Request, res: express.Response) => {
    const { to = '', subject = '', body = '', in_reply_to = '' } = req.body ?? {};
    const recipients = String(to).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const errors: string[] = [];
    if (!recipients.length) errors.push('Add at least one recipient.');
    if (recipients.some((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) errors.push('One of the recipient addresses is not a valid email address.');
    if (!String(subject).trim()) errors.push('Add a subject.');
    if (errors.length) return res.status(422).send(layout({ app: 'mail', title: 'Compose', user: res.locals.user, nav: nav(''), body: composeForm({ to, subject, body, inReplyTo: in_reply_to }, errors) }));
    const email: Email = { id: nextId('email'), folder, fromName: 'Kaira Naturals Accounts', fromEmail: ACC, to: recipients, subject: String(subject).trim(),
      date: new Date().toISOString(), body: String(body), attachments: [], read: true, inReplyTo: in_reply_to || undefined };
    getDB().emails.push(email);
    audit('mail', res.locals.user, folder === 'sent' ? 'email.send' : 'email.draft', { id: email.id, to: recipients, subject: email.subject, inReplyTo: email.inReplyTo });
    setFlash(res, folder === 'sent' ? `Message sent to ${recipients.join(', ')}.` : 'Draft saved.');
    res.redirect(`/m/${email.id}`);
  };
  app.post('/send', save('sent'));
  app.post('/drafts', save('drafts'));
  return app;
}
