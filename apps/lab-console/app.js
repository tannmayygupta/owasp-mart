// The learner console of the VulnMart lab. One page, no dependencies, no inline script or style (the page's CSP forbids both).
// A learner works through the challenges ONE AT A TIME: the current challenge is the whole stage, with a countdown by difficulty
// (Easy 20, Medium 40, Hard 60 minutes) that starts when they press Begin. The points of the account are the best result per challenge over all runs.
// It only calls the documented browser routes of IF-1 and IF-2 on its own origin. Everything the server sends is put on the page with textContent, never as HTML.
const $ = (id) => document.getElementById(id);
const state = {
  csrf: null, user: null, attempt: null, assessment: null, instance: null, catalog: [], items: [], meta: {}, score: null, account: null, points: {},
  hints: {}, hintErr: {}, flagMsg: null, draft: {}, picked: null, busy: false, poll: null, tick: null, skew: 0, ring: null, ringTotal: 0, lastLeft: null,
};
const TIER_MIN = { Easy: 20, Medium: 40, Hard: 60 };
const FINISHED = ['submitted', 'reported', 'expired', 'cancelled', 'withdrawn'];
const INSTANCE_READY = ['ready', 'active', 'idle'];

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
  'INST-QUOTA-REACHED': 'You already have a running lab.', 'INST-NOT-READY': 'Your shop is not ready yet.', 'INST-INVALID-STATE': 'That cannot be done in the shop\'s state now.',
  'INST-START-FAILED': 'The lab could not start your shop. Try again in a moment.', 'ATT-INVALID-STATE': 'That cannot be done right now (the challenge may have ended).',
  'ATT-CHALLENGE-NOT-FOUND': 'That challenge is not open yet.', 'ATT-FLAG-RATE-LIMITED': 'Too many wrong flags for this challenge. Wait a few minutes.',
  'ATT-GONE': 'That run is closed.', 'AUTH-CSRF-FAILED': 'Your session changed. Reload the page.',
};
const say = (code) => MESSAGES[code] || `Something went wrong (${code}).`;
// A message that was good news or a hint fades by itself (a "Building your shop" line must not outlive the building); an error stays until something else is said.
let bannerTimer = null;
function banner(text, kind) {
  const b = $('banner'); b.textContent = text || ''; b.className = kind || ''; b.hidden = !text;
  clearTimeout(bannerTimer);
  if (text && kind !== 'bad') { bannerTimer = setTimeout(() => { b.hidden = true; b.textContent = ''; }, 7000); bannerTimer.unref?.(); }
}

// ---------- small helpers ----------
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const button = (label, cls, onClick) => { const b = el('button', `btn ${cls || ''}`.trim(), label); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
const clock = (seconds) => { const s = Math.max(0, Math.floor(seconds)); const h = Math.floor(s / 3600); const m = Math.floor(s / 60) % 60; const r = s % 60; const mm = String(m).padStart(2, '0'); const ss = String(r).padStart(2, '0'); return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`; };
function svgRing() {
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const svg = make('svg', { viewBox: '0 0 104 104', 'aria-hidden': 'true' });
  svg.append(make('circle', { class: 'ring-track', cx: 52, cy: 52, r: 46 }));
  const fill = make('circle', { class: 'ring-fill', cx: 52, cy: 52, r: 46 });
  svg.append(fill);
  return { svg, fill };
}

// ---------- views ----------
// Signed out, this page is the landing page: what the platform offers and two buttons (Sign in and Create account are pages of their own, /login and /signup).
// Signed in as a learner it is the lab. A recruiter or an administrator has no lab here: their screens are the dashboards.
function show(view) { for (const v of ['landing', 'lab']) $(v).hidden = v !== view; $('who').hidden = view !== 'lab'; $('guest').hidden = view !== 'landing'; }

async function boot() {
  $('logout').addEventListener('click', onLogout);
  $('open').addEventListener('click', onOpen);
  $('copy').addEventListener('click', onCopy);
  $('reset').addEventListener('click', onReset);
  $('stop').addEventListener('click', onStop);
  $('submit').addEventListener('click', onFinishRun);
  $('report').addEventListener('click', onReport);
  try {
    const s = await api('GET', '/api/v1/session');
    if (s.status === 'authenticated') {
      const kind = s.user?.account_type;
      if (kind && kind !== 'participant') { location.replace('/dashboard'); return; } // recruiters and administrators work in the dashboards
      return enter(s);
    }
  } catch { /* not signed in */ }
  show('landing');
}

async function onLogout() {
  try { await api('DELETE', '/api/v1/session'); } catch { /* the session may be gone already */ }
  clearInterval(state.poll); clearInterval(state.tick);
  Object.assign(state, { csrf: null, user: null, attempt: null, assessment: null, instance: null, items: [], meta: {}, score: null, account: null, points: {}, hints: {}, hintErr: {}, flagMsg: null, draft: {}, picked: null });
  $('link-box').hidden = true; $('report-box').hidden = true;
  show('landing'); banner('You are signed out.', 'ok');
}

async function enter(session) {
  state.csrf = session.csrf_token; state.user = session.user;
  $('who-name').textContent = session.user.display_name;
  show('lab');
  try { state.catalog = (await api('GET', '/api/v1/challenges')).items; } catch { state.catalog = []; }
  renderMission(); // something to look at while the first answers come
  await refresh();
}

// ---------- the data ----------
async function refresh() {
  // Asked while a read is already in flight (a poll, or the click that just changed something): that read may have started before the change, so read once more when it ends.
  // Dropping the request left the page on the old run with no later poll (a finished run is not polled): "Start a new run" then showed a destroyed shop until a reload.
  if (state.busy) { state.again = true; return; }
  state.busy = true;
  try {
    const all = (await api('GET', '/api/v1/me/attempts')).items;
    // only practice runs belong here: a company assessment (mode "candidate") is never shown as practice, whatever its state
    const mine = all.filter((a) => a.mode === 'learner');
    state.assessment = all.find((a) => a.mode === 'candidate' && !FINISHED.includes(a.state)) || all.find((a) => a.mode === 'candidate') || null;
    const current = mine.find((a) => ['running', 'ready'].includes(a.state)) || mine[0] || null; // a live run first, else the latest one
    state.attempt = current ? await api('GET', `/api/v1/attempts/${current.attempt_id}`) : null;
    if (state.attempt && state.attempt.mode !== 'learner') state.attempt = null; // the attempt answer must agree with the list
    state.instance = state.attempt?.instance_id ? await api('GET', `/api/v1/instances/${state.attempt.instance_id}`).catch(() => null) : null;
    const watched = state.attempt && state.items.length ? currentItem() : null; // the challenge on screen before this read
    const watchedRun = state.attempt?.attempt_id;
    if (state.attempt && state.attempt.state !== 'ready') await loadProgress();
    else { state.items = []; state.meta = {}; state.score = null; }
    // The lab counts a flag the moment it shows up in the shop (the sidecar sees it), so the challenge can end while the learner is still reading it or about to paste.
    // Without this the page jumped to the next challenge and the flag just found was then refused there ("not the flag for this challenge"): stay on the captured one and say so.
    if (watched && !watched.solved && state.attempt?.attempt_id === watchedRun) {
      const now = state.items.find((i) => i.challenge_key === watched.challenge_key);
      if (now && now.solved && !state.picked) {
        state.picked = watched.challenge_key;
        banner(`${watched.challenge_key} captured: the lab saw the flag in your shop and counted it. You do not need to paste it.`, 'ok');
      }
    }
    state.account = await api('GET', '/api/v1/me/progress').catch(() => null); // a lab that is not sequenced has no account points
    if (state.attempt) await loadTimeline();
    render();
  } catch (e) {
    if (e.status === 401) {
      // one refused call is not a sign-out: ask the session itself before sending the learner back to the sign-in page
      const s = await api('GET', '/api/v1/session').catch(() => null);
      if (s && s.status === 'authenticated') { state.csrf = s.csrf_token || state.csrf; state.retry = (state.retry || 0) + 1; }
      else { banner(say('AUTH-SESSION-REQUIRED'), 'bad'); show('landing'); }
    } else banner(say(e.code), 'bad');
  } finally { state.busy = false; }
  if (state.again) { state.again = false; return refresh(); }
  if (state.retry && state.retry < 3) { const n = state.retry; await refresh(); if (state.retry === n) state.retry = 0; return; } // the session is fine: read the lab again
  state.retry = 0;
  schedule();
}

async function loadProgress() {
  const id = state.attempt.attempt_id;
  const list = await api('GET', `/api/v1/attempts/${id}/challenges`);
  const score = await api('GET', `/api/v1/attempts/${id}/score`).catch(() => null); // not held back for a company's results; a learner always sees theirs
  state.items = list.items;
  state.meta = { total: list.total, current_key: list.current_key, server_time: list.server_time };
  state.skew = list.server_time ? Date.parse(list.server_time) - Date.now() : 0;
  state.score = score;
  state.points = score ? Object.fromEntries(score.per_challenge.map((c) => [c.challenge_key, c.points])) : {};
}

async function loadHints(key) {
  if (!state.attempt || state.attempt.state !== 'running') return;
  try { state.hints[key] = (await api('GET', `/api/v1/attempts/${state.attempt.attempt_id}/challenges/${key}/hints`)).items; renderMission(); } catch { /* hints may be off for this run */ }
}

async function loadTimeline() {
  const t = await api('GET', `/api/v1/attempts/${state.attempt.attempt_id}/timeline?limit=50`).catch(() => ({ items: [] }));
  const ol = $('timeline'); ol.replaceChildren();
  const labels = { 'attempt.started': 'Your run started', 'milestone.reached': 'Milestone reached', 'flag.submitted': 'Flag pasted', 'hint.unlocked': 'Hint revealed', 'instance.reset': 'Shop reset', 'attempt.submitted': 'Run finished', 'attempt.expired': 'Time ran out' };
  for (const e of [...t.items].reverse()) {
    const text = e.type === 'attempt.time_warning' ? `Time warning: ${e.minutes_left} minutes left` : (labels[e.type] || e.type);
    ol.appendChild(el('li', '', `${e.at.slice(11, 19)}  ${text}${e.challenge_key ? ' ' + e.challenge_key : ''}${e.milestone ? ' (' + e.milestone + ')' : ''}${e.result ? ': ' + e.result : ''}`));
  }
}

function schedule() {
  clearInterval(state.poll); clearInterval(state.tick);
  const starting = state.attempt && state.attempt.state === 'running' && Boolean(state.instance) && !INSTANCE_READY.includes(state.instance.state) && !['destroyed', 'failed'].includes(state.instance.state);
  const waiting = state.attempt && state.attempt.state === 'ready';
  if (starting || waiting) state.poll = setInterval(refresh, 2000);
  else if (state.attempt && state.attempt.state === 'running') state.poll = setInterval(() => { if (!typing()) void refresh(); }, 15000);
  else state.poll = setInterval(() => { void refresh(); }, 20000); // no live run: a slow look, so a run started or ended in another tab shows up
  state.tick = setInterval(tickClock, 1000);
}
const typing = () => { const a = typeof document.activeElement === 'object' ? document.activeElement : null; return Boolean(a && a.tagName === 'INPUT' && a.className.includes('flag-input')); };

// ---------- what to show ----------
// the challenge the learner is looking at: a picked one (from the rail) or the current one of the run
function currentItem() {
  const byKey = (k) => state.items.find((i) => i.challenge_key === k);
  if (state.picked && byKey(state.picked)) return byKey(state.picked);
  if (state.meta.current_key && byKey(state.meta.current_key)) return byKey(state.meta.current_key);
  return state.items.find((i) => !i.solved && i.state !== 'expired') || state.items[state.items.length - 1] || null;
}
const phase = (item) => item.state || (item.solved ? 'solved' : 'active'); // a server that is not sequenced has no countdown: every challenge is open
const info = (key) => state.catalog.find((c) => c.challenge_key === key);
const titleOf = (item) => item.title || info(item.challenge_key)?.title || item.challenge_key;
const tierOf = (item) => item.tier || info(item.challenge_key)?.tier || null;

function render() {
  const a = state.attempt;
  $('acct-num').textContent = String(state.account?.total_points ?? 0);
  const live = a && ['ready', 'running'].includes(a.state);
  const i = state.instance;
  const ready = Boolean(i) && INSTANCE_READY.includes(i.state) && i.access === 'open' && a?.state === 'running';
  $('i-state').textContent = i ? (ready ? 'running' : i.state) : (a && live ? 'starting' : 'not started');
  $('i-state').className = `pill ${ready ? 'ok' : ''}`.trim();
  $('instance-actions').hidden = !live || !i;
  // a button that cannot be pressed says why (the pointer shows it too: see style.css)
  const gate = (id, on, why) => { const b = $(id); b.disabled = !on; b.title = on ? (b.dataset.title || '') : why; };
  for (const id of ['open', 'copy', 'reset', 'stop', 'submit']) { const b = $(id); if (b.dataset.title === undefined) b.dataset.title = b.title || ''; }
  const noShop = 'Available when your shop is running.';
  gate('open', ready, noShop); gate('copy', ready, noShop); gate('reset', ready, noShop);
  gate('stop', Boolean(i) && !['stopping', 'destroyed'].includes(i.state), 'There is no running shop to stop.');
  gate('submit', a?.state === 'running', 'There is no run in progress.');
  if (ready && $('banner').textContent.startsWith('Building your shop')) banner(''); // it is built: the message is done
  $('report').hidden = !a || !['submitted', 'reported', 'running', 'expired'].includes(a.state);
  const solved = state.items.filter((x) => x.solved).length;
  const total = state.meta.total || state.items.length || state.catalog.length || 0;
  $('score').textContent = String(state.score?.score ?? 0);
  $('bar-fill').style.width = `${Math.min(100, Math.round((state.score?.score ?? 0) / 10))}%`;
  $('captured').textContent = a && state.items.length ? `${solved} of ${total} challenges captured` : '';
  renderRail();
  renderMission();
  tickClock();
}

function renderRail() {
  const rail = $('rail'); rail.replaceChildren();
  const keys = state.catalog.length ? state.catalog.map((c) => c.challenge_key) : state.items.map((i) => i.challenge_key);
  if (!state.attempt || !keys.length) { rail.hidden = true; return; }
  rail.hidden = false;
  const shown = currentItem();
  keys.forEach((key, n) => {
    const item = state.items.find((i) => i.challenge_key === key);
    const st = item ? phase(item) : 'future';
    const cls = item && shown && shown.challenge_key === key ? 'now' : st === 'solved' ? 'done' : st === 'expired' ? 'lost' : '';
    const li = el('li', cls);
    const dot = el('button', 'dot', st === 'solved' ? '✓' : String(n + 1)); dot.type = 'button';
    dot.setAttribute('aria-label', `Challenge ${n + 1}${item ? ': ' + titleOf(item) : ''}, ${st === 'future' ? 'locked' : st}`);
    if (item) {
      dot.title = `Challenge ${n + 1}: ${titleOf(item)}`;
      dot.addEventListener('click', () => { state.picked = key; banner(''); render(); });
    } else {
      // a challenge opens when the one before it is captured or its time is over: say so instead of doing nothing (the button stays focusable, so a keyboard user hears it too)
      const why = n === 0 ? 'This challenge is not open yet.' : `Challenge ${n + 1} is locked. Capture challenge ${n}, or let its time run out, to open it.`;
      dot.title = why; dot.className = 'dot locked'; dot.setAttribute('aria-disabled', 'true');
      dot.addEventListener('click', () => banner(why, 'info'));
    }
    li.appendChild(dot); rail.appendChild(li);
  });
}

function renderMission() {
  const m = $('mission'); m.replaceChildren(); state.ring = null;
  const a = state.attempt;
  if (!a) return m.appendChild(startPanel('Your lab is ready when you are', 'A private copy of the shop is built for you in a few seconds. Nothing you do there touches anything else.', 'Start my lab'));
  if (FINISHED.includes(a.state)) return m.appendChild(finishedPanel());
  if (a.state === 'ready') return m.appendChild(preparingPanel());
  if (!state.instance || ['destroyed', 'failed'].includes(state.instance.state)) return m.appendChild(startPanel('Your shop is not running', 'Your run is still open. Build a new shop to carry on with the current challenge.', 'Build a new shop', currentItem()));
  if (!INSTANCE_READY.includes(state.instance.state)) return m.appendChild(preparingPanel());
  const item = currentItem();
  if (!item) return m.appendChild(preparingPanel());
  const ph = phase(item);
  const head = el('div', 'm-head');
  const left = el('div');
  const kicker = el('p', 'kicker');
  const keys = state.catalog.map((c) => c.challenge_key);
  const n = keys.indexOf(item.challenge_key) + 1;
  kicker.append(`Challenge ${n || '?'} of ${state.meta.total || keys.length || '?'}`);
  const tier = tierOf(item); if (tier) kicker.append(el('span', `badge tier-${tier}`, tier));
  const cwe = info(item.challenge_key)?.owasp_2025; if (cwe) kicker.append(el('span', '', `OWASP ${cwe}`));
  left.append(kicker, el('h1', 'm-title', titleOf(item)));
  head.append(left);
  if (ph === 'ready' || ph === 'active') head.append(timerBlock(item, ph)); // a challenge that ended has no countdown any more
  m.appendChild(head);
  const body = el('div', 'm-body');
  if (ph === 'ready') body.append(...introBody(item));
  else if (ph === 'active') body.append(...activeBody(item));
  else body.append(...endedBody(item, ph));
  m.appendChild(body);
  if (ph === 'active' && !state.hints[item.challenge_key] && item.hints_available) void loadHints(item.challenge_key);
}

function startPanel(title, text, label, item) {
  const body = el('div', 'm-body');
  if (state.assessment && !state.attempt) body.append(assessmentNote(state.assessment));
  body.append(el('div', 'empty-art', '>_'), el('h1', 'm-title', title), el('p', 'lede', text));
  if (item) {
    // the challenge the learner picked on the rail is shown even while the shop is down, so the rail always answers a click
    const keys = state.catalog.map((c) => c.challenge_key);
    const box = el('div', 'box');
    box.append(el('b', '', `Challenge ${keys.indexOf(item.challenge_key) + 1 || '?'}: ${titleOf(item)}${tierOf(item) ? ` (${tierOf(item)})` : ''}`), el('span', '', item.brief || 'Build your shop to see this challenge.'));
    body.append(box);
  }
  const cta = el('div', 'cta'); cta.append(button(label, 'primary big', onStart)); body.append(cta);
  body.append(el('p', 'note', 'Challenges open one at a time. Each has a countdown that starts when you press Begin: Easy 20, Medium 40, Hard 60 minutes.'));
  return body;
}

// An account that is invited to a company assessment keeps it on its own page: this console is the practice lab only.
function assessmentNote(a) {
  const p = el('p', 'note assessment-note');
  p.append('You also have a company assessment. It is not part of this practice lab: ');
  const link = el('a', '', 'open it on the assessment page'); link.href = `/assessment/${a.attempt_id}`;
  p.append(link, '.');
  return p;
}

function preparingPanel() {
  const body = el('div', 'm-body');
  const line = el('div', 'state-line'); line.append(el('span', 'spinner'), el('h1', 'm-title', 'Building your private shop'));
  body.append(line, el('p', 'lede', 'This takes a few seconds. Your challenge opens as soon as it is ready; no time is counted yet.'));
  return body;
}

function finishedPanel() {
  const body = el('div', 'm-body');
  const head = el('div', 'result-head'); head.append(el('span', 'tick', '✓'), el('h1', 'm-title', 'This run is finished'));
  const run = state.score?.score ?? 0;
  body.append(head, el('p', 'lede', `You scored ${run} of 1000 in this run. Your account keeps your best result for each challenge, so a new run can only add points.`));
  const rows = el('div', 'hints');
  for (const it of state.items) {
    const r = el('div', 'hint'); r.append(el('span', 'lvl', it.challenge_key), el('span', 'txt', `${titleOf(it)}: ${phase(it) === 'solved' ? 'captured' : phase(it) === 'expired' ? 'time ran out' : 'not captured'}, ${state.points[it.challenge_key] ?? 0} pts`));
    rows.appendChild(r);
  }
  if (rows.childElementCount) body.appendChild(rows);
  const cta = el('div', 'cta'); cta.append(button('Start a new run', 'primary big', onStart)); body.append(cta);
  return body;
}

function timerBlock(item, ph) {
  const t = el('div', ph === 'active' ? 'timer' : 'timer idle');
  const { svg, fill } = svgRing(); t.appendChild(svg);
  const text = el('div', 'timer-text');
  const digits = el('div', '', clock(item.seconds_left ?? item.time_limit_seconds ?? 0)); digits.id = 'timer-digits';
  const label = el('div', '', ph === 'active' ? 'left' : 'to play'); label.id = 'timer-label';
  text.append(digits, label); t.appendChild(text);
  state.ring = { box: t, fill, digits, item, total: item.time_limit_seconds || (TIER_MIN[item.tier] || 40) * 60 };
  return t;
}

function introBody(item) {
  const minutes = Math.round((item.time_limit_seconds || (TIER_MIN[item.tier] || 40) * 60) / 60);
  const out = [];
  if (item.brief) out.push(el('p', 'lede', item.brief));
  out.push(el('p', 'note', `You will have ${minutes} minutes once you begin. The countdown stops when you capture the flag. Read first if you like; nothing is counted yet.`));
  const cta = el('div', 'cta'); cta.append(button(`Begin challenge (${minutes} min)`, 'primary big', () => onBegin(item.challenge_key))); out.push(cta);
  return out;
}

function activeBody(item) {
  const key = item.challenge_key; const out = [];
  if (item.brief) out.push(el('p', 'lede', item.brief));
  if (item.start) { const b = el('div', 'box'); b.append(el('b', '', 'How to begin'), el('span', '', item.start)); out.push(b); }
  const shop = el('div', 'cta'); shop.append(button('Open the shop in a new tab', 'soft', onOpen)); out.push(shop);
  // the three hints, revealed one at a time and kept on the page once revealed
  if (item.hints_available) {
    const hints = el('div', 'hints'); const got = state.hints[key] || [];
    ['A nudge', 'A direction', 'Nearly the answer'].forEach((name, k) => {
      const level = k + 1; const h = got.find((x) => x.level === level);
      const row = el('div', h?.unlocked && h.text ? 'hint open' : 'hint');
      row.appendChild(el('span', 'lvl', `Hint ${level}: ${name}`));
      if (h?.unlocked && h.text) row.appendChild(el('span', 'txt', h.text));
      else {
        const next = level === item.hints_used + 1;
        const b = button(next ? 'Reveal' : 'Locked', 'quiet sm', () => onHint(key, level)); b.disabled = !next; if (!next) b.title = 'Reveal the hint before this one first.';
        row.appendChild(b);
        if (state.hintErr[key]?.level === level) row.appendChild(el('span', 'txt bad', state.hintErr[key].text));
      }
      hints.appendChild(row);
    });
    out.push(hints);
  }
  const form = el('div', 'flag');
  const inp = el('input', 'flag-input mono'); inp.placeholder = 'VM{...}'; inp.maxLength = 200; inp.autocomplete = 'off'; inp.value = state.draft[key] || '';
  inp.setAttribute('aria-label', `Flag for ${titleOf(item)}`);
  inp.addEventListener('input', () => { state.draft[key] = inp.value; });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') void onFlag(key, inp); });
  form.append(inp, button('Check flag', 'primary', () => onFlag(key, inp)));
  out.push(form);
  const msg = state.flagMsg?.key === key ? state.flagMsg : null;
  out.push(el('p', `flag-msg ${msg?.kind || ''}`.trim(), msg?.text || ''));
  return out;
}

function endedBody(item, ph) {
  const key = item.challenge_key; const out = [];
  const head = el('div', 'result-head');
  head.append(el('span', ph === 'solved' ? 'tick' : 'tick out', ph === 'solved' ? '✓' : '!'), el('h2', '', ph === 'solved' ? (item.held ? 'Captured, waiting for a review' : 'Flag captured') : 'The time for this challenge is over'));
  out.push(head);
  const pts = state.points[key] ?? 0;
  out.push(el('p', pts ? 'points' : 'points none', `${pts} pts`));
  if (ph === 'solved') out.push(el('p', 'note', 'The lab counts a flag the moment it shows up in your shop, so you do not have to paste it. Pasting it also works.'));
  if (item.write_up) {
    const w = el('div', 'box win'); w.append(el('b', '', 'What was wrong'), el('span', '', item.write_up.vulnerable));
    const f = el('div', 'box win'); f.append(el('b', '', 'How to fix it'), el('span', '', item.write_up.fix));
    out.push(w, f);
  }
  const cta = el('div', 'cta');
  const cur = state.meta.current_key;
  if (cur && cur !== key) cta.append(button(ph === 'solved' ? 'Next challenge' : 'Go to the current challenge', 'primary big', () => { state.picked = null; render(); }));
  else if (!cur && state.attempt?.state === 'running') cta.append(button('Finish this run', 'primary big', onFinishRun));
  if (cta.childElementCount) out.push(cta);
  return out;
}

// the countdown: the server's clock decides, the page only draws it (the server time of the last answer sets the skew)
function tickClock() {
  const a = state.attempt;
  if (!a || a.state !== 'running' || !a.deadline_at) $('a-left').textContent = a && FINISHED.includes(a.state) ? 'finished' : '-';
  else $('a-left').textContent = clock((Date.parse(a.deadline_at) - (Date.now() + state.skew)) / 1000);
  const r = state.ring;
  if (!r || !r.item.expires_at) return;
  const left = Math.max(0, (Date.parse(r.item.expires_at) - (Date.now() + state.skew)) / 1000);
  r.digits.textContent = clock(left);
  r.fill.style.strokeDashoffset = String(Math.round(289 * (1 - left / r.total)));
  r.box.className = `timer${left <= 60 ? ' urgent' : left <= 300 ? ' low' : ''}`;
  if (left === 0 && state.lastLeft !== 0 && phase(r.item) === 'active') { state.picked = r.item.challenge_key; void refresh(); } // the server ends the challenge; ask what it decided and stay to show it
  state.lastLeft = left;
}

// ---------- actions ----------
async function onStart() {
  try { await api('POST', '/api/v1/instances', { kind: 'learner' }); banner('Building your shop. This takes a few seconds.', 'ok'); state.picked = null; state.hints = {}; state.flagMsg = null; await refresh(); }
  catch (e) { banner(e.status === 429 ? 'The lab is full right now. Try again in a minute.' : say(e.code), 'bad'); }
}
async function onBegin(key) {
  try { await api('POST', `/api/v1/attempts/${state.attempt.attempt_id}/challenges/${key}/begin`); banner(''); state.picked = null; await refresh(); }
  catch (e) { banner(say(e.code), 'bad'); }
}
async function onOpen() {
  const w = window.open('about:blank', '_blank'); // opened first so the browser allows it, filled after the ticket arrives
  if (w) w.opener = null; // the lab shop is vulnerable on purpose (XSS challenges): it must not reach this tab through window.opener
  try { const t = await api('POST', `/api/v1/instances/${state.instance.instance_id}/open`); if (w) w.location.href = t.url; else banner('Allow pop-ups for this site, then press Open again.', 'bad'); }
  catch (e) { if (w) w.close(); banner(say(e.code), 'bad'); }
}
// A fresh one-time link for a browser that is not this one (Burp's browser): shown and copied, never opened here.
async function onCopy() {
  try {
    const t = await api('POST', `/api/v1/instances/${state.instance.instance_id}/open`);
    $('link').value = t.url; $('link-box').hidden = false;
    try { await navigator.clipboard.writeText(t.url); banner('Link copied. Paste it into your attack browser within a minute; it works once.', 'ok'); }
    catch { banner('Copy the link below and paste it into your attack browser within a minute; it works once.', 'ok'); $('link').select(); }
  } catch (e) { banner(say(e.code), 'bad'); }
}
async function onReset() {
  if (!confirm('Reset gives you a fresh shop and new flags. Flags you found before stop working. Continue?')) return;
  try { await api('POST', `/api/v1/instances/${state.instance.instance_id}/reset`, { confirm: true }); banner('Resetting.', 'ok'); await refresh(); } catch (e) { banner(say(e.code), 'bad'); }
}
async function onStop() {
  if (!confirm('Stop frees your shop. You can build a new one. Continue?')) return;
  try { await api('POST', `/api/v1/instances/${state.instance.instance_id}/stop`); banner('Stopping.', 'ok'); await refresh(); } catch (e) { banner(say(e.code), 'bad'); }
}
async function onFinishRun() {
  if (!confirm('Finishing ends this run: every challenge that is not captured stays at what you earned. Continue?')) return;
  try { await api('POST', `/api/v1/attempts/${state.attempt.attempt_id}/submit`, { confirm: true }); banner('Run finished.', 'ok'); await refresh(); } catch (e) { banner(say(e.code), 'bad'); }
}
async function onFlag(key, input) {
  const flag = input.value.trim(); if (!flag) return;
  try {
    const r = await api('POST', `/api/v1/attempts/${state.attempt.attempt_id}/flags`, { challenge_key: key, flag });
    state.flagMsg = { key, kind: r.result === 'correct' ? 'ok' : 'bad', text: r.result === 'correct' ? (r.credit === 'held' ? 'Correct. A human reviews this capture before it counts.' : 'Correct. Flag captured.') : `That is not the flag for ${key}. Each challenge has its own flag, and Reset shop changes all of them.` };
    $('flag-answer').textContent = state.flagMsg.text;
    if (r.result === 'correct') delete state.draft[key];
    state.picked = r.result === 'correct' ? key : null; // stay on the captured challenge: the result and the way on come before the next one
    await refresh();
  } catch (e) { state.flagMsg = { key, kind: 'bad', text: say(e.code) }; $('flag-answer').textContent = state.flagMsg.text; renderMission(); }
}
async function onHint(key, level) {
  try {
    const h = await api('POST', `/api/v1/attempts/${state.attempt.attempt_id}/challenges/${key}/hints/${level}/unlock`);
    state.hints[key] = (state.hints[key] || []).filter((x) => x.level !== h.level).concat(h); delete state.hintErr[key];
    const it = state.items.find((x) => x.challenge_key === key); if (it) it.hints_used = Math.max(it.hints_used, h.level);
    $('flag-answer').textContent = `Hint ${h.level} revealed.`;
    renderMission(); // the hint is on the page now, whatever the refresh below does
    await refresh();
  } catch (e) {
    // shown on the hint row itself (the status line is far from the button), and kept across the next render
    state.hintErr[key] = { level, text: say(e.code) }; $('flag-answer').textContent = say(e.code); renderMission();
  }
}
async function onReport() {
  try {
    const r = await api('GET', `/api/v1/attempts/${state.attempt.attempt_id}/report`);
    const lines = [`Score ${r.score} of 1000, ${r.state}`, `Elapsed ${r.elapsed_seconds ?? '-'} s, hints used ${r.hints_used_total}`, ''];
    for (const c of r.per_challenge.filter((x) => x.best_milestone !== 'none')) lines.push(`${c.challenge_key}: ${c.best_milestone}, ${c.points} points${c.time_to_capture_seconds != null ? `, captured after ${c.time_to_capture_seconds} s` : ''}`);
    $('report-box').textContent = lines.join('\n'); $('report-box').hidden = false;
  } catch (e) { banner(say(e.code), 'bad'); }
}

boot();
