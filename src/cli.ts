// Terminal entry point.  pnpm op run "<task>" | resume <id> | runs | report <id> | memory ...
import fs from 'node:fs';
import { config, loadCompany } from './config.js';
import { makeBrain } from './brain/index.js';
import { CompanyMemory } from './memory/store.js';
import { Operator } from './runtime/operator.js';
import { RunStore } from './runtime/events.js';
import { reduce } from './runtime/state.js';
import { ScriptedHuman, TerminalHuman } from './runtime/human.js';
import { closeBrowser } from './tools/browser.js';
import { attachPrinter } from './printer.js';

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); if (i === -1) return undefined; const v = argv[i + 1]; argv.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : 'true'; };

async function main() {
  const model = flag('model') ?? config.model;
  const checkerModel = flag('checker-model') ?? (flag('model') ? model : config.verifierModel);
  const headed = flag('headed') === 'true' || config.headed;
  const autoApprove = flag('auto-approve') === 'true';
  const maxSteps = flag('max-steps');
  const [cmd, ...rest] = argv;

  const operator = () => new Operator({
    brain: makeBrain(model), checkerBrain: makeBrain(checkerModel),
    human: autoApprove ? new ScriptedHuman({ approvals: 'approve', name: `${config.humanName} (auto)` }) : new TerminalHuman(config.humanName),
    memory: CompanyMemory.load(), company: loadCompany(),
    options: { headed, ...(maxSteps ? { maxSteps: Number(maxSteps) } : {}) },
  });

  switch (cmd) {
    case 'run': {
      const goal = rest.join(' ').trim();
      if (!goal) throw new Error('Give the task in quotes, for example: pnpm op run "Enter the latest invoice from Rajesh Packaging"');
      attachPrinter({ quietHumans: autoApprove });
      const st = await operator().start(goal);
      console.log(`\nReport: ${RunStore.open(st.id).path('report.md')}`);
      process.exitCode = st.status === 'completed' ? 0 : 2;
      break;
    }
    case 'resume': {
      attachPrinter({ quietHumans: autoApprove });
      const st = await operator().resume(rest[0]);
      console.log(`\nReport: ${RunStore.open(st.id).path('report.md')}`);
      break;
    }
    case 'runs': {
      for (const id of RunStore.list().slice(0, 30)) {
        const s = reduce(RunStore.open(id).read());
        console.log(`${id}  ${s.status.padEnd(16)} ${String(s.steps.length).padStart(3)} steps  ${s.goal.slice(0, 80)}`);
      }
      break;
    }
    case 'report': console.log(fs.readFileSync(RunStore.open(rest[0]).path('report.md'), 'utf8')); break;
    case 'memory': {
      const mem = CompanyMemory.load();
      const sub = rest[0] ?? 'pending';
      if (sub === 'reset') { CompanyMemory.reset(); console.log('Company memory reset to the seed.'); break; }
      if (sub === 'confirm' || sub === 'reject') { const f = mem.setStatus(rest[1], sub === 'confirm' ? 'confirmed' : 'rejected', config.humanName); console.log(f ? `${sub}ed ${f.id}: ${f.text}` : 'No such fact'); break; }
      if (sub === 'show') { console.log(rest[1] ? mem.entityCard(rest[1]) ?? 'No such entity' : mem.index()); break; }
      const pending = mem.data.facts.filter((f) => f.status === 'pending');
      console.log(pending.length ? pending.map((f) => mem.formatFact(f)).join('\n') : 'No facts waiting for confirmation.');
      break;
    }
    default:
      console.log(`Usage:
  pnpm op run "<task>" [--model sonnet|opus] [--headed] [--auto-approve] [--max-steps N]
  pnpm op resume <run-id>
  pnpm op runs
  pnpm op report <run-id>
  pnpm op memory [pending | show [entity] | confirm <fact-id> | reject <fact-id> | reset]`);
  }
}

main().catch((e) => { console.error(`\x1b[31m${(e as Error).message}\x1b[0m`); process.exitCode = 1; }).finally(() => closeBrowser());
