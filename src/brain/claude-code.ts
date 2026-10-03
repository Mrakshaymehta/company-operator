// Brain backed by the local Claude Code CLI in headless mode. Uses whatever login Claude Code has (for example a
// Claude Max plan), with all of Claude Code's own tools switched off: the operator's runtime is the only actor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrainError, type Brain, type BrainRequest, type BrainResponse } from './types.js';

export class ClaudeCodeBrain implements Brain {
  name: string;
  private cwd: string;
  constructor(private model: string, private opts: { timeoutMs?: number; attempts?: number; bin?: string } = {}) {
    this.name = `claude-code:${model}`;
    // A neutral working directory, so no project instructions leak into the operator's prompts.
    this.cwd = path.join(os.tmpdir(), 'company-operator-brain');
    fs.mkdirSync(this.cwd, { recursive: true });
  }

  async decide<T>(req: BrainRequest): Promise<BrainResponse<T>> {
    const attempts = this.opts.attempts ?? 3;
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      try { return await this.once<T>(req); } catch (e) {
        last = e;
        if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
    throw new BrainError(`Brain call failed after ${attempts} attempts (${req.purpose}): ${(last as Error)?.message ?? last}`);
  }

  private once<T>(req: BrainRequest): Promise<BrainResponse<T>> {
    const args = ['-p', '--model', this.model, '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config',
      '--system-prompt', req.system, '--json-schema', JSON.stringify(req.schema)];
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k.startsWith('CLAUDE_CODE_')) delete env[k];
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.bin ?? 'claude', args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new BrainError(`timed out after ${this.opts.timeoutMs ?? 240000} ms`)); }, this.opts.timeoutMs ?? 240000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => { clearTimeout(timer); reject(new BrainError(`could not start Claude Code (${e.message}). Is the claude CLI installed and logged in?`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed: { is_error?: boolean; structured_output?: unknown; result?: string; total_cost_usd?: number; subtype?: string };
        try { parsed = JSON.parse(out); } catch { return reject(new BrainError(`unreadable output (exit ${code}): ${(err || out).slice(0, 400)}`)); }
        if (parsed.is_error) return reject(new BrainError(`Claude Code error: ${String(parsed.result ?? parsed.subtype).slice(0, 400)}`));
        let output = parsed.structured_output as T | undefined;
        if (output === undefined && typeof parsed.result === 'string') {
          const m = parsed.result.match(/\{[\s\S]*\}/);
          try { output = m ? (JSON.parse(m[0]) as T) : undefined; } catch { /* handled below */ }
        }
        if (output === undefined) return reject(new BrainError(`no structured output: ${String(parsed.result).slice(0, 300)}`));
        resolve({ output, ms: Date.now() - started, costUsd: parsed.total_cost_usd, model: this.name });
      });
      child.stdin.end(req.prompt);
    });
  }
}
