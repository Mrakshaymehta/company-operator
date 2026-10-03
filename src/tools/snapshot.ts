// Runs inside the page. Numbers every visible link, button and field so the model can act by number,
// and returns the page's main text. Kept as a string so the bundler cannot rewrite it.
export const SNAPSHOT_JS = String.raw`(() => {
  const MAX = 160;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const label = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return clean(aria);
    if (el.labels && el.labels.length) return clean([...el.labels].map((l) => l.innerText).join(' '));
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);
    return clean(el.innerText || el.textContent || el.getAttribute('name') || '');
  };
  document.querySelectorAll('[data-op-ref]').forEach((e) => e.removeAttribute('data-op-ref'));
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [contenteditable="true"]';
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
    if (n >= MAX) break;
    n += 1;
    el.setAttribute('data-op-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const t = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : tag === 'button' ? 'button'
      : ['submit', 'button', 'reset'].includes(t) ? 'button' : ['checkbox', 'radio', 'date', 'password', 'email', 'number'].includes(t) ? t : 'textbox');
    const item = { ref: n, role, name: label(el).slice(0, 160) };
    if (tag === 'a') item.href = el.getAttribute('href');
    if (tag === 'input' || tag === 'textarea') item.value = t === 'password' ? (el.value ? '(hidden)' : '') : String(el.value || '').slice(0, 300);
    if (t === 'checkbox' || t === 'radio') item.checked = el.checked;
    if (tag === 'select') { item.value = clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''); item.options = [...el.options].map((o) => clean(o.text)).slice(0, 40); }
    if (el.disabled) item.disabled = true;
    if (el.getAttribute('formaction')) item.formaction = el.getAttribute('formaction');
    items.push(item);
  }
  const main = document.querySelector('main') || document.body;
  const text = String(main ? main.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  return { url: location.href, title: document.title, text, items };
})()`;

export interface SnapItem { ref: number; role: string; name: string; href?: string; value?: string; checked?: boolean; options?: string[]; disabled?: boolean; formaction?: string }
export interface Snapshot { url: string; title: string; text: string; items: SnapItem[] }

export function formatSnapshot(s: Snapshot, systemName?: string, maxText = 6000): string {
  const text = s.text.length > maxText ? s.text.slice(0, maxText) + `\n… (${s.text.length - maxText} more characters not shown)` : s.text;
  const q = (v: string) => JSON.stringify(v);
  const lines = s.items.map((i) => {
    let line = `[${i.ref}] ${i.role} ${q(i.name)}`;
    if (i.value !== undefined && i.role !== 'button') line += ` value=${q(i.value)}`;
    if (i.options) line += ` options: ${i.options.map(q).join(' | ')}`;
    if (i.checked !== undefined) line += i.checked ? ' (checked)' : ' (not checked)';
    if (i.href) line += ` → ${i.href}`;
    if (i.formaction) line += ` (submits to ${i.formaction})`;
    if (i.disabled) line += ' (disabled)';
    return line;
  });
  return `Page: ${s.title}\nURL: ${s.url}${systemName ? ` (${systemName})` : ''}\n--- Page text ---\n${text || '(empty)'}\n--- Links, buttons and fields (act on them by number) ---\n${lines.join('\n') || '(none)'}`;
}
