# Architecture

This document explains how a request becomes checked work, what each part is responsible for, and how the prototype would grow into a production AI-employee platform.

## 1. The shape of the system

| Layer | Responsibility | Code |
|---|---|---|
| Interfaces | Console (web) and terminal: start tasks, answer questions, approve, read reports, confirm memory | `src/console/`, `src/cli.ts`, `src/printer.ts` |
| Orchestrator | Run lifecycle: understand → clarify → execute → check → fix once → report; approvals; learned facts | `src/runtime/operator.ts` |
| Step loop | One decision per step: brief the model, validate, run the tool, record, apply guards | `src/runtime/loop.ts`, `src/runtime/guards.ts` |
| Briefing | What the model sees at each step (it keeps no state of its own) | `src/runtime/context.ts`, `src/runtime/prompts.ts` |
| Diary and state | Append-only event log per run; state rebuilt by a pure reducer | `src/runtime/events.ts`, `src/runtime/state.ts`, `src/runtime/types.ts` |
| Policy gate | Company rules enforced on every outgoing browser request | `src/runtime/policy.ts`, `company/policies.json` |
| Brain | Stateless decision function behind a two-method interface | `src/brain/` |
| Tools | Browser, files, memory, ask a person, finish/verdict | `src/tools/`, `src/runtime/operator.ts` |
| Company memory | Entities, dated facts with sources, procedures, policies | `src/memory/store.ts`, `company/memory/` |
| Sandbox | Kaira Naturals: two real web apps, PDFs, faults, ground truth | `sandbox/` |

## 2. Lifecycle of a run

1. **Create.** `RunStore.create()` makes `runs/<id>/` and writes `run.created`.
2. **Understand.** One model call reads the request, the systems and the memory index. It writes a brief: intent, two to four checkable success criteria, the entities and procedures involved, a plan, and (only if the target of the work is ambiguous) a question with options.
3. **Clarify.** If there is a question, the run waits for a person (`waiting_input`). The answer is recorded and the brief is rewritten with it.
4. **Execute.** The step loop runs until the model calls `finish`, a guard stops it, or a budget runs out. Each step appends a `decision` and a `result` event. Tool results that need people (approval holds, questions) are handled by the orchestrator, which appends `approval.requested` / `approval.resolved` or `question` / `answer`.
5. **Check.** If `finish.status` is `done`, a separate checker loop runs with its own browser context (read-only gate), its own tool set (no form filling), and a verdict tool. Its briefing contains the criteria, the operator's claims marked untrusted, and the runtime's records.
6. **Fix once.** If any criterion is not `pass`, the checker's findings go back to the operator as an observation, and it continues. The fix-round count is configurable (default one).
7. **Flags.** `finish.flags` lists anything a person should look at even if the work is done, such as a refused instruction or a suspicious email. They are shown first in the console and the report.
8. **Finish.** `run.finished` with `completed`, `needs_human` or `failed`, then `report.md` is written. Facts the operator proposed in `finish.learned` are saved to memory as pending.

**Resume.** `Operator.resume(id)` rebuilds state from the diary, re-adds grants for approvals already given, re-asks any question that was waiting, and continues the loop. The browser restarts fresh, so the model is told to sign in again and to check what is already done before repeating any save. Test 9 kills the process with SIGKILL mid-run and resumes it.

## 2b. Background work

Every task, whether a person typed it, a schedule fired it, or it is a resume, goes through one queue (`src/console/queue.ts`):
- **One task at a time per company.** Two runs never change the same records at once. Production would use per-resource locks to allow safe parallelism.
- **Durable.** Jobs and schedules are written to `data/queue.json`. Jobs that were running when the process died come back as "interrupted", and their runs resume from the diary.
- **Schedules** are interval-based ("every 5 minutes: check the accounts inbox for invoices not yet in Kaira Books"). A schedule never stacks a second job while one is queued or running.
- The demo controls can **deliver new emails** (a Greenleaf invoice with no due date, a Pixel & Post invoice with one), so the schedule has real new work to find.

## 3. The step

```
state  = reduce(events)                       pure function of the diary
guards = checkGuards(state.steps)             repetition and error streaks → warning or stop
prompt = briefing(state, memory, last observation, warnings, budget)
action = brain.decide(system, prompt, JSON schema)          { reason, plan?, notes?, tool, args }
action = zod-validate(action); args = tool.schema.parse(args)
result = tool.run(args)                       browser actions end with a fresh page read and a screenshot
append decision + result (+ policy events)
```

Invalid output, unknown tools and bad arguments become error observations, so the model corrects itself on the next step instead of crashing the run.

**The briefing** contains: today's date, the task, clarifications, success criteria, company context (entity cards with current, pending and replaced facts; full procedure text; all policies), the to-do list, the model's notes with sources, people's input, earlier steps as one-liners, the last four steps in detail, runtime warnings, the current observation in full, and the remaining budget.

## 4. Seeing and acting on pages

After every action, an in-page script numbers every visible link, button and field (`data-op-ref`). It returns each element's role, accessible name (label, aria-label or text), value, options and href, plus the main text of the page. The model acts by number. The numbers are reassigned on every read, and stale numbers are detected and answered with the current page.

`BrowserSession.act()` wraps every action. It clears the signals, runs the action, waits for the page, collects downloads, then reports everything notable in plain words:
- an approval hold or policy block
- a blocked navigation outside the company's systems
- an HTTP 5xx answer, with an explicit warning if it answered a POST: "the change may or may not have been stored; check before saving again"
- a sign-in page ("use browser_login with system books")
- a downloaded file

Logins are performed by the runtime from `company/vault.json`. The model only names the system.

## 5. Policy enforcement

```
browser request ──► route handler ──► system? (allowlist of company origins; anything else is aborted)
                                   ──► GET / sign-in POST → continue
                                   ──► rules in order (method, path regex, condition on form fields)
                                         deny              → answer 204, report "blocked by policy"
                                         require_approval  → grant for this exact fingerprint? continue (grant used)
                                                             otherwise answer 204, report "held for approval"
                                   ──► allowed change → log a `write` event, continue
```

- **Why 204:** a 204 No Content answer to a form navigation leaves the current page and its filled form in place. After approval the model re-submits the same form, and nothing has to be re-entered.
- **Why fingerprints:** the approval covers the values the person saw (supplier, invoice number, dates, amount, category). Changing any of them after approval makes a new request that is held again. Each grant is used once.
- **Rules are data.** Conditions support comparisons, "all recipients end with", products of two fields (PO value) and any/all combinations. The checker's gate is the same class in read-only mode.

## 6. Company memory

```
Entity { id, type, name, aliases[], summary, links{ books: "S-1001" } }
Fact   { id, entity, shelf, kind, text, source{ type, ref, by, date, quote }, status: confirmed|pending|rejected,
         validFrom, validTo, supersededBy }
Procedure { id, title, summary, file }   (markdown)
```

- A fact is **current** if it is not rejected, not superseded and not past `validTo`. Briefings show current facts and history separately, so the model sees that ₹4.80 was replaced by ₹4.20 on 12 Sep.
- **Answers** from people become `confirmed` facts with the person as the source. A confirmed fact of the same entity and kind supersedes the old one.
- **Learned facts** proposed by the operator are `pending` until a person confirms them in the console or with `pnpm op memory confirm <id>`.
- The six shelves (people, things and prices, promises, rules, money facts, sources) and the fact shape come from my earlier business-memory product design. Search is keyword-based with alias boosting, which is enough for a small memory.

## 7. Failure handling

| Situation | Detected by | Response |
|---|---|---|
| Slow page or timeout | Playwright timeout | Reported as `timeout`. The model retries or re-reads. |
| The app's screens are redesigned | Nothing to detect: elements are read by their labels each step | Task 11 renames "Bills" to "Payables", "Supplier" to "Vendor" and "Due date" to "Pay by", reorders the fields, and shows terms as "Net 45". It passes unchanged. |
| Logged out mid-task | URL equals the system's login path | Observation tells the model to sign in. Login returns to the previous page. |
| HTTP 500 after a save | Main-frame response status on a POST | Warning that the write may have happened. The model checks the records before saving again. Test 3 proves no duplicate. |
| Stale element number | Element no longer present | `stale_ref` with the current page |
| Bad model output | zod validation | Error observation with the exact problem |
| Going in circles | Same action three times in the last eight steps since the last change was sent (so entering several bills is not a loop) | Warning. Five times: stop and hand to a person. |
| Error streak | Four failures in a row | Warning. Seven: stop. |
| Ambiguous target | Understand step or the operator itself | Ask one question with options before changing anything |
| Suspicious instructions in content | Model, guided by policy | Refuse, finish `blocked`. The gate denies bank changes regardless. |
| Process crash | — | `resume` from the diary |
| Model unavailable | Brain adapter retries three times with backoff | Run stops as `needs_human`, resumable |
| Checker cannot confirm | Verdict | One fix round, then `needs_human` with the findings |

## 8. Security model

- **Credentials** live in a vault keyed by system name and are typed by the runtime. Password values are hidden in page reads. Prompts and the diary never contain them.
- **Reach:** the browser can only load the company's own origins. The admin panel's port is not one of them.
- **Writes** pass a policy gate in our code. The model can neither see the rules' implementation nor bypass it. Approvals are bound to values and used once.
- **Untrusted content:** emails, PDFs and pages are labeled as information, not instructions, in the system prompt and in company policy. Test 7 contains an explicit injection aimed at AI assistants.
- **Separation of duties:** the checker is read-only and gets the runtime's own records as trusted evidence, separate from the operator's untrusted claims.
- **Audit:** every decision, action, observation, approval, denial and outgoing change is in an append-only diary, with a screenshot after each browser action.

## 9. From prototype to production

| Concern | Prototype | Production |
|---|---|---|
| Execution | In-process loop, one worker queue with interval schedules in a JSON file | Durable workflow engine (Temporal or similar). Each step is an activity with retries. Human waits are signals, so runs survive deploys. |
| State | JSONL per run, reducer | Postgres event table (append-only) with projections for the console. The same reducer runs in code. |
| Memory | JSON file, keyword search | Postgres with per-tenant row-level security, pgvector plus full-text, a rerank step, and the same fact model with validity and provenance |
| Tenancy | One company | Tenant id on every row, policy and vault. Per-tenant browser contexts and egress allowlists. |
| Browsers | One local Chromium | A pool of isolated browser workers (containers), recorded sessions, per-tenant network policy |
| Secrets | `vault.json` | A secrets manager, with short-lived credentials and OAuth where systems support it |
| Policy | JSON rules | Versioned per tenant, reviewed like code, tested in CI. Approvals routed by role with escalation and expiry. |
| Reach | Browser and files | Plus computer-use for desktop apps and API connectors (MCP), all behind the same gate |
| Model | Claude through the CLI | The Anthropic API with prompt caching (the system prompt and memory are a stable prefix). Smaller models for routine steps, a larger model for planning and checking. Fallbacks. |
| Quality | 10 graded scenarios | Hundreds of scenarios with perturbed UIs and documents, repeated runs, pass rate, cost and latency per change, gating releases |
| Observability | Diary and report | OpenTelemetry traces per step, cost per task and per tenant, alerting on stuck runs and approval backlogs |
| Learning | Answers saved as facts, learned facts pending | Procedure suggestions mined from successful traces, approved by people, replayed as fast paths |
