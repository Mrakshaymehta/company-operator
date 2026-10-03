// Files in the run's own folder: downloaded documents (read) and outputs the operator writes.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { extractText, getDocumentProxy } from 'unpdf';
import type { RunStore } from '../runtime/events.js';
import { fail, ok, type Tool } from './types.js';

function resolveInRun(store: RunStore, p: string, allowed: string[]) {
  const clean = p.replace(/^\.?\/+/, '').replace(/^runs\/[^/]+\//, '');
  const abs = path.resolve(store.dir, clean.includes('/') ? clean : `downloads/${clean}`);
  const ok_ = allowed.some((dir) => abs.startsWith(path.join(store.dir, dir) + path.sep));
  return ok_ ? abs : null;
}

export async function readDocument(abs: string): Promise<string> {
  if (abs.toLowerCase().endsWith('.pdf')) {
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(abs)));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    return (text as string[]).map((t, i) => `--- Page ${i + 1} of ${totalPages} ---\n${t.replace(/[ \t]+/g, ' ').trim()}`).join('\n');
  }
  return fs.readFileSync(abs, 'utf8');
}

export function fileTools(store: RunStore, opts: { canWrite: boolean }): Tool[] {
  const list = (dir: string) => (fs.existsSync(store.path(dir)) ? fs.readdirSync(store.path(dir)).map((f) => `${dir}/${f}`) : []);
  const tools: Tool[] = [
    {
      name: 'files_list', risk: 'read', description: 'List files downloaded or written during this task.', schema: z.object({}),
      run: async () => { const files = [...list('downloads'), ...list('outputs')]; return ok(`${files.length} file(s)`, files.length ? files.join('\n') : 'No files yet.'); },
    },
    {
      name: 'files_read', risk: 'read', description: 'Read a downloaded document (PDF or text), for example downloads/INV-001.pdf. Returns its text.',
      schema: z.object({ path: z.string() }),
      run: async (a: { path: string }) => {
        const abs = resolveInRun(store, a.path, ['downloads', 'outputs']);
        if (!abs || !fs.existsSync(abs)) return fail('not_found', `No file ${a.path}`, `There is no file "${a.path}". Files available:\n${[...list('downloads'), ...list('outputs')].join('\n') || 'none'}`);
        const text = await readDocument(abs);
        const shown = text.length > 15000 ? text.slice(0, 15000) + '\n… (truncated)' : text;
        return ok(`read ${store.rel(abs)} (${text.length} characters)`, `Contents of ${store.rel(abs)}:\n${shown}`, { artifacts: [store.rel(abs)] });
      },
    },
  ];
  if (opts.canWrite) tools.push({
    name: 'files_write', risk: 'write', description: 'Write a text or CSV file into this task\'s outputs folder, for example a summary for a colleague.',
    schema: z.object({ path: z.string().describe('File name, for example due-bills.csv'), content: z.string() }),
    run: async (a: { path: string; content: string }) => {
      const name = path.basename(a.path).replace(/[^\w.\-]/g, '_');
      const abs = store.path('outputs', name);
      fs.writeFileSync(abs, a.content);
      return ok(`wrote outputs/${name}`, `Saved outputs/${name} (${a.content.length} characters).`, { artifacts: [`outputs/${name}`] });
    },
  });
  return tools;
}
