// End-to-end suite of the deployed lab (production readiness story 9.5, L-30): the real site, a real browser-like client, the real instance.
//   node scripts/e2e-live.mjs --base https://<platform host> [--mailpit-ssh ubuntu@<vm-p address>] [--password <text>] [--load N] [--json <file>]
// One learner, start to finish:
//   health, sign up, read the confirmation mail from Mailpit (over ssh) and use the link, sign in, start an instance, wait for ready, open it with the one-time
//   ticket (the gate answers 302 and a cookie), see the shop, read a planted flag off the shop the way a player would (so the sidecar sees it in a response),
//   paste a wrong and the right flag, hints, a reset (the old flag stops working, the new one works), timeline, submit, report, and the audit trail.
// `--load N` starts N learners at once (accounts are made first, one at a time) and reports the time to a running instance for each. It never prints a password,
// a cookie, a ticket or a flag. The checks and numbers go to the table (and a JSON file with --json) for docs/assets.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const SSH = WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const o = { load: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!['--base', '--mailpit-ssh', '--password', '--load', '--json'].includes(a)) return { error: `unknown argument ${a}` };
    if (argv[i + 1] === undefined) return { error: `${a} needs a value` };
    const v = argv[++i];
    if (a === '--load') o.load = Number(v);
    else o[{ '--base': 'base', '--mailpit-ssh': 'mailpit', '--password': 'password', '--json': 'json' }[a]] = v;
  }
  if (!o.base) return { error: '--base <https://platform host> is required' };
  let u;
  try { u = new URL(o.base); } catch { return { error: '--base is not a URL' }; }
  if (u.protocol !== 'https:' || u.pathname !== '/') return { error: '--base must be an https origin' };
  o.base = u.origin;
  if (!Number.isInteger(o.load) || o.load < 0 || o.load > 100) return { error: '--load is a whole number from 0 to 100' };
  if (o.mailpit && !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(o.mailpit)) return { error: '--mailpit-ssh must look like ubuntu@host' };
  return o;
}

/** A small cookie jar and JSON client for one learner. */
export class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); this.csrf = null; }

  async request(method, url, { body, headers = {}, json = true, followHost = false } = {}) {
    const abs = url.startsWith('http') ? url : this.base + url;
    const u = new URL(abs);
    const h = { accept: 'application/json', ...headers };
    const jar = [...this.cookies].filter(([k]) => u.origin === this.base || k.startsWith('__Host-vm_gate')).map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) h.cookie = jar;
    if (u.origin === this.base && method !== 'GET') { h.origin = this.base; if (this.csrf) h['x-csrf-token'] = this.csrf; if (body !== undefined) h['content-type'] = 'application/json'; }
    const t0 = performance.now();
    const res = await fetch(abs, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [pair] = sc.split(';'); const i = pair.indexOf('='); if (!/Max-Age=0/i.test(sc)) this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    let data = null;
    const text = await res.text();
    if (json && text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { status: res.status, data, text, headers: res.headers, ms: Math.round(performance.now() - t0) };
  }
}

export function mailpitToken(messageText) {
  const m = /\/verify-email\?token=([A-Za-z0-9_-]{32,128})/.exec(messageText);
  return m ? m[1] : null;
}

function mailpit(target, args) {
  const r = spawnSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, `curl -fsS ${args}`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(`mail check over ssh failed: ${String(r.stderr).split(/\r?\n/)[0]}`);
  return r.stdout;
}

export async function verificationToken(target, email) {
  for (let i = 0; i < 20; i++) {
    const list = JSON.parse(mailpit(target, `'http://127.0.0.1:8025/api/v1/search?query=to:${encodeURIComponent(email)}'`));
    const id = list.messages?.[0]?.ID;
    if (id) { const msg = JSON.parse(mailpit(target, `http://127.0.0.1:8025/api/v1/message/${id}`)); const t = mailpitToken(`${msg.Text ?? ''}\n${msg.HTML ?? ''}`); if (t) return t; }
    await sleep(1500);
  }
  throw new Error('the confirmation mail did not arrive');
}

const rows = [];
const check = (name, ok, detail = '') => { rows.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); return !!ok; };

async function waitRunning(c, aid, seconds = 240) {
  const t0 = Date.now();
  let a;
  while (Date.now() - t0 < seconds * 1000) {
    a = (await c.request('GET', `/api/v1/attempts/${aid}`)).data;
    if (a?.state === 'running') return { ok: true, seconds: Math.round((Date.now() - t0) / 100) / 10, attempt: a };
    await sleep(1500);
  }
  return { ok: false, seconds, attempt: a };
}

async function newLearner(o, label) {
  const c = new Client(o.base);
  const email = `e2e-${label}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}@example.test`;
  const password = o.password || `Pw-${crypto.randomBytes(9).toString('base64url')}-x`;
  const s = await c.request('POST', '/api/v1/accounts', { body: { email, password, display_name: `E2E ${label}`, age_declaration: true } });
  if (s.status !== 202) throw new Error(`sign up answered ${s.status}`);
  if (!o.mailpit) throw new Error('--mailpit-ssh is needed to read the confirmation mail');
  const token = await verificationToken(o.mailpit, email);
  const v = await c.request('POST', '/api/v1/accounts/verify-email', { body: { token } });
  if (v.status !== 200) throw new Error(`verify answered ${v.status}`);
  const l = await c.request('POST', '/api/v1/session', { body: { email, password } });
  if (l.status !== 200 || !l.data?.csrf_token) throw new Error(`sign in answered ${l.status}`);
  c.csrf = l.data.csrf_token;
  c.email = email; c.password = password; // kept so a test can sign in a second time (FR-SES-11)
  return c;
}

export async function journey(o) {
  const t00 = Date.now();
  const h = await new Client(o.base).request('GET', '/api/v1/health');
  check('platform health through the site', h.status === 200 && h.data?.status === 'ok', `HTTP ${h.status} ${h.ms} ms`);
  const hz = await new Client(o.base).request('GET', '/healthz');
  check('API liveness through the site', hz.status === 200, `HTTP ${hz.status}`);
  // the page a person opens: the console is served at the root and its script and style load (a stale bind mount once left the folder empty: 404 at the root)
  const home = await new Client(o.base).request('GET', '/', { json: false });
  const js = await new Client(o.base).request('GET', '/app.js', { json: false });
  check('the console page and its script are served at the root of the site', home.status === 200 && /app\.js/.test(home.text) && js.status === 200 && js.text.length > 1000, `/ ${home.status}, app.js ${js.status}`);
  const direct = await fetch(`${o.base}/api/v1/me`, { redirect: 'manual' }).catch((e) => ({ status: 0, e }));
  check('an API call without a session is refused', direct.status === 401, `HTTP ${direct.status}`);

  const c = await newLearner(o, 'solo');
  check('sign up, confirm by mail, sign in', true, 'learner ready');
  const cat = await c.request('GET', '/api/v1/challenges');
  check('catalogue lists the eleven challenges', cat.status === 200 && cat.data?.items?.length === 11, `${cat.data?.items?.length} items`);

  const t0 = Date.now();
  const start = await c.request('POST', '/api/v1/instances', { body: { kind: 'learner' } });
  check('request an instance', start.status === 202 && /^i-/.test(start.data?.instance_id ?? ''), `HTTP ${start.status}`);
  const iid = start.data.instance_id; const aid = start.data.attempt_id;
  const run = await waitRunning(c, aid);
  check('the instance becomes ready and the clock starts', run.ok, `${run.seconds} s from the request`);
  if (!run.ok) return finish(o, t00);
  const inst = (await c.request('GET', `/api/v1/instances/${iid}`)).data;
  check('instance state is ready or active with access open', ['ready', 'active', 'idle'].includes(inst?.state) && inst?.access === 'open', `${inst?.state}/${inst?.access}`);

  const ticket = await c.request('POST', `/api/v1/instances/${iid}/open`);
  check('one-time ticket issued', ticket.status === 200 && /^https:\/\/i-[a-z2-7]{16}\.[a-z0-9.-]+\/_vm\/enter\?t=/.test(ticket.data?.url ?? ''), `HTTP ${ticket.status}`);
  const noTicket = await c.request('GET', `https://${new URL(ticket.data.url).host}/`, { json: false });
  check('the instance refuses a visitor without the ticket', [403, 410].includes(noTicket.status), `HTTP ${noTicket.status}`);
  const enter = await c.request('GET', ticket.data.url, { json: false });
  check('the ticket is exchanged for the gate cookie', enter.status === 302 && [...c.cookies.keys()].some((k) => k.startsWith('__Host-vm_gate')), `HTTP ${enter.status}`);
  const again = await c.request('GET', ticket.data.url, { json: false });
  check('the ticket works once only', again.status !== 302, `HTTP ${again.status}`);
  const host = new URL(ticket.data.url).origin;
  const page = await c.request('GET', `${host}/healthz`, { json: false });
  check('the shop answers through the gate and the sidecar', page.status === 200, `HTTP ${page.status} ${page.ms} ms`);

  // FR-SES-11 / handoff H-341: a new login of the same account raises the access epoch of its instance, so the gate refuses the older tab and accepts the new login
  const relogin = new Client(o.base);
  const relog = await relogin.request('POST', '/api/v1/session', { body: { email: c.email, password: c.password } });
  check('the same account signs in a second time', relog.status === 200 && !!relog.data?.csrf_token, `HTTP ${relog.status}`);
  relogin.csrf = relog.data?.csrf_token ?? null;
  let oldTab; for (let i = 0; i < 20; i++) { oldTab = await c.request('GET', `${host}/healthz`, { json: false }); if (oldTab.status !== 200) break; await sleep(1500); }
  check('the older tab loses its access at the gate after the new login', [401, 403, 410].includes(oldTab.status), `HTTP ${oldTab.status}`);
  const t2 = await relogin.request('POST', `/api/v1/instances/${iid}/open`);
  const enter2 = await relogin.request('GET', t2.data?.url ?? `${host}/`, { json: false });
  const page2 = await relogin.request('GET', `${host}/healthz`, { json: false });
  check('the new login gets a new ticket and the shop answers it', t2.status === 200 && enter2.status === 302 && page2.status === 200, `ticket ${t2.status}, enter ${enter2.status}, shop ${page2.status}`);
  for (const [k, v] of relogin.cookies) if (k.startsWith('__Host-vm_gate')) c.cookies.set(k, v); // the rest of the journey continues with the newer gate cookie

  // read a flag the way a player would: the response carries it, the sidecar sees it and tells the platform. The stub shop serves any planted flag at /_stub/planted-flag;
  // the real shop does not, so a player takes C05 from its unauthenticated diagnostics page (the weakness of that challenge).
  const readFlag = async (key) => {
    const stub = await c.request('GET', `${host}/_stub/planted-flag?key=${key}`, { json: false });
    if (stub.status === 200) return stub;
    return key === 'C05' ? c.request('GET', `${host}/_ops/diagnostics`, { json: false }) : stub;
  };
  const planted = await readFlag('C05');
  const m = /VM\{[A-Z2-7]{24}\}/.exec(planted.text);
  check('a flag is read off the shop the way a player would', planted.status === 200 && !!m, `HTTP ${planted.status}`);
  const flag = m?.[0] ?? 'VM{missing}';
  await sleep(2500);
  const afterSeen = (await c.request('GET', `/api/v1/attempts/${aid}/challenges`)).data?.items?.find((x) => x.challenge_key === 'C05');
  check('the sidecar saw the flag and the platform credited the challenge', afterSeen?.solved === true || afterSeen?.held === true, `${afterSeen?.best_milestone}${afterSeen?.held ? ' held' : ''}`);
  // player experience (IF-2 1.2.0): every challenge says what it is and how to begin; the write-up appears only after a capture
  const progress = (await c.request('GET', `/api/v1/attempts/${aid}/challenges`)).data?.items ?? [];
  const bare = progress.filter((x) => !x.brief || !x.start).map((x) => x.challenge_key);
  check('every challenge carries a brief and a start text', progress.length >= 11 && bare.length === 0, bare.length ? `missing: ${bare.join(',')}` : `${progress.length} challenges`);
  check('a write-up is shown only for solved challenges', progress.every((x) => (x.write_up !== undefined) === (x.solved === true)), `${progress.filter((x) => x.write_up).length} shown`);
  // audit blocker B1: the platform tells the orchestrator that the player is active, so the idle limit counts from play and not from "ready"
  let act; for (let i = 0; i < 45; i++) { act = (await c.request('GET', `/api/v1/instances/${iid}`)).data; if (act?.state === 'active') break; await sleep(2000); }
  check('the orchestrator is told the player is active (the idle limit counts from play)', act?.state === 'active', act?.state);

  const wrong = await c.request('POST', `/api/v1/attempts/${aid}/flags`, { body: { challenge_key: 'C02', flag: 'VM{WRONGWRONGWRONGWRONGWRONG}' } });
  check('a wrong flag is incorrect', wrong.status === 200 && wrong.data?.result === 'incorrect', `credit ${wrong.data?.credit}`);
  const right = await c.request('POST', `/api/v1/attempts/${aid}/flags`, { body: { challenge_key: 'C05', flag } });
  check('the right flag is correct and credited', right.status === 200 && right.data?.result === 'correct' && right.data?.credit === 'credited', `${right.data?.result}/${right.data?.credit}`);
  const hint = await c.request('POST', `/api/v1/attempts/${aid}/challenges/C03/hints/1/unlock`);
  check('a hint unlocks', hint.status === 200 && hint.data?.unlocked === true, `HTTP ${hint.status}`);
  const score = (await c.request('GET', `/api/v1/attempts/${aid}/score`)).data;
  check('the score counts the capture', score?.score > 0, `score ${score?.score}`);

  const before = (await readFlag('C05')).text.match(/VM\{[A-Z2-7]{24}\}/)?.[0];
  const reset = await c.request('POST', `/api/v1/instances/${iid}/reset`, { body: { confirm: true } });
  check('reset starts a new round', reset.status === 202 && reset.data?.epoch === 2, `epoch ${reset.data?.epoch}`);
  let back; for (let i = 0; i < 60; i++) { back = (await c.request('GET', `/api/v1/instances/${iid}`)).data; if (['ready', 'active', 'idle'].includes(back?.state)) break; await sleep(2000); }
  check('the instance is ready again after the reset', ['ready', 'active', 'idle'].includes(back?.state), `${back?.state}`);
  const stale = await c.request('POST', `/api/v1/attempts/${aid}/flags`, { body: { challenge_key: 'C05', flag: before ?? 'VM{missing}' } });
  check('a flag of the old round no longer counts', stale.status === 200 && stale.data?.result === 'incorrect', `${stale.data?.result}`);
  const fresh = (await readFlag('C05')).text.match(/VM\{[A-Z2-7]{24}\}/)?.[0];
  check('the new round has other flags', !!fresh && fresh !== before);
  const second = await c.request('POST', `/api/v1/attempts/${aid}/flags`, { body: { challenge_key: 'C05', flag: fresh ?? 'VM{missing}' } });
  check('a flag of the new round counts', second.status === 200 && second.data?.result === 'correct', `${second.data?.result}/${second.data?.credit}`);  const tl = (await c.request('GET', `/api/v1/attempts/${aid}/timeline`)).data;
  check('the timeline tells the story', tl?.items?.some((e) => e.type === 'attempt.started') && tl.items.some((e) => e.type === 'flag.submitted') && tl.items.some((e) => e.type === 'instance.reset'), `${tl?.items?.length} entries`);
  const submit = await c.request('POST', `/api/v1/attempts/${aid}/submit`, { body: { confirm: true } });
  check('submit ends the attempt', submit.status === 200 && submit.data?.state === 'submitted', `${submit.data?.state}`);
  const frozen = await c.request('GET', `/api/v1/instances/${iid}`);
  check('the instance is frozen after the submit', frozen.data?.access === 'frozen', `${frozen.data?.access}`);
  const rep = (await c.request('GET', `/api/v1/attempts/${aid}/report`)).data;
  check('the report has the score, the time and the hints', rep?.score > 0 && rep?.elapsed_seconds != null && rep.hints_used_total === 1, `score ${rep?.score}, ${rep?.elapsed_seconds} s`);
  check('no answer shows the flag', ![JSON.stringify(rep), JSON.stringify(tl), JSON.stringify(score)].some((t) => t.includes(flag)));
  return finish(o, t00, { aid, iid, startToRunning: run.seconds, total: Math.round((Date.now() - t0) / 100) / 10 });
}

async function load(o) {
  console.log(`load: ${o.load} learners`);
  const learners = [];
  for (let i = 0; i < o.load; i++) learners.push(await newLearner(o, `load${i}`));
  check(`${o.load} accounts made, confirmed and signed in`, true);
  const t0 = Date.now();
  const results = await Promise.all(learners.map(async (c) => {
    const s = await c.request('POST', '/api/v1/instances', { body: { kind: 'learner' } });
    if (s.status !== 202) return { ok: false, why: `HTTP ${s.status} ${s.data?.code ?? ''}` };
    const r = await waitRunning(c, s.data.attempt_id, 300);
    return { ok: r.ok, seconds: r.seconds, why: r.ok ? '' : `state ${r.attempt?.state}`, c, iid: s.data.instance_id };
  }));
  // the test frees what it used: each learner stops their own instance through the normal route (a load check once left five of the seven slots of vm-i busy for a day)
  const stopped = await Promise.all(results.filter((r) => r.iid).map(async (r) => (await r.c.request('POST', `/api/v1/instances/${r.iid}/stop`)).status));
  check('the instances of the load check were stopped by their owners', stopped.every((st) => st === 202 || st === 200), `${stopped.filter((st) => st === 202 || st === 200).length} of ${stopped.length}`);
  const ok = results.filter((r) => r.ok); const secs = ok.map((r) => r.seconds).sort((a, b) => a - b);
  const q = (p) => secs[Math.min(secs.length - 1, Math.floor(secs.length * p))];
  check(`${ok.length} of ${o.load} instances became ready`, ok.length === o.load, `first ${secs[0]} s, median ${q(0.5)} s, p90 ${q(0.9)} s, slowest ${secs.at(-1)} s, wall ${(Date.now() - t0) / 1000} s; failures: ${results.filter((r) => !r.ok).map((r) => r.why).join(' | ') || 'none'}`);
  rows.load = { users: o.load, ready: ok.length, seconds: secs };
  return finish(o, Date.now() - 1);
}

function finish(o, t00, extra = {}) {
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length} PASS, ${failed.length} FAIL`);
  if (o.json) fs.writeFileSync(o.json, `${JSON.stringify({ at: new Date().toISOString(), base: o.base, rows: [...rows], ...extra, load: rows.load }, null, 2)}\n`);
  return failed.length ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) { console.error(o.error); return 2; }
  try { return o.load ? await load(o) : await journey(o); } catch (e) { console.error(`FAIL ${e.message}`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
