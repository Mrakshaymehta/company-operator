// How the operator reaches a person: questions and approvals. Implemented by the terminal, the web console and the test harness.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface QuestionRequest { runId: string; id: string; question: string; options: string[]; why?: string; canRemember: boolean }
export interface QuestionAnswer { answer: string; by: string; remember: boolean }
export interface ApprovalRequest { runId: string; id: string; ruleId: string; description: string; approver?: string; fields: Record<string, string>; summary: string; screenshot?: string }
export interface ApprovalDecision { decision: 'approved' | 'rejected'; by: string; note?: string }
export interface HumanChannel {
  ask(q: QuestionRequest): Promise<QuestionAnswer>;
  approve(a: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Scripted person for automated tests: answers by matching the question text, and approves or rejects. */
export class ScriptedHuman implements HumanChannel {
  asked: QuestionRequest[] = [];
  approvalsSeen: ApprovalRequest[] = [];
  constructor(private script: { answers?: { match: RegExp; answer: string; remember?: boolean }[]; approvals?: 'approve' | 'reject'; name?: string } = {}) {}
  async ask(q: QuestionRequest) {
    this.asked.push(q);
    const hit = this.script.answers?.find((a) => a.match.test(q.question));
    return { answer: hit?.answer ?? (q.options[0] ?? 'Use your best judgement'), by: this.script.name ?? 'Test harness', remember: hit?.remember ?? true };
  }
  async approve(a: ApprovalRequest) {
    this.approvalsSeen.push(a);
    return this.script.approvals === 'reject'
      ? { decision: 'rejected' as const, by: this.script.name ?? 'Test harness', note: 'Rejected by test script' }
      : { decision: 'approved' as const, by: this.script.name ?? 'Test harness' };
  }
}

/** A person at the terminal. */
export class TerminalHuman implements HumanChannel {
  constructor(private name: string) {}
  private async prompt(text: string) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try { return (await rl.question(text)).trim(); } finally { rl.close(); }
  }
  async ask(q: QuestionRequest) {
    console.log(`\n\x1b[36mQUESTION\x1b[0m  ${q.question}`);
    if (q.why) console.log(`          ${q.why}`);
    q.options.forEach((o, i) => console.log(`  [${i + 1}] ${o}`));
    const raw = await this.prompt('  Your answer (number or text) › ');
    const n = Number(raw);
    const answer = Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1] : raw;
    let remember = false;
    if (q.canRemember) remember = !/^n/i.test(await this.prompt('  Save this answer to company memory? [Y/n] › '));
    return { answer, by: this.name, remember };
  }
  async approve(a: ApprovalRequest) {
    console.log(`\n\x1b[33mAPPROVAL NEEDED\x1b[0m  ${a.description}`);
    if (a.approver) console.log(`  Approver: ${a.approver}`);
    for (const [k, v] of Object.entries(a.fields)) console.log(`  ${k.padEnd(14)} ${v}`);
    if (a.summary) console.log(`  Operator says: ${a.summary}`);
    if (a.screenshot) console.log(`  Screenshot: ${a.screenshot}`);
    const raw = await this.prompt('  Approve? [y]es / [n]o › ');
    if (/^y/i.test(raw)) return { decision: 'approved' as const, by: this.name };
    const note = await this.prompt('  Reason (optional) › ');
    return { decision: 'rejected' as const, by: this.name, note: note || undefined };
  }
}
