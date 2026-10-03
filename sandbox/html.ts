// Server-rendered HTML for the sandbox apps. Plain forms and links with real labels, like typical business software.
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const base = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d232b;background:var(--bg)}
a{color:var(--link)}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e3e6ea;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b6470;background:#f6f7f9}
label{display:block;font-weight:600;font-size:14px;margin-bottom:4px}input,select,textarea{font:inherit;padding:8px 10px;border:1px solid #b9c0c9;border-radius:4px;width:100%;background:#fff}
.field{margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 16px}
.btn{display:inline-block;padding:8px 16px;border-radius:4px;border:1px solid #9aa3ad;background:#fff;color:#1d232b;text-decoration:none;cursor:pointer;font:inherit}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}.flash{padding:10px 14px;border-radius:4px;margin-bottom:16px;background:#e6f4ea;border:1px solid #9bd0a8}
.error{padding:10px 14px;border-radius:4px;margin-bottom:16px;background:#fdecea;border:1px solid #f1a9a0;color:#8a1c12}
.muted{color:#5b6470}.card{background:#fff;border:1px solid #e3e6ea;border-radius:6px;padding:18px;margin-bottom:16px}
dl{display:grid;grid-template-columns:200px 1fr;gap:6px 16px;margin:0}dt{color:#5b6470}dd{margin:0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}`;

export function layout(opts: { app: 'mail' | 'books'; title: string; user?: string; nav?: string; body: string }) {
  const theme = opts.app === 'mail'
    ? '--bg:#f3f5f9;--link:#2f55c4;--accent:#2f55c4;--head:#22324b'
    : '--bg:#f8f3ed;--link:#8a3f12;--accent:#a84e17;--head:#4a3426';
  const appName = opts.app === 'mail' ? 'Kaira Mail' : 'Kaira Books';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(opts.title)} · ${appName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${theme}}${base}
header{background:var(--head);color:#fff;display:flex;gap:18px;align-items:center;padding:0 20px;min-height:52px;flex-wrap:wrap}
header .logo{font-weight:700;font-size:18px}header nav{display:flex;gap:4px;flex:1;flex-wrap:wrap}header nav a{color:#fff;opacity:.85;text-decoration:none;padding:14px 10px}
header nav a.on{opacity:1;box-shadow:inset 0 -3px 0 #f0b27a}header .user{font-size:13px;opacity:.9}header form{margin:0}header button{background:transparent;border:1px solid rgba(255,255,255,.5);color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer}
main{max-width:1100px;margin:0 auto;padding:22px 20px}h1{font-size:24px;margin:0 0 16px}</style></head><body>
<header><span class="logo">${appName}</span>${opts.nav ? `<nav aria-label="Main">${opts.nav}</nav>` : ''}${opts.user ? `<span class="user">${esc(opts.user)}</span><form method="post" action="/logout"><button type="submit">Sign out</button></form>` : ''}</header>
<main>${opts.body}</main></body></html>`;
}

export function loginPage(app: 'mail' | 'books', opts: { error?: string; expired?: boolean; next?: string }) {
  const appName = app === 'mail' ? 'Kaira Mail' : 'Kaira Books';
  return layout({ app, title: 'Sign in', body: `<div class="card" style="max-width:420px;margin:40px auto">
<h1>Sign in to ${appName}</h1>
${opts.expired ? '<div class="error" role="alert">Your session expired. Please sign in again.</div>' : ''}
${opts.error ? `<div class="error" role="alert">${esc(opts.error)}</div>` : ''}
<form method="post" action="/login"><input type="hidden" name="next" value="${esc(opts.next ?? '/')}">
<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
<button class="btn btn-primary" type="submit">Sign in</button></form></div>` });
}

export function serverErrorPage(app: 'mail' | 'books') {
  return layout({ app, title: 'Internal Server Error', body: `<h1>Internal Server Error</h1>
<p>Something went wrong while processing your request. Please try again later.</p><p class="muted">Error reference: ${Math.random().toString(36).slice(2, 10).toUpperCase()}</p>` });
}

export const flashBox = (msg?: string) => (msg ? `<div class="flash" role="status">${esc(msg)}</div>` : '');
export const errorBox = (msgs: string[]) => (msgs.length ? `<div class="error" role="alert">${msgs.map(esc).join('<br>')}</div>` : '');
