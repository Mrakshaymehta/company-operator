// The operator's browser. Real Chromium via Playwright. Every outgoing request passes through the policy gate,
// logins are filled from the vault, downloads are saved to the run folder, and each action ends with a fresh page read.
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { z } from 'zod';
import type { SystemConfig } from '../config.js';
import type { Decision, PolicyGate } from '../runtime/policy.js';
import type { Role, ErrorKind } from '../runtime/types.js';
import type { RunStore } from '../runtime/events.js';
import { SNAPSHOT_JS, formatSnapshot, type Snapshot } from './snapshot.js';
import { fail, type Tool, type ToolContext, type ToolResult } from './types.js';

let shared: Promise<Browser> | null = null;
export function getBrowser(headed: boolean, slowMo = 0) {
  if (!shared) shared = chromium.launch({ headless: !headed, slowMo });
  return shared;
}
export async function closeBrowser() { if (shared) { const b = await shared; shared = null; await b.close(); } }

export interface BrowserOptions {
  role: Role; store: RunStore; systems: SystemConfig[]; vault: Record<string, { username: string; password: string }>;
  gate: PolicyGate; headed: boolean; slowMo?: number;
  /** Called for every change (non-GET request, other than sign-in) that passed the policy gate and was sent. */
  onWrite?: (w: { system: string; method: string; path: string; fields: Record<string, string>; approvalId?: string }) => void;
}

function parseForm(body: string | null, contentType = ''): Record<string, string> {
  if (!body) return {};
  if (contentType.includes('application/json')) { try { return Object.fromEntries(Object.entries(JSON.parse(body)).map(([k, v]) => [k, String(v)])); } catch { return {}; } }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  return out;
}

export class BrowserSession {
  private context?: BrowserContext;
  private page?: Page;
  private blocked: Decision[] = [];
  private notAllowed: string[] = [];
  private downloads: Promise<string>[] = [];
  private lastNav?: { status: number; url: string; method: string };
  last?: Snapshot;

  constructor(private o: BrowserOptions) {}

  private systemFor(url: string) {
    try { const origin = new URL(url).origin; return this.o.systems.find((s) => new URL(s.baseUrl).origin === origin); } catch { return undefined; }
  }

  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const browser = await getBrowser(this.o.headed, this.o.slowMo);
    this.context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
    await this.context.route('**/*', (route) => this.onRoute(route));
    this.page = await this.context.newPage();
    this.page.on('download', (d) => {
      const name = d.suggestedFilename().replace(/[^\w.\-]/g, '_');
      const dest = this.o.store.path('downloads', name);
      this.downloads.push(d.saveAs(dest).then(() => dest));
    });
    this.page.on('response', (r) => {
      const req = r.request();
      if (req.isNavigationRequest() && r.frame() === this.page?.mainFrame()) this.lastNav = { status: r.status(), url: r.url(), method: req.method() };
    });
    return this.page;
  }

  /** The policy checkpoint. Runs for every request the page makes. */
  private async onRoute(route: Route) {
    const req = route.request();
    const url = req.url();
    if (/^(data|blob|about):/.test(url)) return route.continue();
    const system = this.systemFor(url);
    if (!system) { this.notAllowed.push(url); return route.abort('blockedbyclient'); }
    const path = new URL(url).pathname;
    const fields = parseForm(req.postData(), req.headers()['content-type']);
    const decision = this.o.gate.evaluate({ system: system.id, method: req.method(), path, fields });
    if (decision.effect === 'allow') {
      if (!['GET', 'HEAD'].includes(req.method()) && path !== system.login.path) this.o.onWrite?.({ system: system.id, method: req.method(), path, fields, approvalId: decision.grant?.approvalId });
      return route.continue();
    }
    this.blocked.push(decision);
    // 204 No Content keeps the current page (and the filled form) in place, so the same form can be re-sent after approval.
    return route.fulfill({ status: 204, body: '' });
  }

  async close() { await this.context?.close().catch(() => undefined); this.page = undefined; this.context = undefined; }

  private async settle(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
  }

  async read(): Promise<Snapshot | undefined> {
    const page = await this.ensure();
    try { this.last = (await page.evaluate(SNAPSHOT_JS)) as Snapshot; } catch { this.last = undefined; }
    return this.last;
  }

  /** Wraps one browser action: clears signals, runs it, waits for the page, then reports everything that happened. */
  async act(ctx: ToolContext, describe: string, fn: (page: Page) => Promise<void>): Promise<ToolResult> {
    const page = await this.ensure();
    this.blocked = []; this.notAllowed = []; this.downloads = []; this.lastNav = undefined;
    let error: string | undefined; let errorKind: ErrorKind | undefined;
    try { await fn(page); } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/Download is starting/i.test(msg)) { /* a download, handled below */ }
      else if (/ERR_BLOCKED_BY_CLIENT/.test(msg) && this.notAllowed.length) { /* reported below */ }
      else if (/Timeout/i.test(msg)) { error = msg.split('\n')[0]; errorKind = 'timeout'; }
      else { error = msg.split('\n')[0]; errorKind = 'unknown'; }
    }
    await this.settle(page);
    await page.waitForTimeout(150);
    const files = await Promise.race([Promise.all(this.downloads), new Promise<string[]>((r) => setTimeout(() => r([]), 8000))]);
    return this.report(ctx, describe, page, { error, errorKind, files });
  }

  private async report(ctx: ToolContext, describe: string, page: Page, r: { error?: string; errorKind?: ErrorKind; files: string[] }): Promise<ToolResult> {
    const notices: string[] = [];
    let errorKind = r.errorKind;
    const data: Record<string, unknown> = {};
    if (r.error) notices.push(`ERROR: ${r.error}`);
    for (const d of this.blocked) {
      if (d.effect === 'require_approval') {
        errorKind = 'approval_required';
        data.approval = { ruleId: d.rule.id, description: d.rule.description, approver: d.rule.approver, fingerprint: d.fingerprint, fields: d.request.fields, show: d.rule.show };
        notices.push(`HELD FOR APPROVAL: this submission was not sent. Company rule "${d.rule.id}": ${d.rule.description} The runtime will ask a person now.`);
      } else if (d.effect === 'deny') {
        errorKind = 'policy_denied';
        data.denied = { ruleId: d.rule.id, reason: d.reason, fields: d.request.fields };
        notices.push(`BLOCKED BY COMPANY POLICY: this submission was not sent. Rule "${d.rule.id}": ${d.reason} Do not try to work around this rule.`);
      } else if (d.effect === 'read_only') {
        errorKind = 'policy_denied';
        notices.push(`BLOCKED: ${d.reason}`);
      }
    }
    if (this.notAllowed.length) {
      errorKind = errorKind ?? 'not_allowed';
      notices.push(`BLOCKED: ${this.notAllowed[0]} is not one of the company's systems. You can only use: ${this.o.systems.map((s) => `${s.name} (${s.baseUrl})`).join(', ')}.`);
    }
    if (this.lastNav && this.lastNav.status >= 500) {
      errorKind = errorKind ?? 'http_error';
      notices.push(`The server answered HTTP ${this.lastNav.status} (an error page).`);
      if (this.lastNav.method !== 'GET') notices.push('WARNING: that was a save (POST). The change may or may not have been stored. Check the current records before trying to save again, so nothing is entered twice.');
    }
    const files = r.files.map((f) => ctx.store.rel(f));
    if (files.length) notices.push(`Downloaded: ${files.join(', ')}. Read it with files_read.`);

    const snap = await this.read();
    const system = snap ? this.systemFor(snap.url) : undefined;
    if (snap && system && new URL(snap.url).pathname === system.login.path) {
      notices.push(`You are on the ${system.name} sign-in page: you are not signed in, or your session expired. Use browser_login with system "${system.id}". You will return to the page you were on.`);
    }
    let screenshot: string | undefined;
    try {
      const file = ctx.store.path('screenshots', `${ctx.role}-${String(ctx.step).padStart(2, '0')}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 55 });
      screenshot = ctx.store.rel(file);
    } catch { /* screenshots are best effort */ }
    const pageText = snap ? formatSnapshot(snap, system?.name) : '(The page could not be read.)';
    const okNow = !errorKind;
    const headline = notices.filter((n) => !n.startsWith('You are on the')).map((n) => n.split(': ')[0].split('. ')[0]);
    const summary = [...headline, describe, ...notices.filter((n) => n.startsWith('You are on the')).map((n) => n.split(': ')[0])].join(' · ').slice(0, 320);
    return { ok: okNow, errorKind, summary, observation: `Action: ${describe}\n${notices.join('\n')}${notices.length ? '\n' : ''}\n${pageText}`, screenshot, artifacts: files, data };
  }

  locator(page: Page, ref: number) { return page.locator(`[data-op-ref="${ref}"]`).first(); }
  item(ref: number) { return this.last?.items.find((i) => i.ref === ref); }
  async staleCheck(page: Page, ref: number): Promise<ToolResult | null> {
    if ((await page.locator(`[data-op-ref="${ref}"]`).count()) > 0) return null;
    const snap = await this.read();
    return fail('stale_ref', `Element [${ref}] is not on the page any more`, `Element [${ref}] does not exist on the current page. Here is the current page:\n${snap ? formatSnapshot(snap) : ''}`);
  }
  describeRef(ref: number) { const i = this.item(ref); return i ? `[${ref}] ${i.role} "${i.name.slice(0, 80)}"` : `[${ref}]`; }

  async login(ctx: ToolContext, systemId: string): Promise<ToolResult> {
    const sys = this.o.systems.find((s) => s.id === systemId);
    const cred = this.o.vault[systemId];
    if (!sys || !cred) return fail('invalid_args', `Unknown system "${systemId}"`, `Unknown system "${systemId}". Systems: ${this.o.systems.map((s) => s.id).join(', ')}.`);
    const page = await this.ensure();
    return this.act(ctx, `signed in to ${sys.name} with the stored credentials`, async (p) => {
      const onLogin = this.last && this.systemFor(this.last.url)?.id === sys.id && new URL(this.last.url).pathname === sys.login.path && new URL(p.url()).pathname === sys.login.path;
      if (!onLogin) await p.goto(new URL(sys.login.path, sys.baseUrl).href, { waitUntil: 'domcontentloaded' });
      await p.fill(`input[name="${sys.login.usernameField}"]`, cred.username);
      await p.fill(`input[name="${sys.login.passwordField}"]`, cred.password);
      await p.locator(`form:has(input[name="${sys.login.passwordField}"]) [type=submit]`).first().click();
      await p.waitForLoadState('domcontentloaded');
      void page;
    });
  }
}

const ref = z.number().int().positive().describe('The number shown in [brackets] next to the element on the current page');

export function browserTools(session: BrowserSession, opts: { readOnly: boolean; systems: SystemConfig[] }): Tool[] {
  const systemIds = opts.systems.map((s) => s.id) as [string, ...string[]];
  const tools: Tool[] = [
    {
      name: 'browser_open', risk: 'read',
      description: 'Open a page in one of the company systems by full URL. Returns the page text and its numbered links, buttons and fields.',
      schema: z.object({ url: z.string().describe('Full URL, for example http://localhost:4101/bills') }),
      run: (a: { url: string }, ctx) => session.act(ctx, `opened ${a.url}`, async (p) => { await p.goto(a.url, { waitUntil: 'domcontentloaded' }); }),
    },
    {
      name: 'browser_login', risk: 'read',
      description: 'Sign in to a company system. The runtime fills the username and password from the company vault; you never see them.',
      schema: z.object({ system: z.enum(systemIds) }),
      run: (a: { system: string }, ctx) => session.login(ctx, a.system),
    },
    {
      name: 'browser_click', risk: 'write',
      description: 'Click a link or button by its number. Clicking a submit button sends the form.',
      schema: z.object({ ref }),
      run: async (a: { ref: number }, ctx) => {
        const page = await session.ensure();
        return (await session.staleCheck(page, a.ref)) ?? session.act(ctx, `clicked ${session.describeRef(a.ref)}`, async (p) => { await session.locator(p, a.ref).click({ timeout: 8000 }); });
      },
    },
    {
      name: 'browser_type', risk: 'read',
      description: 'Replace the text in a field by its number. Set submit to true to press Enter afterwards (for search boxes).',
      schema: z.object({ ref, text: z.string(), submit: z.boolean().optional() }),
      run: async (a: { ref: number; text: string; submit?: boolean }, ctx) => {
        const page = await session.ensure();
        return (await session.staleCheck(page, a.ref)) ?? session.act(ctx, `typed ${JSON.stringify(a.text.slice(0, 60))} into ${session.describeRef(a.ref)}${a.submit ? ' and pressed Enter' : ''}`, async (p) => {
          const loc = session.locator(p, a.ref);
          await loc.fill(a.text, { timeout: 8000 });
          if (a.submit) await loc.press('Enter');
        });
      },
    },
    {
      name: 'browser_select', risk: 'read',
      description: 'Choose an option in a dropdown by its number. Give the visible option text (a close match is fine).',
      schema: z.object({ ref, option: z.string() }),
      run: async (a: { ref: number; option: string }, ctx) => {
        const page = await session.ensure();
        return (await session.staleCheck(page, a.ref)) ?? session.act(ctx, `chose ${JSON.stringify(a.option)} in ${session.describeRef(a.ref)}`, async (p) => { await selectBest(session.locator(p, a.ref), a.option); });
      },
    },
    {
      name: 'browser_fill_form', risk: 'write',
      description: 'Fill several fields at once (text boxes, dates as YYYY-MM-DD, dropdowns by option text, checkboxes as "true"/"false"). Optionally click a submit button afterwards with submit_ref.',
      schema: z.object({ fields: z.array(z.object({ ref, value: z.string() })).min(1), submit_ref: ref.optional() }),
      run: async (a: { fields: { ref: number; value: string }[]; submit_ref?: number }, ctx) => {
        const page = await session.ensure();
        for (const f of a.fields) { const stale = await session.staleCheck(page, f.ref); if (stale) return stale; }
        const what = a.fields.map((f) => `${session.describeRef(f.ref)}=${JSON.stringify(f.value.slice(0, 40))}`).join(', ');
        return session.act(ctx, `filled ${a.fields.length} field(s): ${what}${a.submit_ref ? `, then clicked ${session.describeRef(a.submit_ref)}` : ''}`, async (p) => {
          for (const f of a.fields) {
            const loc = session.locator(p, f.ref);
            const tag = await loc.evaluate((el) => `${el.tagName.toLowerCase()}:${(el as HTMLInputElement).type ?? ''}`);
            if (tag.startsWith('select')) await selectBest(loc, f.value);
            else if (tag.endsWith(':checkbox') || tag.endsWith(':radio')) await loc.setChecked(/^(true|yes|on|1)$/i.test(f.value));
            else await loc.fill(f.value, { timeout: 8000 });
          }
          if (a.submit_ref) await session.locator(p, a.submit_ref).click({ timeout: 8000 });
        });
      },
    },
    {
      name: 'browser_back', risk: 'read', description: 'Go back to the previous page.', schema: z.object({}),
      run: (_a, ctx) => session.act(ctx, 'went back', async (p) => { await p.goBack({ waitUntil: 'domcontentloaded' }); }),
    },
    {
      name: 'browser_read_page', risk: 'read', description: 'Read the current page again without doing anything.', schema: z.object({}),
      run: (_a, ctx) => session.act(ctx, 'read the current page', async () => undefined),
    },
  ];
  // The checker gets a browser that can look, search and navigate, but never change data.
  return opts.readOnly ? tools.filter((t) => t.name !== 'browser_fill_form') : tools;
}

async function selectBest(loc: ReturnType<Page['locator']>, wanted: string) {
  const options = await loc.evaluate((el) => [...(el as HTMLSelectElement).options].map((o) => ({ value: o.value, text: o.text.trim() })));
  const w = wanted.trim().toLowerCase();
  const hit = options.find((o) => o.text.toLowerCase() === w || o.value.toLowerCase() === w)
    ?? options.find((o) => o.text.toLowerCase().includes(w) && o.value !== '')
    ?? options.find((o) => w.includes(o.text.toLowerCase()) && o.value !== '');
  if (!hit) throw new Error(`No option matching "${wanted}". Options are: ${options.map((o) => o.text).join(' | ')}`);
  await loc.selectOption(hit.value);
}
