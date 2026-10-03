# Code tour: one task through the code

This follows **"Enter the latest invoice from Swift Cargo."**, the ₹1,18,000 invoice that needs approval, from the moment it is typed until the report is written. Read it with the code open.

## 0. Where the task enters

- **Console:** `src/console/public/app.js` posts `{ goal }` to `POST /api/runs`.
- **Server:** in `src/console/server.ts` that route builds an `Operator` with the Claude Code brain, a `WebHuman` (questions and approvals wait for clicks), the company memory and the company config. It calls `operator.start(goal, onCreated)` and answers the browser with the new run id as soon as the diary exists.
- **Queue:** in the console, tasks go through `WorkQueue` (`src/console/queue.ts`), which runs one task at a time and also takes jobs from schedules.
- **Terminal:** `src/cli.ts` does the same with a `TerminalHuman` that asks in the terminal.

## 1. A diary is created

`Operator.start()` in `src/runtime/operator.ts` calls `RunStore.create()` (`src/runtime/events.ts`). That creates `runs/<id>/` with `screenshots/`, `downloads/` and `outputs/`, and appends the first event, `run.created`. Every later fact about the run is another line in `events.jsonl`. `RunStore.append` also publishes each event on `runBus`, which feeds the terminal printer and the console's live stream.

## 2. Understanding the request

`drive()` → `understandPhase()` → `understand()`. One brain call with `understandSystem()` from `src/runtime/prompts.ts`. The prompt holds the request, the systems, and `memory.index()`, a table of contents of company memory (entities with nicknames and codes, procedures, policies). The model returns a brief matching `briefSchema`: intent, success criteria, entity ids, procedure ids, a plan, and a question if the target is ambiguous. Here it picks `swift-cargo` and `enter-supplier-invoice` and asks nothing, because Swift Cargo is named. Entity and procedure ids are filtered against memory, so made-up ids are dropped. A `brief` event is appended.

## 3. Tools for this run

`executorTools()` assembles the tool set:
- `browserTools()` from `src/tools/browser.ts`: open, login, click, type, select, fill_form, back, read_page.
- `fileTools()` from `src/tools/files.ts`: list, read (PDF text through unpdf), write.
- `memoryTools()` from `src/tools/memory.ts`: search, get, procedure.
- `ask_human` and `finish`, defined in the operator because they involve people and the run's end.

Each tool is `{ name, description, schema (zod), risk, run() }` (`src/tools/types.ts`). `executorSystem()` turns the tool set into the system prompt's catalog with `z.toJSONSchema`.

## 4. The step loop

`runLoop()` in `src/runtime/loop.ts` repeats:
1. `reduce(store.read())` (`src/runtime/state.ts`) rebuilds state from the diary.
2. `checkGuards()` (`src/runtime/guards.ts`) looks for repetition and error streaks.
3. `executorPrompt()` (`src/runtime/context.ts`) builds the briefing.
4. `brain.decide()` returns `{ reason, plan?, notes?, tool, args }`. The schema comes from `decisionSchema()`.
5. The decision is validated, a `decision` event is appended, and the tool's own zod schema checks the arguments.
6. `tool.run()` executes, and a `result` event is appended.
7. `onResult` lets the orchestrator react to approval holds and policy denials.

The brain is `ClaudeCodeBrain` (`src/brain/claude-code.ts`). It spawns `claude -p --json-schema … --tools "" --strict-mcp-config` in a neutral folder, writes the prompt to stdin, and parses `structured_output`.

## 5. Acting in the browser

Say the model chooses `browser_login { system: "mail" }`. `BrowserSession.login()` opens the login page, fills the username and password from `company/vault.json`, and submits. Every action goes through `BrowserSession.act()`:
- It clears the per-action signals: blocked requests, downloads, the last navigation status.
- It runs the action, waits for the page to settle, and collects downloads into `runs/<id>/downloads/`.
- `report()` reads the page with `SNAPSHOT_JS` (`src/tools/snapshot.ts`). That numbers every visible element and returns labels, values and options. `formatSnapshot()` turns it into the text the model sees.
- It adds plain-language notices: held for approval, blocked by policy, HTTP 500 after a POST, on a sign-in page, file downloaded.
- It takes a screenshot to `screenshots/executor-NN.jpg`.

The model then clicks `[13]` (the Swift Cargo invoice email), clicks `[7]` ("Download SCM-2026-1187.pdf"), and calls `files_read`. It notes the total, signs in to Kaira Books, checks the supplier and the bills list, opens New bill, and calls `browser_fill_form` with a `submit_ref`.

## 6. The policy gate holds the save

When the form is submitted, Playwright calls `BrowserSession.onRoute()` for the outgoing `POST /bills`:
- The origin is checked against `company/systems.json`. Only company systems are allowed.
- `PolicyGate.evaluate()` (`src/runtime/policy.ts`) walks `company/policies.json`. Rule `bills-over-50k` matches method, path and the condition `amount > 50000`. There is no grant for this fingerprint yet, so the decision is `require_approval`.
- The route answers `204 No Content`. Nothing reaches Kaira Books, and the page keeps the filled form.
- `report()` returns `errorKind: 'approval_required'` with the rule and the form fields.

Back in the loop, `onResult` calls `Operator.onExecutorResult()`. It labels codes with names (`S-1003 (Swift Cargo Movers)`), appends `approval.requested`, sets the status to `waiting_approval`, and calls `human.approve()`.

## 7. A person approves

The console polls nothing. It listens to `/api/stream` and re-reads `/api/runs/:id`. That shows `pendingApproval`, so `approvalCard()` renders the fields and the screenshot. Clicking **Approve** posts to `/api/runs/:id/approval`, and `WebHuman.resolve()` fulfils the waiting promise. The operator appends `approval.resolved`, calls `gate.addGrant({ ruleId, fingerprint })`, and injects the observation "APPROVED… submit the same form again without changing any value."

The model clicks Save again. The gate computes the same fingerprint, finds the unused grant, marks it used, and lets the request through. `onWrite` appends a `write` event that records the exact fields and the approval id. Kaira Books redirects to the new bill's page: "Bill BILL-0031 saved."

## 8. Finishing and checking

The model calls `finish { status: "done", summary, evidence }`. Because `finish` is a terminal tool, `runLoop()` returns it. `drive()` appends a `finish` event and calls `verify()`:
- A new `BrowserSession` with `PolicyGate([], { readOnly: true })`. Only sign-in POSTs pass.
- The tools are the browser without `fill_form`, the files and memory tools, and `verdict`.
- `verifierPrompt()` gives the criteria, the claims marked untrusted, the source documents, and `runtimeRecords()`: the approval, who granted it, and the exact POST that went out under it.
- The checker signs in, opens the bill, reads the PDF, writes what it saw into its notes, and returns a verdict per criterion.
- `verify()` forces `overall = pass` only if every criterion passed.

On a pass, `recordLearned()` saves any proposed facts as pending, then `end()` appends `run.finished` and `writeReport()` (`src/runtime/report.ts`) writes `report.md`.

## 9. If it had crashed

Run `pnpm op resume <id>`. `Operator.resume()` reopens the diary, appends `resumed`, re-adds grants for approvals already given, and continues the loop with a note that the browser is fresh and finished work should be checked before repeating it. Nothing in memory is needed except the diary.

## 10. Where to change things

| To… | Change |
|---|---|
| Add a kind of task | A procedure in `company/memory/procedures/` and its entry in `company/memory/seed.json`, plus any facts it needs |
| Add a company rule | An entry in `company/policies.json`. Add a test in `test/policy.test.ts`. |
| Add a system | `company/systems.json` and `company/vault.json`. The browser allowlist and login follow automatically. |
| Add a tool | A `Tool` in `src/tools/` and add it in `executorTools()` (and `verify()` if it is read-only) |
| Change the model | `OPERATOR_MODEL=opus` or `--model opus`. A new provider is a class implementing `Brain`. |
| Add a demo task with grading | `eval/scenarios.ts` |
