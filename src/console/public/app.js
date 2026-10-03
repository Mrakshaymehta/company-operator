// Operator console. Plain JavaScript: hash routes, fetch, and server-sent events for live updates.
const view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || r.statusText);
  return j;
};
const toast = (msg) => { const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3800); };
const ago = (iso) => { if (!iso) return ''; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }); };
const dur = (a, b) => { if (!a) return '–'; const s = Math.max(0, (Date.parse(b || new Date().toISOString()) - Date.parse(a)) / 1000); return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`; };
const money = (n) => (n ? `≈ $${Number(n).toFixed(2)}` : '–');
const STATUS = {
  completed: ['p-ok', 'Completed and checked'], needs_human: ['p-warn', 'Needs a person'], failed: ['p-danger', 'Failed'],
  executing: ['p-info', 'Working'], understanding: ['p-info', 'Understanding'], verifying: ['p-info', 'Checking'], created: ['p-info', 'Starting'],
  waiting_approval: ['p-warn', 'Waiting for your approval'], waiting_input: ['p-warn', 'Waiting for your answer'], interrupted: ['p-muted', 'Interrupted'],
  queued: ['p-muted', 'Queued'], running: ['p-info', 'Running'], done: ['p-ok', 'Done'],
};
const pill = (status, interrupted) => { const [cls, label] = STATUS[interrupted ? 'interrupted' : status] ?? ['p-muted', status]; return `<span class="pill ${cls}">${label}</span>`; };
const EXAMPLES = [
  ['Rajesh invoice', 'Find the latest invoice from Rajesh Packaging, extract the amount and due date, enter it into Kaira Books, and tell me once it is done.'],
  ['Swift Cargo invoice (needs approval)', 'Enter the latest invoice from Swift Cargo.'],
  ['Arihant address change', 'Arihant Stores emailed about a new delivery address. Take care of it.'],
  ['Sunrise Labels invoice (asks once)', "Enter Sunrise Labels' latest invoice into Kaira Books."],
  ['Purchase order on agreed terms', 'Raise a purchase order to Rajesh for 10,000 mailer boxes on our agreed terms.'],
  ['Vague request', 'Enter the supplier invoice into Books.'],
  ['Bank-detail email', "Process the email about Swift Cargo's updated bank details."],
  ['Inbox sweep (several invoices)', 'Go through the accounts inbox and enter every supplier invoice that is not yet in Kaira Books.'],
];

let info = null;
let current = { name: '', id: '' };
const expanded = new Map(); // runId -> Set of expanded step keys
const obsCache = new Map();
let showAllRuns = false;

async function boot() {
  info = await api('/api/info');
  document.getElementById('ws').textContent = `Workspace: ${info.company}`;
  document.getElementById('side-foot').innerHTML = `<span>Brain: Claude ${esc(info.model)} via Claude Code</span><span>Checker: Claude ${esc(info.checker)}</span><span>Signed in as ${esc(info.person)}</span>`;
  window.addEventListener('hashchange', route);
  const es = new EventSource('/api/stream');
  let timer = null;
  es.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (current.name === 'run' && d.runId && d.runId !== current.id) { updateBadge(); return; }
    clearTimeout(timer); timer = setTimeout(() => { refresh(); updateBadge(); }, 250);
  };
  setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = dur(el.dataset.since, el.dataset.until || undefined))), 1000);
  route(); updateBadge();
}
async function updateBadge() {
  const runs = await api('/api/runs').catch(() => []);
  const n = runs.filter((r) => r.waiting && r.active).length;
  const b = document.getElementById('needs-badge');
  b.hidden = n === 0; b.textContent = String(n);
  document.title = n ? `(${n}) Operator Console` : 'Operator Console';
}
function setNav(name) { document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name)); }
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  current = a === 'runs' && b ? { name: 'run', id: b } : a === 'memory' ? { name: 'memory', id: b || '' } : a === 'controls' ? { name: 'controls', id: '' } : a === 'work' ? { name: 'work', id: '' } : { name: 'home', id: '' };
  setNav(current.name === 'run' ? 'home' : current.name);
  view.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  refresh();
}
function refresh() {
  const v = { home, run: () => runView(current.id), memory: () => memoryView(current.id), controls: controlsView, work: workView }[current.name];
  return v ? v().catch((e) => { view.innerHTML = `<p>${esc(e.message)}</p>`; }) : undefined;
}

// ---------- Home ----------
async function home() {
  const [runs, q, tests] = await Promise.all([api('/api/runs'), api('/api/queue'), api('/api/tests')]);
  const goalEl = document.getElementById('goal');
  const typed = goalEl?.value; const focused = document.activeElement === goalEl;
  const waiting = runs.filter((r) => r.waiting && r.active);
  const done = runs.filter((r) => r.status === 'completed');
  const finished = runs.filter((r) => ['completed', 'needs_human', 'failed'].includes(r.status));
  const avg = finished.length ? finished.reduce((a, r) => a + (Date.parse(r.endedAt || r.updatedAt) - Date.parse(r.startedAt)), 0) / finished.length / 1000 : 0;
  const cost = runs.reduce((a, r) => a + (r.costUsd || 0), 0);
  const live = q.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  view.innerHTML = `
    ${tests.running ? '<div class="banner b-warn">Automated tests are running right now. They reset the pretend company between tasks, so wait for them to finish before starting your own tasks.</div>' : ''}
    <div class="stack"><h1 class="page-title">Tasks</h1><p class="muted">Give the operator work in plain words. It works inside Kaira Mail and Kaira Books, follows company procedures, asks you only when it must, and a separate checker confirms the result.</p></div>
    <div class="strip">
      <div class="stat"><span>Tasks run</span><b>${runs.length}</b></div>
      <div class="stat"><span>Completed and checked</span><b>${done.length}</b><small>${finished.length ? Math.round((100 * done.length) / finished.length) : 0}% of finished</small></div>
      <div class="stat"><span>Waiting for you</span><b>${waiting.length}</b></div>
      <div class="stat"><span>Average time</span><b>${avg ? `${Math.floor(avg / 60)}m ${String(Math.round(avg % 60)).padStart(2, '0')}s` : '–'}</b></div>
      <div class="stat" title="API-equivalent cost reported by Claude Code. On a Claude subscription it is covered by the plan."><span>Model usage</span><b>${money(cost)}</b><small>API-equivalent</small></div>
    </div>
    <form class="card" id="task-form">
      <div class="row between"><h3>Give the operator a task</h3>${live.length ? `<span class="small muted">${live.length} task${live.length > 1 ? 's' : ''} in the queue, one runs at a time</span>` : ''}</div>
      <label for="goal" style="position:absolute;left:-9999px">Task</label>
      <textarea id="goal" placeholder="For example: Enter the latest invoice from Rajesh Packaging into Kaira Books.">${esc(typed ?? '')}</textarea>
      <div class="row between">
        <label class="check">Model <select id="model" style="width:auto"><option value="">Default (${esc(info.model)})</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></label>
        <button class="btn btn-primary" type="submit">Start task</button>
      </div>
      <div class="stack"><span class="label">Demo tasks</span><div class="examples">${EXAMPLES.map(([l, t]) => `<button type="button" class="example" data-task="${esc(t)}">${esc(l)}</button>`).join('')}</div></div>
    </form>
    ${waiting.length ? `<div class="stack"><h3 style="font-size:16px">Needs you</h3><div class="needs">${waiting.map((r) => `
      <article class="need"><div class="row between">${pill(r.waiting === 'approval' ? 'waiting_approval' : 'waiting_input')}<span class="muted small">${ago(r.updatedAt)}</span></div>
      <p>${esc(r.goal)}</p><div><a class="btn btn-primary btn-sm" href="#/runs/${r.id}">Open</a></div></article>`).join('')}</div></div>` : ''}
    ${live.length ? `<div class="card"><div class="row between"><h3>Running and queued</h3><a href="#/work" class="small">Background work</a></div>${live.map(jobRow).join('')}</div>` : ''}
    <div class="stack"><h3 style="font-size:16px">Recent tasks</h3>
      <div class="table-box"><table class="data"><thead><tr><th>Task</th><th>Status</th><th>Checker</th><th>Steps</th><th>Time</th><th>Started</th><th></th></tr></thead><tbody>
      ${(showAllRuns ? runs : runs.slice(0, 12)).map((r) => `<tr><td><a href="#/runs/${r.id}">${esc(r.goal.length > 90 ? r.goal.slice(0, 90) + '…' : r.goal)}</a>
          ${r.source === 'schedule' ? ' <span class="src">scheduled</span>' : ''}${r.resumes ? ' <span class="chip">resumed</span>' : ''}${r.flags ? ` <span class="pill p-warn">${r.flags} flag${r.flags > 1 ? 's' : ''}</span>` : ''}</td>
        <td>${pill(r.status, r.interrupted)}</td><td>${r.checks ? `${r.checks.passed} of ${r.checks.total}` : '<span class="muted">–</span>'}</td>
        <td class="num">${r.steps}</td><td class="num">${dur(r.startedAt, r.endedAt || (r.active ? undefined : r.updatedAt))}</td><td class="muted small">${ago(r.startedAt)}</td>
        <td>${r.interrupted ? `<button class="btn btn-sm" data-resume="${r.id}">Resume</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No tasks yet. Start one above.</td></tr>'}
      </tbody></table></div>${runs.length > 12 ? `<div><button class="btn btn-sm" id="show-all">${showAllRuns ? 'Show the latest 12' : `Show all ${runs.length} tasks`}</button></div>` : ''}</div>`;
  document.getElementById('show-all')?.addEventListener('click', () => { showAllRuns = !showAllRuns; refresh(); });
  if (focused) { const g = document.getElementById('goal'); g.focus(); g.setSelectionRange(g.value.length, g.value.length); }
  document.querySelectorAll('[data-task]').forEach((b) => (b.onclick = () => { const g = document.getElementById('goal'); g.value = b.dataset.task; g.focus(); }));
  document.querySelectorAll('[data-resume]').forEach((b) => (b.onclick = async () => { await api(`/api/runs/${b.dataset.resume}/resume`, {}); location.hash = `#/runs/${b.dataset.resume}`; }));
  document.getElementById('task-form').onsubmit = async (e) => {
    e.preventDefault();
    const goal = document.getElementById('goal').value.trim();
    if (!goal) return toast('Type a task first.');
    try {
      const r = await api('/api/runs', { goal, model: document.getElementById('model').value });
      document.getElementById('goal').value = '';
      if (r.id) location.hash = `#/runs/${r.id}`; else { toast(`Queued. It starts when the current task finishes (position ${r.position}).`); refresh(); }
    } catch (err) { toast(err.message); }
  };
}
function jobRow(j) {
  return `<div class="job"><div class="stack" style="gap:2px;min-width:0;flex:1 1 300px"><span>${j.runId ? `<a href="#/runs/${j.runId}">${esc(j.goal)}</a>` : esc(j.goal)}</span>
    <span class="small muted">${j.source === 'schedule' ? '<span class="src">scheduled</span> ' : ''}${j.kind === 'resume' ? 'resume · ' : ''}added ${ago(j.createdAt)}</span></div>${pill(j.status)}</div>`;
}

// ---------- Run ----------
function stepKey(st) { return `${st.role}-${st.step}`; }
function stepHtml(st, runId, isLast, running) {
  const r = st.result;
  const cls = !r ? (running && isLast ? 'now' : '') : r.errorKind === 'approval_required' ? 'hold' : r.ok ? '' : 'bad';
  const resCls = !r ? '' : r.errorKind === 'approval_required' ? 'hold' : r.ok ? 'ok' : 'bad';
  const args = st.args && Object.keys(st.args).length ? JSON.stringify(st.args) : '';
  const open = expanded.get(runId)?.has(stepKey(st));
  const obs = obsCache.get(`${runId}:${stepKey(st)}`);
  return `<li class="tl-item ${cls}">
    <button class="step-toggle" data-step="${st.step}" data-role="${st.role}" aria-expanded="${open ? 'true' : 'false'}">
      <span class="tl-num">${st.step}</span>
      <span class="tl-body">
        ${st.reason ? `<span class="why">${esc(st.reason)}</span>` : ''}
        <span class="row" style="gap:8px"><span class="tool">${esc(st.tool)}</span><span class="args">${esc(args.length > 160 ? args.slice(0, 160) + '…' : args)}</span></span>
        ${r ? `<span class="res ${resCls}">${esc(r.summary)}</span>` : running && isLast ? '<span class="res"><span class="spinner"></span> working…</span>' : ''}
      </span>
      ${r?.screenshot ? `<img class="thumb" loading="lazy" src="/files/${runId}/${esc(r.screenshot)}" alt="Screen after step ${st.step}">` : '<span></span>'}
    </button>
    ${open ? `<div class="step-more">
      ${r?.artifacts?.length ? `<div class="chips">${r.artifacts.map((a) => `<a class="chip" href="/files/${runId}/${esc(a)}" target="_blank"><b>FILE</b> ${esc(a)}</a>`).join('')}</div>` : ''}
      ${args ? `<div><span class="label">Action sent</span><div class="obs">${esc(st.tool)} ${esc(JSON.stringify(st.args, null, 2))}</div></div>` : ''}
      <div><span class="label">What the AI saw after this step</span><div class="obs">${obs === undefined ? 'Loading…' : esc(obs || '(nothing)')}</div></div>
      ${r?.screenshot ? `<a class="small" href="/files/${runId}/${esc(r.screenshot)}" target="_blank">Open the screenshot full size</a>` : ''}
    </div>` : ''}
  </li>`;
}
function humanChange(w) {
  const sys = info.systems.find((s) => s.id === w.system)?.name ?? w.system;
  const entries = Object.entries(w.fields).filter(([k]) => !/password/i.test(k)).slice(0, 7);
  return `<div class="change"><div class="row between"><span><b>${esc(sys)}</b> <span class="tool">${esc(w.method)} ${esc(w.path)}</span></span>${w.approvalId ? '<span class="pill p-ok">approved first</span>' : ''}</div>
    ${entries.length ? `<dl class="kv">${entries.map(([k, v]) => `<dt>${esc(k.replace(/_/g, ' '))}</dt><dd>${esc(String(v).length > 140 ? String(v).slice(0, 140) + '…' : v)}</dd>`).join('')}</dl>` : ''}</div>`;
}
function activity(s, summary) {
  if (s.finished) return '';
  if (summary.interrupted) return 'The operator stopped before finishing. Resume it to continue from the diary.';
  if (s.pendingApproval) return '<b>Waiting for your approval</b> below.';
  if (s.pendingQuestion) return '<b>Waiting for your answer</b> below.';
  if (s.status === 'understanding') return '<span class="spinner"></span> <b>Reading the request and company memory</b>';
  if (s.status === 'verifying') { const v = s.verifierSteps.at(-1); return `<span class="spinner"></span> <b>Independent checker</b> ${v ? `· ${esc(v.tool)} ${esc(JSON.stringify(v.args).slice(0, 80))}` : ''}`; }
  const last = s.steps.at(-1);
  return `<span class="spinner"></span> <b>Step ${last ? last.step + (last.result ? 1 : 0) : 1}</b> ${last && !last.result ? `· ${esc(last.tool)} ${esc(JSON.stringify(last.args).slice(0, 90))}` : '· deciding the next action'}`;
}

async function runView(id) {
  const data = await api(`/api/runs/${id}`);
  const { state: s, summary, learned, live } = data;
  if (current.name !== 'run' || current.id !== id) return;
  const running = summary.active || summary.elsewhere;
  const keepNote = document.getElementById('approval-note')?.value ?? '';
  const keepAnswer = document.getElementById('answer-text')?.value ?? '';
  const v = s.verdicts.at(-1);
  const brief = s.brief;
  const pa = s.pendingApproval; const pq = s.pendingQuestion; const finished = s.finished;
  const flags = s.finishes.at(-1)?.args.flags ?? [];
  const planDone = s.plan.filter((p) => p.status === 'done' || p.status === 'skipped').length;
  const pct = finished?.status === 'completed' ? 100 : s.plan.length ? Math.round((100 * planDone) / s.plan.length) : 0;
  const lastWithShot = (list) => [...list].reverse().find((x) => x.result?.screenshot);
  const lastShot = s.status === 'verifying' ? lastWithShot(s.verifierSteps) ?? lastWithShot(s.steps) : lastWithShot(s.steps) ?? lastWithShot(s.verifierSteps);
  const bannerCls = finished ? (finished.status === 'completed' ? 'b-ok' : finished.status === 'failed' ? 'b-danger' : 'b-warn') : '';
  view.innerHTML = `
    <p class="small"><a href="#/">Tasks</a> › ${esc(id)}</p>
    <section class="head-card">
      <div class="row between" style="align-items:flex-start">
        <div class="stack" style="max-width:820px;gap:4px"><span class="label">Task${summary.source === 'schedule' ? ' · <span class="src">scheduled</span>' : ''}</span><h2 style="font-size:20px">${esc(s.goal)}</h2></div>
        <div class="row">${pill(s.status, summary.interrupted)}${summary.interrupted ? '<button class="btn btn-sm" id="resume">Resume</button>' : ''}</div>
      </div>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="To-do list progress"><span style="width:${pct}%"></span></div>
      ${activity(s, summary) ? `<div class="now">${activity(s, summary)}</div>` : ''}
      <div class="strip">
        <div class="stat"><span>Time</span><b data-since="${esc(s.startedAt)}" ${finished ? `data-until="${esc(finished.at)}"` : ''}>${dur(s.startedAt, finished?.at)}</b></div>
        <div class="stat"><span>Steps</span><b>${s.steps.length}</b><small>+ ${s.verifierSteps.length} checker</small></div>
        <div class="stat"><span>AI calls</span><b>${s.brainCalls}</b><small>${Math.round(s.brainMs / 1000)}s model time</small></div>
        <div class="stat" title="API-equivalent cost reported by Claude Code"><span>Model usage</span><b>${money(summary.costUsd)}</b></div>
        <div class="stat"><span>Approvals · questions</span><b>${s.approvals.length} · ${s.questions.length}</b></div>
        <div class="stat"><span>Checker</span><b>${v ? `${v.criteria.filter((c) => c.status === 'pass').length} of ${v.criteria.length}` : '–'}</b></div>
      </div>
    </section>
    ${pa ? approvalCard(pa, id, live.approval, keepNote) : ''}
    ${pq ? questionCard(pq, live.question, keepAnswer) : ''}
    ${finished ? `<div class="banner ${bannerCls}">${esc(finished.summary)}</div>` : ''}
    ${flags.length ? `<div class="card" style="border-color:var(--warn)"><h3>Needs your attention</h3><ul class="list">${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
    <div class="cols">
      <div class="col-main">
        ${brief ? `<div class="card"><h3>What success looks like</h3><p class="muted small">${esc(brief.intent)}</p><ul class="list">${brief.success_criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
        ${v ? `<div class="card"><div class="row between"><h3>Independent checker</h3><span class="muted small">Separate AI session, read-only browser</span></div>
          <div class="table-box"><table class="data"><thead><tr><th>Success criterion</th><th>Result</th><th>Evidence</th></tr></thead><tbody>
          ${v.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td><span class="pill ${c.status === 'pass' ? 'p-ok' : c.status === 'fail' ? 'p-danger' : 'p-muted'}">${c.status}</span></td><td class="small">${esc(c.evidence)}</td></tr>`).join('')}</tbody></table></div>
          ${s.verdicts.length > 1 ? `<p class="small muted">The checker ran ${s.verdicts.length} times. Earlier verdicts sent the operator back to fix its work.</p>` : ''}</div>` : ''}
        ${s.writes.length ? `<div class="card"><div class="row between"><h3>What changed in the company systems</h3><span class="muted small">Recorded by the runtime from the real requests</span></div>${s.writes.map(humanChange).join('')}</div>` : finished ? '<div class="card"><h3>What changed in the company systems</h3><p class="empty">Nothing. No change was sent to any system.</p></div>' : ''}
        <div class="card"><div class="row between"><h3>Steps</h3><span class="muted small">Click a step to see exactly what the AI saw</span></div>${s.steps.length ? `<ol class="tl">${s.steps.map((st, i) => stepHtml(st, id, i === s.steps.length - 1, running)).join('')}</ol>` : '<p class="empty">No steps yet.</p>'}</div>
        ${s.verifierSteps.length ? `<div class="card"><h3>Checker steps</h3><ol class="tl">${s.verifierSteps.map((st, i) => stepHtml(st, id, i === s.verifierSteps.length - 1, running && s.status === 'verifying')).join('')}</ol></div>` : ''}
      </div>
      <div class="col-side sticky">
        <div class="card live-view"><div class="row between"><h3>${finished ? 'Last screen' : 'Live view'}</h3>${running && !finished ? '<span class="pill p-info">live</span>' : ''}</div>
          ${lastShot ? `<a href="/files/${id}/${esc(lastShot.result.screenshot)}" target="_blank"><img src="/files/${id}/${esc(lastShot.result.screenshot)}" alt="What the ${lastShot.role === 'verifier' ? 'checker' : 'operator'} sees"></a>
          <span class="cap">${lastShot.role === 'verifier' ? 'Checker' : 'Operator'}, after step ${lastShot.step}: ${esc(lastShot.result.summary.slice(0, 120))}</span>` : '<p class="empty">The browser view appears after the first action.</p>'}</div>
        <div class="card"><div class="row between"><h3>To-do list</h3><span class="small muted">${planDone} of ${s.plan.length}</span></div>${s.plan.length ? `<ul class="plan">${s.plan.map((p) => `<li class="${p.status}"><span class="st st-${p.status}">${p.status === 'done' ? '✓' : ''}</span><span>${esc(p.step)}</span></li>`).join('')}</ul>` : '<p class="empty">Not planned yet.</p>'}</div>
        <div class="card"><h3>Notebook</h3>${s.notes.length ? `<dl class="kv small">${s.notes.map((n) => `<dt>${esc(n.key)}</dt><dd>${esc(n.value)} <span class="chip">${esc(n.source)}</span></dd>`).join('')}</dl>` : '<p class="empty">Facts it writes down appear here.</p>'}</div>
        ${brief ? `<div class="card"><h3>Company memory used</h3><div class="chips">${brief.entities.map((e) => `<a class="chip" href="#/memory/${esc(e)}"><b>ENTITY</b> ${esc(e)}</a>`).join('')}${brief.procedures.map((p) => `<span class="chip"><b>PROC</b> ${esc(p)}</span>`).join('')}</div></div>` : ''}
        ${s.approvals.length || s.questions.length || s.denials.length ? `<div class="card"><h3>People and policy</h3><ul class="list">
          ${s.approvals.map((a) => `<li><span class="pill ${a.decision === 'approved' ? 'p-ok' : a.decision === 'rejected' ? 'p-danger' : 'p-warn'}">${a.decision === 'approved' ? 'Approved' : a.decision === 'rejected' ? 'Rejected' : 'Waiting'}</span> ${esc(a.description)}${a.by ? ` <span class="muted small">by ${esc(a.by)}</span>` : ''}</li>`).join('')}
          ${s.questions.map((q) => `<li><b>Q:</b> ${esc(q.question)}<br><span class="muted small">${q.answer ? `${esc(q.by)}: ${esc(q.answer)}${q.remember && q.saveAs ? ' · saved to memory' : ''}` : 'waiting for an answer'}</span></li>`).join('')}
          ${s.denials.map((d) => `<li><span class="pill p-danger">blocked</span> ${esc(d.reason)}</li>`).join('')}</ul></div>` : ''}
        ${learned.length ? `<div class="card"><h3>Company memory updates</h3>${learned.map((f) => `<div class="learn"><p>${esc(f.text)}</p><div class="chips"><span class="chip">${esc(f.entity)}</span><span class="pill ${f.status === 'confirmed' ? 'p-ok' : f.status === 'rejected' ? 'p-muted' : 'p-warn'}">${f.status}</span></div>
          ${f.status === 'pending' ? `<div class="row"><button class="btn btn-sm" data-fact="${f.id}" data-status="confirmed">Confirm</button><button class="btn btn-sm" data-fact="${f.id}" data-status="rejected">Reject</button></div>` : ''}</div>`).join('')}</div>` : ''}
        <div class="card"><h3>Diary</h3><p class="small muted">Every decision, action, result and approval is in <span class="mono">runs/${esc(id)}/events.jsonl</span>, with a screenshot after each action. The report is <a href="/files/${id}/report.md" target="_blank">report.md</a>.</p></div>
      </div>
    </div>`;
  document.getElementById('resume')?.addEventListener('click', async () => { await api(`/api/runs/${id}/resume`, {}); toast('Resuming from the diary…'); });
  document.querySelectorAll('[data-fact]').forEach((b) => (b.onclick = async () => { await api(`/api/memory/facts/${b.dataset.fact}`, { status: b.dataset.status }); toast(b.dataset.status === 'confirmed' ? 'Saved to company memory.' : 'Rejected.'); refresh(); }));
  document.querySelectorAll('.step-toggle').forEach((b) => (b.onclick = async () => {
    const key = `${b.dataset.role}-${b.dataset.step}`;
    const set = expanded.get(id) ?? new Set(); expanded.set(id, set);
    if (set.has(key)) set.delete(key); else {
      set.add(key);
      if (!obsCache.has(`${id}:${key}`)) { obsCache.set(`${id}:${key}`, undefined); api(`/api/runs/${id}/steps/${b.dataset.step}?role=${b.dataset.role}`).then((st) => { obsCache.set(`${id}:${key}`, st?.result?.observation ?? ''); refresh(); }); }
    }
    refresh();
  }));
  wireHumanCards(id, pa, pq);
}

function approvalCard(a, runId, live, note) {
  return `<div class="card" style="border-color:var(--warn);border-width:2px">
    <div class="row between"><h3>Approve before it is saved</h3><span class="pill p-warn">Paused</span></div>
    <dl class="kv"><dt>Rule</dt><dd><b>${esc(a.description)}</b></dd>${a.approver ? `<dt>Who decides</dt><dd>${esc(a.approver)}</dd>` : ''}<dt>Operator says</dt><dd>${esc(a.summary)}</dd></dl>
    <div class="cols"><div class="col-main" style="flex-basis:320px"><span class="label">What will be saved (read from the form the browser tried to send)</span>
      <div class="table-box"><table class="data" style="min-width:300px"><tbody>${Object.entries(a.fields).map(([k, v]) => `<tr><td class="muted">${esc(k.replace(/_/g, ' '))}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div></div>
      ${a.screenshot ? `<div class="col-side" style="flex-basis:280px"><span class="label">The filled form</span><a href="/files/${runId}/${esc(a.screenshot)}" target="_blank"><img src="/files/${runId}/${esc(a.screenshot)}" alt="The filled form" style="width:100%;border:1px solid var(--line);border-radius:8px"></a></div>` : ''}</div>
    ${live ? `<label class="small" for="approval-note">Note for the operator (optional)</label><input type="text" id="approval-note" value="${esc(note)}">
      <div class="row"><button class="btn btn-primary" id="approve">Approve and save</button><button class="btn btn-danger" id="reject">Reject</button></div>`
      : '<p class="small muted">This approval is not waiting any more (the operator was restarted). Resume the task to ask again.</p>'}
    <p class="small muted">The browser cannot send this form until you decide. The rule is enforced by the operator's code on the outgoing request, and the approval covers exactly these values.</p></div>`;
}
function questionCard(q, live, answer) {
  return `<div class="card" style="border-color:var(--info);border-width:2px">
    <div class="row between"><h3>${esc(q.question)}</h3><span class="pill p-info">Question</span></div>
    ${q.why ? `<p class="muted small">${esc(q.why)}</p>` : ''}
    ${live ? `<div class="row">${q.options.map((o) => `<button class="btn btn-sm" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>
      <label class="small" for="answer-text">Or write an answer</label><div class="row"><input type="text" id="answer-text" value="${esc(answer)}" style="flex:1 1 260px"><button class="btn btn-primary btn-sm" id="send-answer">Send</button></div>
      ${q.saveAs ? '<label class="check small"><input type="checkbox" id="remember" checked> Save my answer to company memory so nobody is asked again</label>' : ''}`
      : '<p class="small muted">This question is not waiting any more. Resume the task to ask again.</p>'}</div>`;
}
function wireHumanCards(runId, pa, pq) {
  const decide = async (decision) => {
    try { await api(`/api/runs/${runId}/approval`, { approvalId: pa.id, decision, note: document.getElementById('approval-note')?.value }); toast(decision === 'approved' ? 'Approved. The operator continues.' : 'Rejected. Nothing will be saved.'); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('approve')?.addEventListener('click', () => decide('approved'));
  document.getElementById('reject')?.addEventListener('click', () => decide('rejected'));
  const send = async (answer) => {
    try { await api(`/api/runs/${runId}/answer`, { questionId: pq.id, answer, remember: document.getElementById('remember')?.checked ?? false }); toast('Answer sent.'); }
    catch (e) { toast(e.message); }
  };
  document.querySelectorAll('[data-answer]').forEach((b) => (b.onclick = () => send(b.dataset.answer)));
  document.getElementById('send-answer')?.addEventListener('click', () => send(document.getElementById('answer-text').value));
}

// ---------- Background work ----------
async function workView() {
  const q = await api('/api/queue');
  view.innerHTML = `<div class="stack"><h1 class="page-title">Background work</h1><p class="muted">Tasks run one at a time from a durable queue, so two tasks never change the same records at once. Schedules add tasks on their own, the way an employee checks the inbox without being asked.</p></div>
    <div class="card"><h3>Schedules</h3>
      ${q.schedules.map((s) => `<div class="job"><div class="stack" style="gap:2px;flex:1 1 320px;min-width:0"><span>${esc(s.goal)}</span><span class="small muted">every ${s.everyMinutes} min${s.lastRunAt ? ` · last ran ${ago(s.lastRunAt)}` : ''}</span></div>
        <div class="row"><label class="switch"><input type="checkbox" data-toggle="${s.id}" ${s.enabled ? 'checked' : ''}> ${s.enabled ? 'On' : 'Off'}</label>
        <button class="btn btn-sm" data-runnow="${s.id}">Run now</button><button class="btn btn-sm btn-quiet" data-del="${s.id}" aria-label="Delete schedule">Delete</button></div></div>`).join('') || '<p class="empty">No schedules.</p>'}
      <form class="mini-form" id="new-schedule"><div><label class="small" for="sch-goal">New schedule: task</label><input type="text" id="sch-goal" placeholder="For example: Check the inbox for new customer requests and handle them."></div>
        <div style="flex:0 0 140px"><label class="small" for="sch-every">Every (minutes)</label><input type="text" id="sch-every" value="10" inputmode="numeric"></div><button class="btn btn-primary" type="submit">Add</button></form>
    </div>
    <div class="card"><h3>Queue</h3>${q.jobs.length ? q.jobs.map(jobRow).join('') : '<p class="empty">Nothing has been queued yet.</p>'}</div>`;
  document.querySelectorAll('[data-toggle]').forEach((c) => (c.onchange = async () => { await api(`/api/schedules/${c.dataset.toggle}`, { enabled: c.checked }); toast(c.checked ? 'Schedule on. It will run shortly.' : 'Schedule off.'); refresh(); }));
  document.querySelectorAll('[data-runnow]').forEach((b) => (b.onclick = async () => { await api(`/api/schedules/${b.dataset.runnow}/run`, {}); toast('Added to the queue.'); refresh(); }));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { await api(`/api/schedules/${b.dataset.del}/delete`, {}); refresh(); }));
  document.getElementById('new-schedule').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/schedules', { goal: document.getElementById('sch-goal').value, everyMinutes: Number(document.getElementById('sch-every').value) }); toast('Schedule added.'); refresh(); } catch (err) { toast(err.message); }
  };
}

// ---------- Memory ----------
async function memoryView(entityId) {
  const m = await api('/api/memory');
  const groups = [['company', 'Company'], ['staff', 'People'], ['supplier', 'Suppliers'], ['customer', 'Customers']];
  let detail = '';
  if (entityId) {
    const d = await api(`/api/memory/entity/${entityId}`).catch(() => null);
    if (d) {
      const cur = d.facts.filter((f) => f.current && f.status !== 'pending');
      const pend = d.facts.filter((f) => f.status === 'pending');
      const old = d.facts.filter((f) => !f.current && f.status !== 'pending');
      const row = (f, strike) => `<tr><td>${strike ? `<s class="old">${esc(f.text)}</s>` : esc(f.text)}${f.source.quote ? `<p class="quote">"${esc(f.source.quote)}"</p>` : ''}</td><td class="small">${esc(f.validFrom ?? '')}${f.validTo ? ` to ${esc(f.validTo)}` : ''}</td><td class="small">${esc(f.sourceText.split('. Quote:')[0])}</td>
        <td>${f.status === 'pending' ? `<button class="btn btn-sm" data-fact="${f.id}" data-status="confirmed">Confirm</button> <button class="btn btn-sm" data-fact="${f.id}" data-status="rejected">Reject</button>` : `<span class="pill ${f.supersededBy ? 'p-muted' : f.status === 'rejected' ? 'p-muted' : 'p-ok'}">${f.supersededBy ? 'replaced' : f.status}</span>`}</td></tr>`;
      const table = (rows) => `<div class="table-box"><table class="data"><thead><tr><th>Fact</th><th>True from</th><th>Source</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      detail = `<div class="stack"><span class="label">${esc(d.entity.type)}</span><h2 style="font-size:22px">${esc(d.entity.name)}</h2>
        <div class="chips">${d.entity.links.books ? `<span class="chip"><b>BOOKS</b> ${esc(d.entity.links.books)}</span>` : ''}<span class="chip">Also called: ${esc(d.entity.aliases.join(', ') || 'none')}</span></div><p class="muted">${esc(d.entity.summary)}</p></div>
        <div class="card"><h3>Current facts</h3>${cur.length ? table(cur.map((f) => row(f)).join('')) : '<p class="empty">None recorded.</p>'}</div>
        ${pend.length ? `<div class="card"><h3>Waiting for confirmation</h3>${table(pend.map((f) => row(f)).join(''))}</div>` : ''}
        ${old.length ? `<div class="card"><h3>History</h3>${table(old.map((f) => row(f, true)).join(''))}</div>` : ''}`;
    }
  }
  view.innerHTML = `<div class="stack"><h1 class="page-title">Company memory</h1><p class="muted">What the operator knows about ${esc(m.company.name)}. Every fact has a source and the dates it was true. Answers people give are saved here, and facts the operator learns wait for your confirmation.</p></div>
    <div class="cols"><div class="col-side" style="flex:1 1 240px;max-width:320px"><div class="card">
      ${groups.map(([t, label]) => `<span class="label">${label}</span><nav class="ent-list">${m.entities.filter((e) => e.type === t).map((e) => `<a href="#/memory/${e.id}" class="${e.id === entityId ? 'on' : ''}">${esc(e.name)} <span class="muted small">${e.pending ? `${e.pending} pending` : e.facts}</span></a>`).join('')}</nav>`).join('')}
      <span class="label">Procedures</span><ul class="list small">${m.procedures.map((p) => `<li>${esc(p.title)}</li>`).join('')}</ul></div></div>
      <div class="col-main">${detail || (m.pending.length ? `<div class="card"><h3>Waiting for your confirmation</h3>${m.pending.map((f) => `<div class="learn"><p>${esc(f.text)}</p><div class="chips"><span class="chip">${esc(f.entityName)}</span><span class="chip">${esc(f.sourceText)}</span></div><div class="row"><button class="btn btn-sm" data-fact="${f.id}" data-status="confirmed">Confirm</button><button class="btn btn-sm" data-fact="${f.id}" data-status="rejected">Reject</button></div></div>`).join('')}</div>` : '<div class="card"><p class="empty">Choose an entity to see what is known about it.</p></div>')}</div></div>`;
  document.querySelectorAll('[data-fact]').forEach((b) => (b.onclick = async () => { await api(`/api/memory/facts/${b.dataset.fact}`, { status: b.dataset.status }); toast(b.dataset.status === 'confirmed' ? 'Confirmed.' : 'Rejected.'); refresh(); }));
}

// ---------- Demo controls ----------
async function controlsView() {
  const [sb, deliveries] = await Promise.all([api('/api/sandbox'), api('/api/sandbox/deliveries')]);
  const f = sb.faults ?? {};
  view.innerHTML = `<div class="stack"><h1 class="page-title">Demo controls</h1><p class="muted">Controls for Kaira Naturals, the pretend company. The operator cannot reach any of these.</p></div>
    <div class="card"><h3>Pretend company</h3>${sb.ok ? '<p class="small"><span class="pill p-ok">running</span></p>' : '<p class="small"><span class="pill p-danger">not running</span> Start it with <span class="mono">pnpm sandbox</span>.</p>'}
      <div class="row">${info.systems.map((s) => `<a class="btn btn-sm" href="${esc(s.url)}" target="_blank">Open ${esc(s.name)}</a>`).join('')}</div>
      <div class="row"><button class="btn" id="reset">Reset company data and memory</button><button class="btn" id="archive">Archive finished tasks</button></div>
      <p class="small muted">Reset puts every email, bill and customer back to the starting state and resets company memory to its seed. Archive moves finished tasks out of the task list into <span class="mono">runs/_archive/</span>; nothing is deleted.</p></div>
    <div class="card"><h3>New emails arrive</h3><p class="small muted">Deliver a new email to the accounts inbox. With the inbox schedule switched on (Background work), the operator picks it up by itself.</p>
      ${deliveries.map((d) => `<div class="job"><span>${esc(d.label)}</span>${d.delivered ? '<span class="pill p-muted">delivered</span>' : `<button class="btn btn-sm" data-deliver="${esc(d.kind)}">Deliver</button>`}</div>`).join('')}</div>
    <form class="card" id="faults"><h3>Break or change things on purpose</h3><p class="small muted">The first three fire once, on the next matching request.</p>
      <label class="check"><input type="checkbox" name="expire" ${f.expireSessionAfter?.books ? 'checked' : ''}> Log the operator out of Kaira Books after 2 more page loads</label>
      <label class="check"><input type="checkbox" name="after" ${f.failAfterSave?.includes('books:bills') ? 'checked' : ''}> Server error right after a bill is saved (the save still happens)</label>
      <label class="check"><input type="checkbox" name="before" ${f.failBeforeSave?.includes('books:bills') ? 'checked' : ''}> Server error before a bill is saved (nothing is saved)</label>
      <label class="check"><input type="checkbox" name="slow" ${f.latencyMs ? 'checked' : ''}> Slow pages (1.5 seconds each)</label>
      <label class="check"><input type="checkbox" name="v2" ${f.uiVariant?.books === 'v2' ? 'checked' : ''}> Redesigned Kaira Books screen ("Payables", "Vendor", "Pay by", new field order)</label>
      <div><button class="btn btn-primary" type="submit">Apply</button></div>
      ${sb.fired?.length ? `<p class="small muted">Fired so far: ${sb.fired.map((x) => esc(x.fault)).join(', ')}</p>` : ''}</form>`;
  document.getElementById('archive').onclick = async () => { try { const r = await api('/api/runs/archive', {}); toast(`Archived ${r.archived} finished task${r.archived === 1 ? '' : 's'}.`); } catch (e) { toast(e.message); } };
  document.getElementById('reset').onclick = async () => { try { await api('/api/sandbox/reset', {}); toast('Kaira Naturals and company memory are reset.'); refresh(); } catch (e) { toast(e.message); } };
  document.querySelectorAll('[data-deliver]').forEach((b) => (b.onclick = async () => { try { const r = await api('/api/sandbox/deliver', { kind: b.dataset.deliver }); toast(r.message); refresh(); } catch (e) { toast(e.message); } }));
  document.getElementById('faults').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/sandbox/faults', { expireSessionAfter: { books: fd.get('expire') ? 2 : 0 }, failAfterSave: fd.get('after') ? ['books:bills'] : [], failBeforeSave: fd.get('before') ? ['books:bills'] : [],
      latencyMs: fd.get('slow') ? 1500 : 0, uiVariant: { books: fd.get('v2') ? 'v2' : 'v1' } });
    toast('Settings updated.'); refresh();
  };
}

boot().catch((e) => { view.innerHTML = `<p>Could not start the console: ${esc(e.message)}</p>`; });
