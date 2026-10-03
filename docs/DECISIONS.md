# Design decisions

Each decision lists what I chose, what else I considered, and why.

### 1. The model is a stateless decision function; the runtime owns all state
- **Chosen:** every step sends the model a complete briefing and asks for one action as schema-checked JSON. Plan, notes, history, approvals and answers live in the diary.
- **Considered:** a long chat transcript with native tool calls; an agent framework that keeps state in memory.
- **Why:** state in our hands makes runs resumable in another process, replayable for debugging, and independent of any provider. It also makes the context deliberate: we choose what the model sees (last four steps in detail, older ones as one-liners, the current page in full) instead of letting a transcript grow until it degrades.
- **Trade-off:** re-sending the briefing costs tokens on every step. Prompt caching of the stable prefix mitigates this in production.

### 2. An append-only diary is the source of truth
- **Chosen:** `events.jsonl` per run. State is `reduce(events)`. The console, reports, resume and evals all read the same events.
- **Considered:** mutable run objects in a database; logging as an afterthought.
- **Why:** an AI employee must be auditable. Event sourcing gives an audit trail, crash recovery, time travel for debugging ("why did it click that?") and eval data for free.

### 3. Policy is enforced on the outgoing request, in code
- **Chosen:** Playwright request interception checks every non-GET request against `policies.json`. Holds are answered with 204 so the form stays filled. Approvals are bound to a fingerprint of the approved values and used once.
- **Considered:** telling the model the rules and trusting it; asking the model to call a `request_approval` tool before risky clicks; checking at the level of "click on a button labeled Save".
- **Why:** prompts are advisory, and button labels are not semantics. The request body is what actually changes the system, so that is where the rule belongs. The model cannot talk its way past code, and it cannot change the amount after approval.

### 4. The checker is a separate, read-only session with trusted runtime records
- **Chosen:** a fresh browser context whose gate allows only sign-in POSTs, no form-fill tool, and a briefing that separates the operator's claims (untrusted) from the runtime's own records (approvals, denials, exact requests sent).
- **Considered:** self-verification by the same loop; a rules-based checker per task.
- **Why:** an agent grading its own homework passes too easily, and per-task checkers do not generalize. A read-only second session that must find evidence in the systems of record catches real mistakes. In development it caught missing evidence and pushed the operator to re-check. Approvals are not visible in the company's systems, so the runtime's records are the trustworthy source for them.

### 5. Pages as numbered elements, screenshots as evidence
- **Chosen:** a DOM read that numbers interactive elements and returns labels, values and options, plus the page's main text. A JPEG screenshot after every action for people.
- **Considered:** pixel-based computer use (screenshot plus coordinates) for everything; raw HTML.
- **Why:** structured reads are faster, cheaper and more reliable for web apps, and they work headless. Screenshots remain for audit and the console. Computer use is the right fallback for desktop apps and canvas UIs, and it plugs into the same tool contract.

### 6. Company knowledge is data, and facts carry provenance and time
- **Chosen:** entities with aliases and system codes; facts with source, quote, validity dates, status and supersession; procedures in markdown; policies in JSON.
- **Considered:** task-specific code or prompts per workflow; a flat "notes" document.
- **Why:** generalization comes from data. Adding the customer-address workflow was a procedure page and a few facts, with no code. Provenance lets the operator cite why ("₹4.20 per the 12 Sep quote") and lets people trust and correct it. Validity dates prevent using expired prices.

### 7. Ask once, remember forever
- **Chosen:** `ask_human` can name an entity and a fact template. If the person agrees, the answer is saved as a confirmed fact with the person as the source. Facts the operator infers are saved as pending.
- **Why:** supervision should go down over time. Test 5 shows the second Sunrise Labels invoice going through without a question. Separating confirmed answers from pending inferences keeps memory trustworthy.

### 8. Never guess the target of a change
- **Chosen:** the understand step asks when the request does not identify which supplier, invoice or customer to act on. The operator is told the same for ambiguities it discovers.
- **Why:** guessing which record to change is the most expensive class of error. Asking one question with real options costs seconds.

### 9. Check before retrying any save
- **Chosen:** the browser layer flags 5xx answers to POSTs as "may or may not have been stored", and the principle "check current records before saving again" is part of the operator's instructions. The sandbox also rejects duplicate invoice numbers as a second line of defence.
- **Why:** blind retries create duplicates. Test 3 injects exactly this case: a save that succeeds but returns 500.

### 10. Our own pretend company, with fault injection and ground truth
- **Chosen:** Kaira Naturals, two server-rendered apps with real logins, validation, sessions and PDFs, plus an admin panel the operator cannot reach.
- **Considered:** public demo sites; mocking tool results.
- **Why:** the brief forbids real credentials, mocked results prove nothing, and reliability cannot be measured without ground truth and faults on demand. The traps (decoy emails, credit note, missing due date, lookalike domain) are realistic and test judgment, not just clicking.

### 11. No agent framework
- **Chosen:** a small loop written for this project (`loop.ts` is about 120 lines).
- **Considered:** LangGraph, the Claude Agent SDK, the Anthropic SDK's tool runner.
- **Why:** the interesting control points (approval holds mid-step, policy events, resumability, separate checker, guards) need to be explicit and testable. A scripted brain drives the full runtime in tests, which is easy when you own the loop.

### 12. Claude through the Claude Code CLI, behind an interface
- **Chosen:** `claude -p --json-schema` with built-in tools and MCP servers disabled and a neutral working directory. Sonnet by default, Opus optional.
- **Why:** it runs on an existing Claude subscription with no API key and returns schema-valid JSON. The `Brain` interface is two fields and one method, so switching to the Anthropic API (with prompt caching) or another provider touches one file.
- **Trade-off:** process start-up adds latency per step (around four seconds per call). The API would be faster.

### 13. One durable queue, one task at a time per company
- **Chosen:** every task goes through a persisted queue with a single worker. Schedules add jobs and never stack.
- **Considered:** running tasks concurrently; cron jobs that call the CLI.
- **Why:** an employee working on the same books twice at once creates races, such as two runs both deciding an invoice is not yet entered. Serialising per company is the simplest correct rule. Production would add per-resource locks for safe parallelism, and event triggers instead of polling.

### 14. Read pages by meaning, and prove it with a redesign
- **Chosen:** the operator never stores selectors or recorded click paths. Each step it reads labels and acts by number.
- **Why:** enterprise software changes under you. Task 11 switches Kaira Books to a redesigned screen with new words, new field order and a different terms format, and the operator completes the task without any change. Recorded RPA scripts would break here.
