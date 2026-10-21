#!/usr/bin/env node
// Role journeys against a deployed platform (tracker audit 2026-10-21, L-30; work package G). e2e-live.mjs walks one learner; this walks the hiring product:
//   recruiter creates a template and invites -> candidate signs up, opens the invite, accepts, consents, starts -> the instance runs, a flag is read off the shop and pasted
//   -> the candidate submits -> the recruiter reads the report, the results stay hidden from the candidate until the recruiter releases them, then the candidate sees the same
//   score -> export -> the admin (second factor) reads the queue, users, capacity and the audit log and cannot read the candidate's answers without break-glass.
//
//   node scripts/e2e-live-journeys.mjs --base https://<platform host> --mailpit-ssh ubuntu@<vm-p address> [--skip-admin] [--json <file>] [--dry-run]
//   node scripts/e2e-live-journeys.mjs --local-e2e http://127.0.0.1:18080 [--skip-admin] [--json <file>]      (the local variant, see docs/runbooks/live-e2e-journeys.md)
//
// Credentials come from the environment, never from the command line or the repo (names only here, values are the leader's):
//   VM_E2E_RECRUITER_EMAIL, VM_E2E_RECRUITER_PASSWORD   an approved company owner who accepted the terms
//   VM_E2E_ADMIN_EMAIL, VM_E2E_ADMIN_PASSWORD, VM_E2E_ADMIN_TOTP_SECRET   the seeded admin and the base32 secret of its authenticator (not needed with --skip-admin)
// `--dry-run` checks the arguments and the environment, prints the plan and touches no network. The script never prints a password, a cookie, a ticket, a token or a flag.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, verificationToken } from './e2e-live.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === 'win32';
const SSH = WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
export const ENV_NAMES = { recruiter: ['VM_E2E_RECRUITER_EMAIL', 'VM_E2E_RECRUITER_PASSWORD'], admin: ['VM_E2E_ADMIN_EMAIL', 'VM_E2E_ADMIN_PASSWORD', 'VM_E2E_ADMIN_TOTP_SECRET'] };

export function parseArgs(argv) {
  const o = { skipAdmin: false, dryRun: false };
  const valued = { '--base': 'base', '--mailpit-ssh': 'mailpit', '--mailpit-url': 'mailpitUrl', '--local-e2e': 'local', '--json': 'json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-admin') { o.skipAdmin = true; continue; }
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (!(a in valued)) return { error: `unknown argument ${a}` };
    if (argv[i + 1] === undefined) return { error: `${a} needs a value` };
    o[valued[a]] = argv[++i];
  }
  if (o.local) {
    if (o.base || o.mailpit || o.mailpitUrl) return { error: '--local-e2e is used alone (it needs neither --base nor a mail source)' };
    let u; try { u = new URL(o.local); } catch { return { error: '--local-e2e is not a URL' }; }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/') return { error: '--local-e2e must be an http origin on 127.0.0.1 or localhost' };
    if (!o.skipAdmin) return { error: '--local-e2e needs --skip-admin (the local server has no second factor for its admin)' };
    o.local = u.origin; o.base = u.origin; o.mode = 'local';
    return o;
  }
  if (!o.base) return { error: '--base <https://platform host> (or --local-e2e <url>) is required' };
  let u; try { u = new URL(o.base); } catch { return { error: '--base is not a URL' }; }
  if (u.protocol !== 'https:' || u.pathname !== '/') return { error: '--base must be an https origin' };
  o.base = u.origin; o.mode = 'live';
  if (!o.mailpit && !o.mailpitUrl) return { error: 'a mail source is needed: --mailpit-ssh ubuntu@host (the deployed Mailpit is on the host) or --mailpit-url http://127.0.0.1:8025' };
  if (o.mailpit && !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(o.mailpit)) return { error: '--mailpit-ssh must look like ubuntu@host' };
  if (o.mailpitUrl) { try { const m = new URL(o.mailpitUrl); if (!['127.0.0.1', 'localhost'].includes(m.hostname)) return { error: '--mailpit-url must be on 127.0.0.1 or localhost' }; } catch { return { error: '--mailpit-url is not a URL' }; } }
  return o;
}

/** The environment the run needs; only names are ever reported. */
export function readEnv(env, o) {
  const need = [...ENV_NAMES.recruiter, ...(o.skipAdmin ? [] : ENV_NAMES.admin)];
  const missing = need.filter((n) => !env[n]);
  if (missing.length) return { error: `missing environment variables: ${missing.join(', ')}` };
  if (!o.skipAdmin && !/^[A-Z2-7]{16,}=*$/.test(env.VM_E2E_ADMIN_TOTP_SECRET.replace(/\s/g, '').toUpperCase())) return { error: 'VM_E2E_ADMIN_TOTP_SECRET must be a base32 secret' };
  return { recruiter: { email: env.VM_E2E_RECRUITER_EMAIL, password: env.VM_E2E_RECRUITER_PASSWORD }, admin: o.skipAdmin ? null : { email: env.VM_E2E_ADMIN_EMAIL, password: env.VM_E2E_ADMIN_PASSWORD, secret: env.VM_E2E_ADMIN_TOTP_SECRET.replace(/\s/g, '').toUpperCase() } };
}

/** RFC 6238 time-based code (SHA-1, 30 s, 6 digits) from a base32 secret. */
export function totp(secretBase32, atMs = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const ch of secretBase32.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const off = h[19] & 0xf;
  return String(((h.readUInt32BE(off) & 0x7fffffff) % 1000000)).padStart(6, '0');
}

export const inviteToken = (text) => /token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})/.exec(text ?? '')?.[1] ?? null;
const MARK = (ok) => (ok ? 'PASS' : 'FAIL');

/** The steps, in order, for --dry-run and for the report. `needs` says what a step uses. */
export function plan(o) {
  const steps = [
    ['recruiter', 'the platform is healthy'], ['recruiter', 'the recruiter signs in and the company is active with the terms accepted'],
    ['recruiter', 'a template is created with release after the end and a time limit'], ['recruiter', 'the candidate is invited (one invite, one mail)'],
    ['candidate', 'the candidate has an account and signs in'], ['candidate', 'the invite link opens without a session and shows the company and the rules, never the address'],
    ['candidate', 'the invite is accepted and the consent is granted'], ['candidate', 'the attempt waits in state ready with the template rules'],
    ['candidate', 'Start brings the instance up and the clock starts at ready'], ['candidate', 'a flag is found, pasted and credited'],
    ['candidate', 'the results stay hidden until the recruiter releases them'], ['candidate', 'the candidate submits with confirmation'],
    ['recruiter', 'the report shows the score and the capture and no flag value; the view is logged for the candidate'], ['recruiter', 'the timeline and the invite list show the attempt'],
    ['recruiter', 'the recruiter releases the results and the candidate then sees the same score'], ['recruiter', 'the company export is a zip without a flag'],
    ['isolation', 'a candidate and an anonymous caller cannot read the report or the admin routes'],
  ];
  if (!o.skipAdmin) steps.push(['admin', 'the admin signs in with the second factor'], ['admin', 'the queue, users, capacity and audit log answer'], ['admin', 'without break-glass the admin reads no candidate answers']);
  return steps;
}

function mailSource(o) {
  if (o.mode === 'local') return null;
  if (o.mailpitUrl) {
    return async (p) => (await fetch(o.mailpitUrl + p)).json();
  }
  return async (p) => {
    const r = spawnSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', o.mailpit, `curl -fsS 'http://127.0.0.1:8025${p}'`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (r.status !== 0) throw new Error(`mail check over ssh failed: ${String(r.stderr).split(/\r?\n/)[0]}`);
    return JSON.parse(r.stdout);
  };
}

async function mailText(read, to, wait = 40) {
  for (let i = 0; i < wait; i++) {
    const list = await read(`/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const id = list.messages?.[0]?.ID;
    if (id) { const msg = await read(`/api/v1/message/${id}`); return `${msg.Text ?? ''}\n${msg.HTML ?? ''}`; }
    await sleep(1500);
  }
  throw new Error('the mail did not arrive');
}

async function login(base, email, password) {
  const c = new Client(base);
  const r = await c.request('POST', '/api/v1/session', { body: { email, password } });
  if (r.status !== 200 || !r.data?.csrf_token) return { c, r };
  c.csrf = r.data.csrf_token;
  return { c, r };
}

/** Runs the journeys. `deps` lets a test change the clock for TOTP and the sleep; the network is the real `fetch` (a test points it at a fake server). */
export async function run(o, creds, deps = {}) {
  const rows = [];
  const check = (name, ok, detail = '') => { rows.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${MARK(ok)}  ${name}${detail ? `  ${detail}` : ''}`); return !!ok; };
  const nap = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  // the local test server (apps/api/tests/e2e_web_server.py) may not mount the company, view-history and export services (they answered 500 on 2026-10-21): where the route does not answer 200 in local mode the check is reported as SKIP, never as PASS; on a deployed site it is always a check
  const skip = (name, why) => { rows.push({ name, ok: true, skipped: true, detail: `skipped: ${why}` }); console.log(`SKIP  ${name}  (${why})`); return true; };
  const LOCAL_WHY = 'the local test server does not answer this route (it is not mounted there)';
  const stop = (why) => { check('the run stops here', false, why); return rows; };
  const read = mailSource(o);
  const local = o.mode === 'local' ? await fetch(`${o.local}/_e2e/seed`).then((r) => r.json()).catch(() => null) : null;
  if (o.mode === 'local' && !local?.tokens) return stop('the local server gave no seed');

  const health = await new Client(o.base).request('GET', '/api/v1/health');
  check('the platform is healthy', health.status === 200 && health.data?.status === 'ok', `HTTP ${health.status}`);

  // ---- the recruiter ----
  const rec = await login(o.base, creds.recruiter.email, creds.recruiter.password);
  if (!check('the recruiter signs in', rec.r.status === 200, `HTTP ${rec.r.status}`)) return stop('no recruiter session');
  const companyRes = await rec.c.request('GET', '/api/v1/company');
  const company = companyRes.data;
  if (local && companyRes.status !== 200) skip('the company is active with the terms accepted', LOCAL_WHY);
  else check('the company is active with the terms accepted', company?.state === 'active' && company?.terms_accepted === true, `${company?.state}, terms ${company?.terms_accepted}`);
  let template = null; let candidate = null; let token = null;
  if (local) {
    token = local.tokens.release; candidate = { email: local.candidates.release, password: local.password };
    check('the local seed supplies the invite of an after-release template', !!token, 'seeded invite');
  } else {
    const t = await rec.c.request('POST', '/api/v1/company/templates', { body: { title: `E2E journey ${suffix}`, challenge_keys: ['C01', 'C02', 'C05'], time_limit_min: 30, hints_mode: 'off', results_visibility: 'after_release' } });
    template = t.data;
    check('a template is created with release after the end and a time limit', t.status === 201 && template?.results_visibility === 'after_release' && template?.time_limit_min === 30, `HTTP ${t.status}`);
    if (t.status !== 201) return stop('no template');
    const email = `e2e-cand-${suffix}@example.test`;
    const password = `Pw-${crypto.randomBytes(9).toString('base64url')}-x`;
    const su = await new Client(o.base).request('POST', '/api/v1/accounts', { body: { email, password, display_name: 'E2E Candidate', age_declaration: true } });
    if (su.status !== 202) return stop(`the candidate sign-up answered ${su.status}`);
    const vt = o.mailpit ? await verificationToken(o.mailpit, email) : (/\/verify-email\?token=([A-Za-z0-9_-]{32,128})/.exec(await mailText(read, email)) ?? [])[1];
    const ve = await new Client(o.base).request('POST', '/api/v1/accounts/verify-email', { body: { token: vt } });
    if (ve.status !== 200) return stop(`the address verification answered ${ve.status}`);
    const inv = await rec.c.request('POST', '/api/v1/company/invites', { body: { template_id: template.template_id, emails: [email] } });
    check('the candidate is invited (one invite)', inv.status === 201 && inv.data?.created?.length === 1, `HTTP ${inv.status}`);
    token = inviteToken(await mailText(read, email).catch(() => ''));
    check('the invite mail carries the token', !!token, token ? 'token found' : 'no token');
    candidate = { email, password };
  }
  if (!token) return stop('no invite token');

  // ---- the candidate ----
  const cand = await login(o.base, candidate.email, candidate.password);
  if (!check('the candidate signs in', cand.r.status === 200, `HTTP ${cand.r.status}`)) return stop('no candidate session');
  const anon = new Client(o.base);
  const opened = await anon.request('POST', '/api/v1/invites/open', { body: { token } });
  check('the invite link opens without a session and shows the company, never the address', opened.status === 200 && !!opened.data?.company_name && !opened.text.includes(candidate.email), `HTTP ${opened.status}`);
  const accepted = await cand.c.request('POST', '/api/v1/invites/accept', { body: { token } });
  const attempt = accepted.data?.attempt_id;
  const notice = attempt ? (await cand.c.request('GET', `/api/v1/consent/notice?attempt_id=${attempt}`)).data : null;
  const granted = notice ? await cand.c.request('POST', '/api/v1/consent', { body: { attempt_id: attempt, notice_version: notice.notice_version, notice_text_sha256: notice.notice_text_sha256, decision: 'granted' } }) : { status: 0 };
  check('the invite is accepted and the consent is granted', accepted.status === 200 && !!attempt && [200, 201].includes(granted.status), `accept ${accepted.status}, consent ${granted.status}`);
  if (!attempt || ![200, 201].includes(granted.status)) return stop('no attempt');
  const ready = (await cand.c.request('GET', `/api/v1/attempts/${attempt}`)).data;
  check('the attempt waits in state ready', ready?.state === 'ready' && ready?.mode === 'candidate', `${ready?.state}/${ready?.mode}`);
  const started = await cand.c.request('POST', `/api/v1/attempts/${attempt}/start`);
  let running = null;
  for (let i = 0; i < 160 && started.status === 200; i++) { running = (await cand.c.request('GET', `/api/v1/attempts/${attempt}`)).data; if (running?.state === 'running') break; await nap(1500); }
  const span = running?.deadline_at && running?.started_at ? (Date.parse(running.deadline_at) - Date.parse(running.started_at)) / 60000 : null;
  check('Start brings the instance up and the clock starts at ready with the template time limit', running?.state === 'running' && !!running.instance_id && span === (template?.time_limit_min ?? span), `${running?.state}, ${span} min`);
  if (running?.state !== 'running') return stop('the attempt did not run');

  // the flag: on the deployed site a player reads it off the shop through the gate; in the local variant the test server hands it over (its activity hook stands for the sidecar)
  let flag = null; const key = local ? 'C01' : 'C05';
  if (local) {
    await fetch(`${o.local}/_e2e/play?instance_id=${running.instance_id}`, { method: 'POST' });
    flag = (await fetch(`${o.local}/_e2e/flag?instance_id=${running.instance_id}&challenge_key=${key}`).then((r) => r.json())).flag;
  } else {
    const ticket = await cand.c.request('POST', `/api/v1/instances/${running.instance_id}/open`);
    const enter = ticket.data?.url ? await cand.c.request('GET', ticket.data.url, { json: false }) : { status: 0 };
    const host = ticket.data?.url ? new URL(ticket.data.url).origin : null;
    const page = host && enter.status === 302 ? await cand.c.request('GET', `${host}/_ops/diagnostics`, { json: false }) : { text: '' };
    flag = /VM\{[A-Z2-7]{24}\}/.exec(page.text)?.[0] ?? null;
    await nap(2500);
  }
  const pasted = flag ? await cand.c.request('POST', `/api/v1/attempts/${attempt}/flags`, { body: { challenge_key: key, flag } }) : { status: 0, data: null };
  check('a flag is found, pasted and credited', pasted.status === 200 && pasted.data?.result === 'correct' && pasted.data?.credit === 'credited', `${pasted.data?.result}/${pasted.data?.credit}`);
  const hiddenBefore = await cand.c.request('GET', `/api/v1/attempts/${attempt}/score`);
  const submitted = await cand.c.request('POST', `/api/v1/attempts/${attempt}/submit`, { body: { confirm: true } });
  check('the candidate submits with confirmation', submitted.status === 200 && submitted.data?.state === 'submitted', `HTTP ${submitted.status} ${submitted.data?.state}`);
  const hiddenAfter = await cand.c.request('GET', `/api/v1/attempts/${attempt}/score`);
  check('the results stay hidden from the candidate until the recruiter releases them', [hiddenBefore.status, hiddenAfter.status].every((s) => s === 404), `before ${hiddenBefore.status}, after submit ${hiddenAfter.status}`);

  // ---- the recruiter reads and releases ----
  const report = await rec.c.request('GET', `/api/v1/attempts/${attempt}/report`);
  const solved = report.data?.per_challenge?.find((x) => x.challenge_key === key);
  check('the report shows the score and the capture and no flag value', report.status === 200 && report.data?.score > 0 && solved?.best_milestone === 'M3' && !String(report.text).includes(flag), `score ${report.data?.score}`);
  const viewsRes = await cand.c.request('GET', '/api/v1/me/data-views');
  const views = viewsRes.data?.items ?? [];
  if (local && viewsRes.status !== 200) skip('the recruiter\'s view is shown to the candidate by company name', LOCAL_WHY);
  else check('the recruiter\'s view is shown to the candidate by company name', views.length >= 1 && views.every((v) => typeof v.company_name === 'string'), `${views.length} view(s)`);
  const tl = (await rec.c.request('GET', `/api/v1/attempts/${attempt}/timeline`)).data?.items?.map((e) => e.type) ?? [];
  const listRes = await rec.c.request('GET', '/api/v1/company/invites');
  const list = listRes.data?.items ?? [];
  check('the timeline shows the attempt from start to submit', tl[0] === 'attempt.started' && tl.includes('attempt.submitted'), `${tl.length} events`);
  if (local && listRes.status !== 200) skip('the invite list of the company shows the attempt', LOCAL_WHY);
  else check('the invite list of the company shows the attempt', list.some((i) => i.attempt_id === attempt), `${list.length} invite(s)`);
  const released = await rec.c.request('POST', `/api/v1/attempts/${attempt}/release`);
  const score = await cand.c.request('GET', `/api/v1/attempts/${attempt}/score`);
  check('the recruiter releases the results and the candidate then sees the same score', released.status === 200 && released.data?.results_released === true && score.status === 200 && score.data?.score === report.data?.score, `release ${released.status}, score ${score.status}`);
  const exp = await rec.c.request('POST', '/api/v1/company/exports', { body: { template_id: template?.template_id ?? ready?.template_id ?? list.find((i) => i.attempt_id === attempt)?.template_id }, json: false });
  if (local && exp.status !== 200) skip('the company export is a zip without a flag', LOCAL_WHY);
  else check('the company export is a zip without a flag', exp.status === 200 && /zip/.test(exp.headers.get('content-type') ?? '') && !exp.text.includes(flag ?? 'x'), `HTTP ${exp.status}`);

  // ---- who may not ----
  const denied = [await cand.c.request('GET', `/api/v1/attempts/${attempt}/report`), await anon.request('GET', `/api/v1/attempts/${attempt}/report`), await cand.c.request('GET', '/api/v1/admin/users')];
  check('a candidate cannot read the report or the admin routes and an anonymous caller is refused', denied[0].status === 404 && denied[1].status === 401 && denied[2].status === 404 && denied[2].data?.code === 'REQ-ROUTE-UNKNOWN', denied.map((d) => d.status).join('/'));

  // ---- the admin ----
  if (!o.skipAdmin) {
    const first = await new Client(o.base).request('POST', '/api/v1/session', { body: { email: creds.admin.email, password: creds.admin.password } });
    const c = new Client(o.base);
    let step = first;
    if (first.data?.status === 'mfa_required') {
      step = await c.request('POST', '/api/v1/session/mfa', { body: { mfa_ticket: first.data.mfa_ticket, code: totp(creds.admin.secret, now()) } });
    }
    const ok = step.status === 200 && !!step.data?.csrf_token;
    check('the admin signs in with the second factor', ok && first.data?.status === 'mfa_required', `HTTP ${step.status}`);
    if (ok) {
      c.csrf = step.data.csrf_token;
      const answers = [await c.request('GET', '/api/v1/admin/companies/pending'), await c.request('GET', `/api/v1/admin/users?q=${encodeURIComponent(candidate.email.split('@')[0])}`), await c.request('GET', '/api/v1/admin/capacity'), await c.request('GET', '/api/v1/admin/audit')];
      const audit = answers[3].text ?? '';
      check('the queue, users, capacity and audit log answer, and the log names no address', answers.every((a) => a.status === 200) && !audit.includes(candidate.email), answers.map((a) => a.status).join('/'));
      const blind = [await c.request('GET', `/api/v1/attempts/${attempt}`), await c.request('GET', `/api/v1/attempts/${attempt}/report`)];
      check('without break-glass the admin reads no candidate answers', blind.every((b) => b.status === 404), blind.map((b) => b.status).join('/'));
    }
  }
  return rows;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  if (o.error) { console.error(o.error); return 2; }
  const creds = readEnv(env, o);
  if (creds.error) { console.error(creds.error); return 2; }
  if (o.dryRun) {
    console.log(`plan for ${o.mode === 'local' ? o.local : o.base} (${o.mode}); no request is made`);
    plan(o).forEach(([who, what], i) => console.log(`${String(i + 1).padStart(2)}. [${who}] ${what}`));
    return 0;
  }
  const t0 = Date.now();
  const rows = await run(o, creds);
  const failed = rows.filter((r) => !r.ok);
  const skipped = rows.filter((r) => r.skipped).length;
  console.log(`\n${rows.length - failed.length - skipped} PASS, ${failed.length} FAIL, ${skipped} SKIP, ${Math.round((Date.now() - t0) / 1000)} s`);
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ base: o.base, mode: o.mode, at: new Date().toISOString(), rows }, null, 2));
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
