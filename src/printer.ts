// Prints a run's diary to the terminal as it happens.
import { runBus } from './runtime/events.js';
import type { RunEvent } from './runtime/types.js';

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, cy: (s: string) => `\x1b[36m${s}\x1b[0m` };
const tag = (t: string) => c.cy(t.padEnd(11));
const short = (v: unknown, n = 110) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };

export function attachPrinter(opts: { quietHumans?: boolean } = {}) {
  const handler = (e: RunEvent) => {
    switch (e.type) {
      case 'run.created': console.log(`\n${c.b('▸ run')} ${e.runId}  ${c.dim(`brain ${e.options.brain} · checker ${e.options.checker}`)}\n${c.dim('task:')} ${e.goal}`); break;
      case 'resumed': console.log(`${tag('RESUMED')} ${e.note}`); break;
      case 'brief':
        console.log(`${tag('UNDERSTAND')} ${e.brief.intent}`);
        e.brief.success_criteria.forEach((s) => console.log(`${' '.repeat(11)} ${c.dim('✓ ' + s)}`));
        if (e.brief.procedures.length) console.log(`${' '.repeat(11)} ${c.dim('procedures: ' + e.brief.procedures.join(', '))}`);
        console.log(`${tag('PLAN')} ${e.brief.plan.join(c.dim(' · '))}`);
        if (e.brief.question) console.log(`${tag('UNCLEAR')} ${e.brief.question}`);
        break;
      case 'question': if (opts.quietHumans) console.log(`${tag('QUESTION')} ${e.question} ${c.dim(`[${e.options.join(' | ')}]`)}`); break;
      case 'answer': console.log(`${' '.repeat(11)} ${c.g('↳ ' + e.by + ': ' + e.answer)}${e.remember ? c.dim(' (remembered)') : ''}`); break;
      case 'decision':
        if (e.role === 'executor') console.log(`${c.b(String(e.step).padStart(3))} ${c.dim(short(e.reason, 160))}\n    ${e.tool} ${c.dim(short(e.args))}`);
        else console.log(`${c.dim(' chk ' + e.step)} ${e.tool} ${c.dim(short(e.args, 80))}`);
        break;
      case 'result':
        if (e.tool === 'finish' || e.tool === 'verdict') break;
        if (e.role === 'executor') console.log(`    ${e.ok ? c.g('→') : c.r('✗')} ${short(e.summary, 200)}`);
        else if (!e.ok) console.log(`     ${c.r('✗')} ${short(e.summary, 120)}`);
        break;
      case 'approval.requested': if (opts.quietHumans) console.log(`${tag('APPROVAL')} ${e.description} ${c.dim(short(e.fields, 160))}`); break;
      case 'approval.resolved': console.log(`${' '.repeat(11)} ${e.decision === 'approved' ? c.g(`↳ approved by ${e.by}`) : c.r(`↳ rejected by ${e.by}`)}`); break;
      case 'policy.denied': console.log(`${tag('POLICY')} ${c.y(e.reason)}`); break;
      case 'write': console.log(`${tag('SENT')} ${e.method} ${e.system}${e.path}${e.approvalId ? c.dim(` (approved ${e.approvalId})`) : ''}`); break;
      case 'guard': console.log(`${tag('GUARD')} ${c.y(e.message)}`); break;
      case 'memory': console.log(`${tag('MEMORY')} ${e.action === 'saved' ? 'saved' : 'proposed'}: ${e.text}`); break;
      case 'finish': console.log(`${tag('FINISH')} ${e.args.status}: ${e.args.summary}`); for (const f of e.args.flags ?? []) console.log(`${tag('FLAG')} ${c.y(f)}`); break;
      case 'status': if (e.status === 'verifying') console.log(`${tag('CHECK')} ${c.dim('independent checker, read-only browser')}`); break;
      case 'verify.result':
        console.log(`${tag('VERDICT')} ${e.verdict.overall === 'pass' ? c.g('pass') : c.r('fail')}`);
        e.verdict.criteria.forEach((k) => console.log(`${' '.repeat(11)} ${k.status === 'pass' ? c.g('✓') : c.r('✗')} ${k.criterion} ${c.dim('· ' + short(k.evidence, 120))}`));
        break;
      case 'error': console.log(`${tag('ERROR')} ${c.r(e.where + ': ' + e.message.split('\n')[0])}`); break;
      case 'run.finished': {
        const col = e.status === 'completed' ? c.g : e.status === 'failed' ? c.r : c.y;
        console.log(`${tag('DONE')} ${col(e.status)}  ${e.summary}`);
        break;
      }
    }
  };
  runBus.on('event', handler);
  return () => runBus.off('event', handler);
}
