// Builds the briefing the model sees at each step. The model is stateless: everything it needs is in here.
import type { RunState, StepView } from './state.js';
import type { FinishArgs } from './types.js';
import type { CompanyMemory } from '../memory/store.js';

export const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const resultText = (s: StepView) => (s.result ? `${s.result.ok ? 'ok' : `FAILED (${s.result.errorKind})`}: ${clip(s.result.summary, 220)}` : 'no result');
const stepLine = (s: StepView) => `#${s.step} ${s.tool} ${clip(JSON.stringify(s.args), 140)} → ${resultText(s)}`;
const stepDetail = (s: StepView) => `#${s.step} reason: ${clip(s.reason, 300)}\n    action: ${s.tool} ${clip(JSON.stringify(s.args), 300)}\n    result: ${resultText(s)}`;

export function companyContext(state: RunState, memory: CompanyMemory): string {
  const b = state.brief;
  const entities = (b?.entities ?? []).map((id) => memory.entityCard(id)).filter(Boolean);
  const procedures = (b?.procedures ?? []).map((id) => memory.procedureText(id)).filter(Boolean);
  return [
    'COMPANY CONTEXT (from company memory)',
    `Entities involved:\n${entities.join('\n\n') || '(none identified; use memory_search)'}`,
    `Procedures that apply:\n${procedures.join('\n\n') || '(none identified; use memory_search)'}`,
    `Company policies:\n${memory.policies().map((f) => `- ${f.text}`).join('\n')}`,
  ].join('\n\n');
}

function peopleInput(state: RunState): string {
  const lines = [
    ...state.questions.filter((q) => q.answer).map((q) => `- You asked "${q.question}". ${q.by} answered: ${q.answer}${q.remember && q.saveAs ? ' (saved to company memory)' : ''}`),
    ...state.approvals.filter((a) => a.decision).map((a) => `- Approval for rule ${a.ruleId}: ${a.decision} by ${a.by}${a.note ? ` (note: ${a.note})` : ''}`),
  ];
  return lines.length ? `PEOPLE'S INPUT SO FAR\n${lines.join('\n')}` : '';
}

export function executorPrompt(state: RunState, memory: CompanyMemory, last: { observation: string; step: number } | null, extra: string[], step: number, budget: { maxSteps: number; deadline: number }) {
  const b = state.brief;
  const steps = state.steps;
  const older = steps.slice(0, -4);
  const recent = steps.slice(-4);
  const plan = state.plan.map((p) => `${p.status === 'done' ? '[x]' : p.status === 'doing' ? '[>]' : p.status === 'skipped' ? '[-]' : '[ ]'} ${p.step}`).join('\n');
  const notes = state.notes.map((n) => `- ${n.key}: ${n.value} (source: ${n.source})`).join('\n');
  const minutesLeft = Math.max(0, Math.round((budget.deadline - Date.now()) / 60000));
  return [
    `TODAY: ${todayIST()}`,
    `TASK: ${state.goal}`,
    state.clarifications.length ? `CLARIFICATIONS\n${state.clarifications.map((c) => `- ${c.question} → ${c.answer} (${c.by})`).join('\n')}` : '',
    b ? `WHAT SUCCESS LOOKS LIKE\n${b.success_criteria.map((c) => `- ${c}`).join('\n')}` : '',
    companyContext(state, memory),
    `YOUR TO-DO LIST\n${plan || '(empty)'}`,
    `YOUR NOTES\n${notes || '(none yet)'}`,
    peopleInput(state),
    older.length ? `EARLIER STEPS\n${older.map(stepLine).join('\n')}` : '',
    recent.length ? `RECENT STEPS (most recent last)\n${recent.map(stepDetail).join('\n')}` : '',
    ...extra,
    `CURRENT OBSERVATION${last ? ` (result of step #${last.step})` : ''}\n${last?.observation ?? 'Nothing has been done yet.'}`,
    `BUDGET: this is step ${step} of at most ${budget.maxSteps}; about ${minutesLeft} minutes left.`,
    'Decide the single next action.',
  ].filter(Boolean).join('\n\n');
}

export function runtimeRecords(state: RunState): string {
  const t = (iso: string) => iso.slice(11, 19);
  const lines = [
    ...state.approvals.map((a) => `- Approval ${a.id} under rule "${a.ruleId}" (${a.description}) for ${JSON.stringify(a.fields)}: ${a.decision ?? 'pending'}${a.by ? ` by ${a.by}` : ''}`),
    ...state.questions.filter((q) => q.answer).map((q) => `- Question "${q.question}" answered by ${q.by}: ${q.answer}`),
    ...state.denials.map((d) => `- Blocked by policy: ${d.reason}`),
    ...state.writes.map((w) => `- ${t(w.at)} UTC sent ${w.method} ${w.system}${w.path} ${JSON.stringify(w.fields).slice(0, 300)}${w.approvalId ? ` (allowed by approval ${w.approvalId})` : ''}`),
  ];
  return `RUNTIME RECORDS (written by the operator's own code, not by the agent: you can rely on these for approvals and for what was actually sent)\n${lines.join('\n') || '- nothing recorded'}`;
}

export function verifierPrompt(state: RunState, finish: FinishArgs, steps: StepView[], last: { observation: string; step: number } | null, step: number, budget: { maxSteps: number }, previous?: { observation: string; step: number } | null) {
  const b = state.brief;
  const downloads = [...new Set(state.steps.flatMap((s) => s.result?.artifacts ?? []))];
  return [
    `TODAY: ${todayIST()}`,
    `TASK THE OTHER AGENT WAS GIVEN: ${state.goal}`,
    state.clarifications.length ? `CLARIFICATIONS\n${state.clarifications.map((c) => `- ${c.question} → ${c.answer}`).join('\n')}` : '',
    `SUCCESS CRITERIA TO CHECK\n${(b?.success_criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    `WHAT THE OTHER AGENT CLAIMS (do not trust; verify)\nSummary: ${finish.summary}\n${finish.evidence.map((e) => `- ${e.criterion}: ${e.proof}`).join('\n')}`,
    `SOURCE DOCUMENTS IT USED (you can read them with files_read)\n${downloads.join('\n') || 'none'}`,
    runtimeRecords(state),
    steps.length ? `YOUR STEPS SO FAR\n${steps.map(stepLine).join('\n')}` : '',
    `YOUR NOTES (what you have seen so far)\n${steps.flatMap((s) => s.notes ?? []).map((n) => `- ${n.key}: ${n.value} (seen in: ${n.source})`).join('\n') || '(none yet)'}`,
    previous && previous.step !== last?.step ? `PREVIOUS OBSERVATION (step #${previous.step}, shortened)\n${clip(previous.observation, 2500)}` : '',
    `CURRENT OBSERVATION${last ? ` (result of step #${last.step})` : ''}\n${last?.observation ?? 'Nothing checked yet.'}`,
    `BUDGET: step ${step} of at most ${budget.maxSteps}.`,
    'Decide the single next action.',
  ].filter(Boolean).join('\n\n');
}
