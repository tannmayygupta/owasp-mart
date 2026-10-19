// The demo console of the VulnMart lab (production readiness story 9.5). One page, no dependencies, no inline script (the page's CSP forbids it).
// It is a stand-in for the learner dashboards of stream P (P-26): it only calls the documented browser routes of IF-1 and IF-2 on its own origin.
// Everything the server sends is put on the page with textContent, never as HTML.
const $ = (id) => document.getElementById(id);
const state = { csrf: null, user: null, attempt: null, instance: null, catalog: [], poll: null, timer: null, opened: new Set(), details: {}, hints: {}, progress: [] };

// ---------- the API ----------
async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (state.csrf) headers['x-csrf-token'] = state.csrf;
  }
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  let data = null;
  if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
  if (!res.ok) { const e = new Error(data?.code || `HTTP ${res.status}`); e.status = res.status; e.code = data?.code; e.body = data; throw e; }
  return data;
}

const MESSAGES = {
  'AUTH-INVALID-CREDENTIALS': 'That email and password do not match.', 'AUTH-EMAIL-NOT-VERIFIED': 'Confirm your email first (the link we sent).',
  'AUTH-SESSION-REQUIRED': 'Please sign in again.', 'REQ-RATE-LIMITED': 'Too many tries. Wait a little and try again.', 'REQ-VALIDATION': 'Something in the form is not valid.',
  'INST-QUOTA-REACHED': 'You already have a running instance.', 'INST-NOT-READY': 'The instance is not ready yet.', 'INST-INVALID-STATE': 'That cannot be done in the instance\'s state now.',
  'INST-START-FAILED': 'The lab could not start an instance. Try again in a moment.', 'ATT-INVALID-STATE': 'That cannot be done in the attempt\'s state now.',
  'ATT-FLAG-RATE-LIMITED': 'Too many wrong flags for this challenge. Wait a few minutes.', 'ATT-GONE': 'That attempt is closed.', 'AUTH-CSRF-FAILED': 'Your session changed. Reload the page.',
};
const say = (code) => MESSAGES[code] || `Something went wrong (${code}).`;
function banner(text, kind) { const b = $('banner'); b.textContent = text || ''; b.className = kind || ''; b.hidden = !text; }

// ---------- views ----------
function show(view) { for (const v of ['auth', 'verify', 'lab']) $(v).hidden = v !== view; $('who').hidden = view !== 'lab'; }
function tab(which) {
  $('login-form').hidden = which !== 'login'; $('signup-form').hidden = which !== 'signup';
  $('tab-login').className = which === 'login' ? 'on' : ''; $('tab-signup').className = which === 'signup' ? 'on' : '';
}

async function boot() {
  $('tab-login').addEventListener('click', () => tab('login'));
  $('tab-signup').addEventListener('click', () => tab('signup'));
  $('login-form').addEventListener('submit', onLogin);
  $('signup-form').addEventListener('submit', onSignup);
  $('logout').addEventListener('click', onLogout);
  $('start').addEventListener('click', onStart);
  $('open').addEventListener('click', onOpen);
  $('copy').addEventListener('click', onCopy);
  $('reset').addEventListener('click', onReset);
  $('stop').addEventListener('click', onStop);
  $('submit').addEventListener('click', onSubmit);
  $('report').addEventListener('click', onReport);
  if (location.pathname === '/verify-email') return verifyEmail();
  try {
    const s = await api('GET', '/api/v1/session');
    if (s.status === 'authenticated') return enter(s);
  } catch { /* not signed in */ }
  show('auth'); tab('login');
}

async function verifyEmail() {
  show('verify');
  const token = new URLSearchParams(location.search).get('token') || '';
  try { await api('POST', '/api/v1/accounts/verify-email', { token }); $('verify-text').textContent = 'Your email is confirmed. You can sign in now.'; }
  catch { $('verify-text').textContent = 'This link was already used or has expired. Sign in, or ask for a new link.'; }
  history.replaceState(null, '', '/verify-email');
}

async function onSignup(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  try {
    await api('POST', '/api/v1/accounts', { email: f.get('email'), password: f.get('password'), display_name: f.get('display_name'), age_declaration: f.get('age') === 'on' });
    banner('Check your email for the confirmation link, then sign in.', 'ok'); tab('login');
  } catch (e) { banner(say(e.code), 'bad'); }
}

async function onLogin(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  try {
    const s = await api('POST', '/api/v1/session', { email: f.get('email'), password: f.get('password') });
    if (s.status === 'mfa_required') return banner('This account needs a second factor, which this console does not handle.', 'bad');
    ev.target.reset(); banner(''); enter(s);
  } catch (e) { banner(say(e.code), 'bad'); }
}

async function onLogout() {
  try { await api('DELETE', '/api/v1/session'); } catch { /* the session may be gone already */ }
  clearInterval(state.poll); clearInterval(state.timer);
  Object.assign(state, { csrf: null, user: null, attempt: null, instance: null, opened: new Set(), details: {}, hints: {}, progress: [] });
  $('link-box').hidden = true;
  show('auth'); tab('login'); banner('Signed out.', 'ok');
}

async function enter(session) {
  state.csrf = session.csrf_token; state.user = session.user;
  $('who-name').textContent = session.user.display_name;
  show('lab');
  try { state.catalog = (await api('GET', '/api/v1/challenges')).items; } catch { state.catalog = []; }
  await refresh();
}

// ---------- the lab ----------
async function currentAttempt() {
  const mine = (await api('GET', '/api/v1/me/attempts')).items;
  return mine.find((a) => ['ready', 'running', 'submitted', 'reported'].includes(a.state)) || mine[0] || null;
}

async function refresh() {
  try {
    const mine = await currentAttempt();
    state.attempt = mine ? await api('GET', `/api/v1/attempts/${mine.attempt_id}`) : null;
    state.instance = state.attempt?.instance_id ? await api('GET', `/api/v1/instances/${state.attempt.instance_id}`).catch(() => null) : null;
    render();
    if (state.attempt && ['running', 'ready', 'submitted'].includes(state.attempt.state)) await loadProgress();
    if (state.attempt) await loadTimeline();
  } catch (e) { if (e.status === 401) { banner(say('AUTH-SESSION-REQUIRED'), 'bad'); show('auth'); } else banner(say(e.code), 'bad'); }
  schedule();
}

function schedule() {
  clearInterval(state.poll);
  const busy = state.instance && !['ready', 'active', 'idle', 'destroyed', 'failed'].includes(state.instance.state);
  const waiting = state.attempt && state.attempt.state === 'ready';
  if (busy || waiting) state.poll = setInterval(refresh, 2000);
  clearInterval(state.timer);
  state.timer = setInterval(tickClock, 1000);
}

function tickClock() {
  const a = state.attempt;
  if (!a || a.state !== 'running' || !a.deadline_at) { $('a-left').textContent = a?.state === 'submitted' ? 'finished' : '-'; return; }
  const left = Math.max(0, Math.round((Date.parse(a.deadline_at) - Date.now()) / 1000));
  $('a-left').textContent = `${Math.floor(left / 3600)}h ${String(Math.floor(left / 60) % 60).padStart(2, '0')}m ${String(left % 60).padStart(2, '0')}s (the server decides)`;
}

function render() {
  const a = state.attempt; const i = state.instance;
  const live = a && ['ready', 'running'].includes(a.state);
  // the start button shows when there is no attempt, or the attempt can still run but has no live instance (stopped or failed)
  const canStart = !a || (['ready', 'running'].includes(a.state) && (!i || ['destroyed', 'failed'].includes(i.state)));  // a cancelled, withdrawn, submitted or reported attempt cannot start again: the API answers ATT-INVALID-STATE (one attempt per challenge set)
  $('no-instance').hidden = !canStart;
  $('instance').hidden = !a; $('instance-actions').hidden = !live || !i;
  if (a) {
    $('a-state').textContent = a.state; $('i-state').textContent = i ? `${i.state} (${i.access})` : 'none'; $('i-epoch').textContent = i ? String(i.epoch) : '-';
  }
  const ready = i && ['ready', 'active', 'idle'].includes(i.state) && i.access === 'open' && a?.state === 'running';
  $('open').disabled = !ready; $('reset').disabled = !ready; $('stop').disabled = !i || ['stopping', 'destroyed'].includes(i?.state);
  $('submit').disabled = a?.state !== 'running';
  $('start').disabled = false;
  $('report').hidden = !a || !['submitted', 'reported', 'running'].includes(a.state) || a.state === 'ready';
  $('copy').disabled = !ready;
  steps();
  tickClock();
}

// the four steps of a first session, from what the lab already knows
function steps() {
  const a = state.attempt; const i = state.instance;
  const started = Boolean(a) && Boolean(i) && !['destroyed', 'failed'].includes(i.state);
  const some = state.progress.some((p) => p.best_milestone !== 'none');
  const captured = state.progress.some((p) => p.solved);
  const done = [started, state.opened.has('shop') || some || captured, some || captured, captured];
  const nowIdx = done.findIndex((d) => !d);
  [1, 2, 3, 4].forEach((n) => { $(`step-${n}`).className = done[n - 1] ? 'done' : (n - 1 === nowIdx ? 'now' : ''); });
}

async function loadProgress() {
  const id = state.attempt.attempt_id;
  const [score, progress] = await Promise.all([api('GET', `/api/v1/attempts/${id}/score`), api('GET', `/api/v1/attempts/${id}/challenges`)]);
  state.progress = progress.items;
  $('score').textContent = String(score.score);
  const got = progress.items.filter((p) => p.solved).length;
  $('bar-fill').style.width = `${Math.min(100, Math.round(score.score / 10))}%`;
  $('captured').textContent = `${got} of ${progress.items.length} challenges captured`;
  $('score-note').textContent = score.per_challenge.some((c) => c.held) ? 'A capture is waiting for a human review and is not counted yet.' : '';
  const pts = Object.fromEntries(score.per_challenge.map((c) => [c.challenge_key, c.points]));
  const info = Object.fromEntries(state.catalog.map((c) => [c.challenge_key, c]));
  const rows = $('rows');
  for (const p of progress.items) renderChallenge(rows, p, info[p.challenge_key], pts[p.challenge_key] ?? 0);
  steps();
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const HINT_NAMES = ['A nudge', 'A direction', 'Nearly the answer'];

// One <details> per challenge, kept across refreshes (open state, typed flag and revealed hints survive the polling).
function renderChallenge(rows, p, info, points) {
  const key = p.challenge_key;
  let d = rows.querySelector(`details[data-key="${key}"]`);
  if (!d) {
    d = el('details', 'ch'); d.dataset.key = key;
    if (state.opened.has(key)) d.open = true;
    d.addEventListener('toggle', () => { if (d.open) { state.opened.add(key); loadDetail(key); loadHints(key); } else state.opened.delete(key); });
    const sum = el('summary');
    sum.append(el('span', 'key', key), el('span', 'title'), el('span', 'pill tier'), el('span', 'pill prog'), el('span', 'pts'));
    d.append(sum, el('div', 'ch-body'));
    rows.appendChild(d);
  }
  const sum = d.querySelector('summary');
  sum.querySelector('.title').textContent = info?.title || key;
  const tier = sum.querySelector('.tier'); tier.textContent = info?.tier || '-'; tier.className = `pill tier tier-${info?.tier || ''}`;
  const prog = sum.querySelector('.prog'); prog.className = `pill prog ${p.solved ? 'ok' : p.held ? 'held' : ''}`;
  prog.textContent = p.held ? 'held for review' : p.solved ? 'captured' : p.best_milestone === 'none' ? 'not yet' : p.best_milestone;
  sum.querySelector('.pts').textContent = `${points} pts`;
  const body = d.querySelector('.ch-body');
  const typed = body.querySelector('input.flag')?.value ?? '';
  body.replaceChildren();
  const more = state.details[key];
  const tags = el('div', 'tags');
  for (const t of [info?.owasp_2021 && `OWASP 2021 ${info.owasp_2021}`, info?.owasp_2025 && `OWASP 2025 ${info.owasp_2025}`, more?.cwe_primary]) if (t) tags.appendChild(el('span', 'tag', t));
  if (tags.childElementCount) body.appendChild(tags);
  if (p.brief) body.appendChild(el('p', '', p.brief));
  if (p.start) { const b = el('div', 'box start'); b.append(el('b', '', 'How to begin'), el('span', '', p.start)); body.appendChild(b); }
  // the three hints, revealed one at a time and kept on the page once revealed
  const hints = state.hints[key] || [];
  for (let level = 1; level <= 3; level++) {
    const row = el('div', 'hintrow'); const h = hints.find((x) => x.level === level);
    row.appendChild(el('span', 'lvl', `Hint ${level}: ${HINT_NAMES[level - 1]}`));
    if (h?.unlocked && h.text) row.appendChild(el('span', 'txt', h.text));
    else {
      const btn = el('button', 'ghost', level === p.hints_used + 1 ? 'Reveal' : 'Locked');
      btn.type = 'button'; btn.disabled = level !== p.hints_used + 1 || state.attempt.state !== 'running' || !p.hints_available;
      btn.addEventListener('click', () => unlockHint(key, level));
      row.appendChild(btn);
    }
    body.appendChild(row);
  }
  const flagRow = el('div', 'flagrow');
  const inp = el('input', 'flag'); inp.placeholder = 'VM{...}'; inp.maxLength = 200; inp.autocomplete = 'off'; inp.value = typed; inp.setAttribute('aria-label', `Flag for ${key}`);
  inp.disabled = state.attempt.state !== 'running' || p.solved;
  const go = el('button', '', 'Check'); go.type = 'button'; go.disabled = inp.disabled;
  go.addEventListener('click', () => submitFlag(key, inp));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitFlag(key, inp); });
  flagRow.append(inp, go); body.appendChild(flagRow);
  if (p.write_up) {
    const w = el('div', 'box win'); w.append(el('b', '', 'Captured. What was wrong'), el('span', '', p.write_up.vulnerable));
    const f = el('div', 'box win'); f.append(el('b', '', 'How to fix it'), el('span', '', p.write_up.fix));
    body.append(w, f);
  }
}

async function loadDetail(key) {
  if (state.details[key]) return;
  try { state.details[key] = await api('GET', `/api/v1/challenges/${key}`); } catch { state.details[key] = {}; }
  await loadProgress();
}
async function loadHints(key) {
  if (!state.attempt || !['running', 'submitted'].includes(state.attempt.state)) return;
  try { state.hints[key] = (await api('GET', `/api/v1/attempts/${state.attempt.attempt_id}/challenges/${key}/hints`)).items; await loadProgress(); } catch { /* hints may be off */ }
}

async function loadTimeline() {
  const t = await api('GET', `/api/v1/attempts/${state.attempt.attempt_id}/timeline?limit=50`).catch(() => ({ items: [] }));
  const ol = $('timeline'); ol.replaceChildren();
  const labels = { 'attempt.started': 'The clock started', 'milestone.reached': 'Milestone reached', 'flag.submitted': 'Flag pasted', 'hint.unlocked': 'Hint unlocked', 'instance.reset': 'Instance reset', 'attempt.submitted': 'Attempt submitted', 'attempt.expired': 'Time ran out' };
  for (const e of [...t.items].reverse()) {
    const li = document.createElement('li');
    li.textContent = `${e.at.slice(11, 19)}  ${labels[e.type] || e.type}${e.challenge_key ? ' ' + e.challenge_key : ''}${e.milestone ? ' (' + e.milestone + ')' : ''}${e.result ? ': ' + e.result : ''}`;
    ol.appendChild(li);
  }
}

// ---------- actions ----------
async function onStart() {
  $('start').disabled = true;
  try { await api('POST', '/api/v1/instances', { kind: 'learner' }); banner('Starting your instance. This takes a few seconds.', 'ok'); await refresh(); }
  catch (e) { banner(e.status === 429 ? 'The lab is full right now. Try again in a minute.' : say(e.code), 'bad'); $('start').disabled = false; }
}
async function onOpen() {
  const w = window.open('about:blank', '_blank'); // opened first so the browser allows it, filled after the ticket arrives
  if (w) w.opener = null; // the lab shop is vulnerable on purpose (XSS challenges): it must not reach this tab through window.opener
  try { const t = await api('POST', `/api/v1/instances/${state.instance.instance_id}/open`); state.opened.add('shop'); if (w) w.location.href = t.url; else banner('Allow pop-ups for this site, then press Open again.', 'bad'); steps(); }
  catch (e) { if (w) w.close(); banner(say(e.code), 'bad'); }
}
// A fresh one-time link for a browser that is not this one (Burp's browser): shown and copied, never opened here.
async function onCopy() {
  try {
    const t = await api('POST', `/api/v1/instances/${state.instance.instance_id}/open`);
    $('link').value = t.url; $('link-box').hidden = false; state.opened.add('shop');
    try { await navigator.clipboard.writeText(t.url); banner('Link copied. Paste it into your attack browser within a minute; it works once.', 'ok'); }
    catch { banner('Copy the link below and paste it into your attack browser within a minute; it works once.', 'ok'); $('link').select(); }
    steps();
  } catch (e) { banner(say(e.code), 'bad'); }
}
async function onReset() {
  if (!confirm('Reset gives you a fresh shop and new flags. Flags you found before stop working. Continue?')) return;
  try { await api('POST', `/api/v1/instances/${state.instance.instance_id}/reset`, { confirm: true }); banner('Resetting.', 'ok'); await refresh(); } catch (e) { banner(say(e.code), 'bad'); }
}
async function onStop() {
  if (!confirm('Stop frees the instance. You can start a new one with the same attempt. Continue?')) return;
  try { await api('POST', `/api/v1/instances/${state.instance.instance_id}/stop`); banner('Stopping.', 'ok'); await refresh(); } catch (e) { banner(say(e.code), 'bad'); }
}
async function onSubmit() {
  if (!confirm('Submitting ends the attempt: the clock stops and the instance is frozen. Continue?')) return;
  try { await api('POST', `/api/v1/attempts/${state.attempt.attempt_id}/submit`, { confirm: true }); banner('Submitted.', 'ok'); await refresh(); } catch (e) { banner(say(e.code), 'bad'); }
}
async function submitFlag(key, input) {
  const flag = input.value.trim(); if (!flag) return;
  try {
    const r = await api('POST', `/api/v1/attempts/${state.attempt.attempt_id}/flags`, { challenge_key: key, flag });
    $('flag-answer').textContent = r.result === 'correct' ? (r.credit === 'held' ? `${key}: correct, held for a human review.` : `${key}: correct, captured.`) : `${key}: not the flag for this challenge.`;
    input.value = ''; await refresh();
  } catch (e) { $('flag-answer').textContent = say(e.code); }
}
async function unlockHint(key, level) {
  try {
    const h = await api('POST', `/api/v1/attempts/${state.attempt.attempt_id}/challenges/${key}/hints/${level}/unlock`);
    state.hints[key] = (state.hints[key] || []).filter((x) => x.level !== h.level).concat(h); $('flag-answer').textContent = `${key} hint ${h.level} revealed.`; await refresh();
  } catch (e) { $('flag-answer').textContent = say(e.code); }
}
async function onReport() {
  try {
    const r = await api('GET', `/api/v1/attempts/${state.attempt.attempt_id}/report`);
    const lines = [`Score ${r.score} of 1000, ${r.state}`, `Elapsed ${r.elapsed_seconds ?? '-'} s, estimated active ${r.active_seconds ?? '-'} s, hints used ${r.hints_used_total}`, ''];
    for (const c of r.per_challenge.filter((x) => x.best_milestone !== 'none')) lines.push(`${c.challenge_key}: ${c.best_milestone}, ${c.points} points${c.time_to_capture_seconds != null ? `, captured after ${c.time_to_capture_seconds} s` : ''}`);
    $('report-box').textContent = lines.join('\n'); $('report-box').hidden = false;
  } catch (e) { banner(say(e.code), 'bad'); }
}

boot();
