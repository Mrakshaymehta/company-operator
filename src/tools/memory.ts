// Read access to company memory. New facts are proposed through finish (pending) or saved from people's answers.
import { z } from 'zod';
import type { CompanyMemory } from '../memory/store.js';
import { fail, ok, type Tool } from './types.js';

export function memoryTools(memory: CompanyMemory): Tool[] {
  return [
    {
      name: 'memory_search', risk: 'read',
      description: 'Search company memory (people, suppliers, customers, prices, terms, promises, policies, procedures). Set include_history to also see replaced or expired facts.',
      schema: z.object({ query: z.string(), include_history: z.boolean().optional() }),
      run: async (a: { query: string; include_history?: boolean }) => {
        memory.refresh();
        const r = memory.search(a.query, { includeHistory: a.include_history });
        const parts = [
          r.entities.length ? `Entities:\n${r.entities.map((e) => `- ${e.id}: ${e.name} (${e.type}; also called ${e.aliases.join(', ')})${e.links.books ? `, Kaira Books ${e.links.books}` : ''}`).join('\n')}` : '',
          r.facts.length ? `Facts:\n${r.facts.map((f) => `- ${memory.formatFact(f)}`).join('\n')}` : '',
          r.procedures.length ? `Procedures:\n${r.procedures.map((p) => `- ${p.id}: ${p.title}. ${p.summary}`).join('\n')}` : '',
        ].filter(Boolean);
        return ok(`${r.entities.length} entities, ${r.facts.length} facts, ${r.procedures.length} procedures for "${a.query}"`, parts.join('\n\n') || `Nothing in company memory matches "${a.query}".`);
      },
    },
    {
      name: 'memory_get', risk: 'read', description: 'Everything company memory knows about one entity (by id or name): current facts, pending facts and history.',
      schema: z.object({ entity: z.string() }),
      run: async (a: { entity: string }) => {
        memory.refresh();
        const card = memory.entityCard(a.entity);
        return card ? ok(`memory card for ${a.entity}`, card) : fail('not_found', `No entity "${a.entity}"`, `Company memory has no entity "${a.entity}". Try memory_search.`);
      },
    },
    {
      name: 'memory_procedure', risk: 'read', description: 'Read a company procedure in full by its id.',
      schema: z.object({ id: z.string() }),
      run: async (a: { id: string }) => {
        const text = memory.procedureText(a.id);
        return text ? ok(`procedure ${a.id}`, text) : fail('not_found', `No procedure "${a.id}"`, `No procedure "${a.id}". Procedures: ${memory.data.procedures.map((p) => p.id).join(', ')}.`);
      },
    },
  ];
}
