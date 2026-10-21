// Is the data of the live platform stored, and stored accurately? Real HTTPS calls to the deployed site, and the row counts of the live database before and after.
//   node scripts/verify-live-data.mjs --base https://<platform host> --email <you@gmail.com> [--verified-email <address> --verified-name <display name>]
// Needs the shell the deploy uses (AWS_PROFILE set), because the counts come from `node scripts/live-deploy.mjs data-counts` (counts of tables, never a value).
// What it does: signs up one learner and one recruiter (plus-addressed copies of --email, so the confirmation mails reach you), signs up the same learner again,
// tries a right password, a wrong password and an unknown address, and then checks the database: exactly one new user per sign-up, the recruiter's company and its
// membership, a confirmation token and a queued mail per account, no table lost a row, the migration head did not move.
// With --verified-email (an account you confirmed by the mail link) and the password in VM_VERIFIED_PASSWORD it also signs in and checks the stored display name.
// It never prints a password, a cookie or a token. The passwords are random and used once.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const o = {};
  const names = { '--base': 'base', '--email': 'email', '--verified-email': 'verifiedEmail', '--verified-name': 'verifiedName' };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key) return { error: `unknown argument ${argv[i]}` };
    if (argv[i + 1] === undefined) return { error: `${argv[i]} needs a value` };
    o[key] = argv[++i];
  }
  if (!o.base || !o.email) return { error: 'usage: node scripts/verify-live-data.mjs --base https://<platform host> --email <address> [--verified-email <address> --verified-name <name>]' };
  let u;
  try { u = new URL(o.base); } catch { return { error: '--base is not a URL' }; }
  if (u.protocol !== 'https:' || u.pathname !== '/') return { error: '--base must be an https origin' };
  o.base = u.origin;
  if (!/^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(o.email)) return { error: '--email must be a plain address (no plus part)' };
  return o;
}

/** "name@host" -> "name+tag@host". */
export const plus = (email, tag) => email.replace('@', `+${tag}@`);

/** Parse the lines `<table> <value>` of `data-counts` into a Map; the migration head stays a string, the counts become numbers. */
export function parseCounts(text) {
  const m = new Map();
  for (const line of text.split(/\r?\n/)) {
    const hit = /^([a-z_0-9]+) (\S+)$/.exec(line.trim());
    if (hit) m.set(hit[1], hit[1] === 'alembic_version' ? hit[2] : Number(hit[2]));
  }
  return m;
}

/** The checks on two snapshots: what the sign-ups must have written and what must not have changed. Returns [{name, ok, detail}]. */
export function judge(before, after, { recruiters, accounts }) {
  const learners = accounts - recruiters; // a learner gets a `learner` role row at sign-up; a recruiter's account type is on the user row and its membership is the organisation's
  const d = (t) => (after.get(t) ?? 0) - (before.get(t) ?? 0);
  const lost = [...before].filter(([t, v]) => t !== 'alembic_version' && (after.get(t) ?? -1) < v).map(([t]) => t);
  return [
    { name: 'the migration head did not move', ok: before.get('alembic_version') === after.get('alembic_version'), detail: `${before.get('alembic_version')} -> ${after.get('alembic_version')}` },
    { name: `users grew by exactly ${accounts} (the repeated sign-up made no second row)`, ok: d('users') === accounts, detail: `+${d('users')}` },
    { name: `user_roles grew by ${learners} (the learner's role)`, ok: d('user_roles') === learners, detail: `+${d('user_roles')}` },
    { name: `organizations grew by ${recruiters} (the recruiter's company)`, ok: d('organizations') === recruiters, detail: `+${d('organizations')}` },
    { name: `org_members grew by ${recruiters}`, ok: d('org_members') === recruiters, detail: `+${d('org_members')}` },
    { name: 'a confirmation token per account', ok: d('email_tokens') >= accounts, detail: `+${d('email_tokens')}` },
    { name: 'a mail queued per account', ok: d('email_outbox') >= accounts, detail: `+${d('email_outbox')}` },
    { name: 'no table lost a row', ok: lost.length === 0, detail: lost.join(', ') || 'none' },
  ];
}

const rows = [];
const check = (name, ok, detail = '') => { rows.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); return !!ok; };

function counts() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'live-deploy.mjs'), 'data-counts'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`data-counts failed: ${String(r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}`);
  return parseCounts(r.stdout);
}

async function call(base, method, route, body, jar) {
  const headers = { accept: 'application/json', origin: base };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar?.cookie) headers.cookie = jar.cookie;
  if (jar?.csrf && method !== 'GET') headers['x-csrf-token'] = jar.csrf;
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (jar) {
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar.cookie = [...new Map([...(jar.cookie ?? '').split('; ').filter(Boolean), ...set.map((c) => c.split(';')[0])].map((c) => [c.split('=')[0], c])).values()].join('; ');
  }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) { console.error(o.error); return 2; }
  const nonce = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const learner = plus(o.email, `vmdata${nonce}a`);
  const recruiter = plus(o.email, `vmdata${nonce}r`);
  const password = crypto.randomBytes(18).toString('base64url');
  const wrong = crypto.randomBytes(18).toString('base64url');

  const before = counts();
  console.log(`rows read: ${before.size - 1} tables, migration head ${before.get('alembic_version')}`);

  const a = await call(o.base, 'POST', '/api/v1/accounts', { email: learner, password, display_name: 'Data check learner', age_declaration: true });
  check('the learner sign-up is accepted', a.status === 202 && a.data?.status === 'accepted', `HTTP ${a.status}`);
  const again = await call(o.base, 'POST', '/api/v1/accounts', { email: learner, password, display_name: 'Data check learner', age_declaration: true });
  check('the same sign-up again gives the same answer (no account enumeration)', again.status === a.status && again.data?.status === a.data?.status, `HTTP ${again.status}`);
  const r = await call(o.base, 'POST', '/api/v1/recruiters', { email: recruiter, password, display_name: 'Data check recruiter', company_name: `Data check ${nonce}` });
  check('the recruiter sign-up is accepted', r.status === 202 && r.data?.status === 'accepted', `HTTP ${r.status}`);

  const right = await call(o.base, 'POST', '/api/v1/session', { email: learner, password });
  check('the stored account is found and the password is right: only the confirmation is missing', right.data?.code === 'AUTH-EMAIL-NOT-VERIFIED', `${right.status} ${right.data?.code ?? ''}`);
  const bad = await call(o.base, 'POST', '/api/v1/session', { email: learner, password: wrong });
  check('a wrong password is refused', bad.data?.code === 'AUTH-INVALID-CREDENTIALS', `${bad.status} ${bad.data?.code ?? ''}`);
  const unknown = await call(o.base, 'POST', '/api/v1/session', { email: plus(o.email, `vmdata${nonce}x`), password });
  check('an unknown address gets the same refusal as a wrong password', unknown.data?.code === 'AUTH-INVALID-CREDENTIALS', `${unknown.status} ${unknown.data?.code ?? ''}`);

  await new Promise((res) => setTimeout(res, 4000));
  const after = counts();
  for (const j of judge(before, after, { recruiters: 1, accounts: 2 })) check(j.name, j.ok, j.detail);

  if (process.env.VM_VERIFIED_PASSWORD && o.verifiedEmail) {
    const jar = {};
    const s = await call(o.base, 'POST', '/api/v1/session', { email: o.verifiedEmail, password: process.env.VM_VERIFIED_PASSWORD }, jar);
    check('a confirmed account signs in', s.status === 200 || s.status === 201, `HTTP ${s.status}`);
    if (s.data?.csrf_token) jar.csrf = s.data.csrf_token;
    const me = await call(o.base, 'GET', '/api/v1/me', undefined, jar);
    check('the stored profile is returned', me.status === 200 && me.data?.email === o.verifiedEmail, `HTTP ${me.status}`);
    if (o.verifiedName) check('the stored display name is exactly what was typed', me.data?.display_name === o.verifiedName);
  }

  const failed = rows.filter((x) => !x.ok).length;
  console.log(`SUMMARY: ${rows.length - failed} PASS, ${failed} FAIL against ${o.base}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
