// Cookie sessions for the two sandbox apps. Separate cookie names because cookies ignore ports.
import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { shouldExpireSession, type AppName } from './faults.js';

interface Session { id: string; app: AppName; user: string; requests: number; flash?: string }
const sessions = new Map<string, Session>();

export const USERS: Record<AppName, { email: string; password: string }[]> = {
  mail: [{ email: 'accounts@kairanaturals.example', password: 'kaira-mail-2026' }],
  books: [{ email: 'ops.agent@kairanaturals.example', password: 'kaira-books-2026' }],
};

const cookieName = (app: AppName) => `${app}_sid`;

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

export function getSession(req: Request, app: AppName): Session | undefined {
  const id = parseCookies(req)[cookieName(app)];
  return id ? sessions.get(id) : undefined;
}

export function checkLogin(app: AppName, email: string, password: string): boolean {
  return USERS[app].some((u) => u.email === email.trim().toLowerCase() && u.password === password);
}

export function startSession(res: Response, app: AppName, user: string): Session {
  const s: Session = { id: randomBytes(16).toString('hex'), app, user, requests: 0 };
  sessions.set(s.id, s);
  res.setHeader('Set-Cookie', `${cookieName(app)}=${s.id}; Path=/; HttpOnly; SameSite=Lax`);
  return s;
}

export function endSession(req: Request, res: Response, app: AppName) {
  const s = getSession(req, app);
  if (s) sessions.delete(s.id);
  res.setHeader('Set-Cookie', `${cookieName(app)}=; Path=/; Max-Age=0`);
}

export const clearSessions = () => sessions.clear();

export function setFlash(res: Response, msg: string) { const s = res.locals.session as Session | undefined; if (s) s.flash = msg; }
export function takeFlash(res: Response): string | undefined {
  const s = res.locals.session as Session | undefined;
  const f = s?.flash; if (s) s.flash = undefined; return f;
}

export function requireAuth(app: AppName) {
  return (req: Request, res: Response, next: NextFunction) => {
    const s = getSession(req, app);
    const next_ = encodeURIComponent(req.method === 'GET' ? req.originalUrl : '/');
    if (!s) return res.redirect(`/login?next=${next_}`);
    s.requests += 1;
    if (shouldExpireSession(app)) {
      sessions.delete(s.id);
      return res.redirect(`/login?expired=1&next=${next_}`);
    }
    res.locals.session = s;
    res.locals.user = s.user;
    next();
  };
}
