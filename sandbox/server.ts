// Starts Kaira Naturals: Kaira Books, Kaira Mail, and the hidden admin panel.
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { booksApp } from './books.js';
import { mailApp } from './mail.js';
import { adminApp } from './admin.js';

export const DEFAULT_PORTS = { books: 4101, mail: 4102, admin: 4199 };

export async function startSandbox(ports = DEFAULT_PORTS) {
  const listen = (app: ReturnType<typeof booksApp>, port: number) =>
    new Promise<Server>((resolve, reject) => { const s = app.listen(port, () => resolve(s)); s.on('error', reject); });
  const servers = await Promise.all([listen(booksApp(), ports.books), listen(mailApp(), ports.mail), listen(adminApp(), ports.admin)]);
  return { ports, close: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const ports = {
    books: Number(process.env.BOOKS_PORT ?? DEFAULT_PORTS.books),
    mail: Number(process.env.MAIL_PORT ?? DEFAULT_PORTS.mail),
    admin: Number(process.env.ADMIN_PORT ?? DEFAULT_PORTS.admin),
  };
  startSandbox(ports).then(() => {
    console.log('Kaira Naturals sandbox is running');
    console.log(`  Kaira Books   http://localhost:${ports.books}   ops.agent@kairanaturals.example / kaira-books-2026`);
    console.log(`  Kaira Mail    http://localhost:${ports.mail}   accounts@kairanaturals.example / kaira-mail-2026`);
    console.log(`  Admin panel   http://localhost:${ports.admin}  (reset, faults, true state)`);
  });
}
