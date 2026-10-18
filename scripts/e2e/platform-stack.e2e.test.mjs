// End-to-end test of the platform and web profiles (stories P-01, P-06 and P-07) against the REAL Docker engine.
// Needs Docker running and the host ports 3000, 8000 and 8025 free.
// Run: node --test "scripts/e2e/platform-stack.e2e.test.mjs"   (about 2 minutes on a warm machine)
// Node built-ins only. The stack is started once, then the tests inspect and disturb it, then `down` is checked last.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV = path.join(ROOT, 'scripts', 'dev.mjs');
const COMPOSE = path.join(ROOT, 'infra', 'compose', 'compose.yaml');
const SERVICES = ['postgres', 'valkey', 'mailpit', 'api', 'worker', 'web'];
const ONE_SHOT = ['migrate']; // runs the migrations, exits 0 before the API starts (story P-06)
const NAME = (s) => `vulnmart-${s}`;
const PORTS = [3000, 8000, 8025];

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 240000, ...opts });
const dev = (...args) => sh(process.execPath, [DEV, ...args], { cwd: ROOT, timeout: 420000 });
const docker = (...args) => sh('docker', args);
const composeDown = () =>
  docker('compose', '-f', COMPOSE, '--profile', 'platform', '--profile', 'web', 'down', '--remove-orphans', '--timeout', '2');
const present = () =>
  docker('ps', '-a', '--filter', 'name=vulnmart-', '--format', '{{.Names}}').stdout.split(/\r?\n/).filter((n) => [...SERVICES, ...ONE_SHOT].map(NAME).includes(n));
const inspect = (service) => JSON.parse(docker('inspect', NAME(service)).stdout)[0];
const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  return { status: res.status, body: await res.json() };
}
// Wait until the health endpoint through the web origin returns the wanted HTTP status.
async function waitForHealth(wanted, tries = 40) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      last = await getJson('http://127.0.0.1:3000/api/v1/health');
      if (last.status === wanted) return last;
    } catch (e) {
      last = { error: e.message };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert.fail(`health never returned ${wanted}; last: ${JSON.stringify(last)}`);
}

describe('platform and web profiles on a real Docker engine', () => {
  let up;

  before(async () => {
    const info = docker('info', '--format', '{{.ServerVersion}}');
    assert.ok(info.status === 0 && /^\d/.test(info.stdout.trim()), 'Docker is not running: start Docker Desktop, then run this test again.');
    composeDown();
    for (const p of PORTS) assert.ok(await portFree(p), `Port ${p} is in use on 127.0.0.1: stop whatever uses it, then run this test again.`);
    up = dev('up', 'platform', 'web');
  }, { timeout: 480000 });

  after(() => {
    composeDown();
  });

  test('up: exits 0, the migrations ran first, and all five services are healthy', () => {
    assert.equal(up.status, 0, up.stdout + up.stderr);
    const migrate = inspect('migrate').State;
    assert.equal(migrate.Status, 'exited');
    assert.equal(migrate.ExitCode, 0, 'alembic upgrade head exits 0');
    for (const s of SERVICES) {
      assert.match(up.stdout, new RegExp(`Started:.*\\b${s}\\b`), `"Started:" line should name ${s}`);
      const state = inspect(s).State;
      assert.equal(state.Running, true, `${s} should be running`);
      assert.equal(state.Health?.Status, 'healthy', `${s} should be healthy`);
    }
  });

  test('healthy stack: /api/v1/health through the web origin is ok (the /api prefix reaches the API)', async () => {
    const r = await waitForHealth(200);
    assert.deepEqual(r.body, { status: 'ok' });
  });

  test('the page is served and the API is also reachable directly on its own port', async () => {
    const page = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(60000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /VulnMart/);
    const direct = await getJson('http://127.0.0.1:8000/healthz');
    assert.equal(direct.status, 200, 'probes need no origin secret');
    const ready = await getJson('http://127.0.0.1:8000/readyz');
    assert.deepEqual(ready, { status: 200, body: { status: 'ok', checks: { postgres: 'ok', valkey: 'ok' } } });
    const version = await getJson('http://127.0.0.1:8000/version');
    assert.equal(version.body.service, 'api');
    const mail = await fetch('http://127.0.0.1:8025/', { signal: AbortSignal.timeout(20000) });
    assert.equal(mail.status, 200);
  });

  test('API errors follow the IF-8 format through the web origin: unknown route and wrong method', async () => {
    const unknown = await fetch('http://127.0.0.1:3000/api/no-such-route', { headers: { 'X-Request-ID': 'e2e-req-0001' }, signal: AbortSignal.timeout(20000) });
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get('content-type'), /application\/problem\+json/);
    assert.match(unknown.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await unknown.json(), {
      type: 'urn:vulnmart:error:REQ-ROUTE-UNKNOWN',
      title: 'Route not found.',
      status: 404,
      code: 'REQ-ROUTE-UNKNOWN',
      request_id: 'e2e-req-0001',
    });
    const wrong = await fetch('http://127.0.0.1:3000/api/v1/health', { method: 'POST', signal: AbortSignal.timeout(20000) });
    assert.equal(wrong.status, 405);
    assert.match(wrong.headers.get('content-type'), /application\/problem\+json/);
    const body = await wrong.json();
    assert.equal(body.code, 'REQ-METHOD-NOT-ALLOWED');
    assert.match(body.request_id, /^[A-Za-z0-9-]{8,64}$/, 'a request id is generated when none is sent');
  });

  test('origin secret: the proxy adds it, a direct call to the API without it is refused (P-07)', async () => {
    const direct = await fetch('http://127.0.0.1:8000/api/v1/health', { signal: AbortSignal.timeout(20000) });
    assert.equal(direct.status, 403);
    assert.equal((await direct.json()).code, 'AUTH-ORIGIN-FORBIDDEN');
    const forged = await fetch('http://127.0.0.1:8000/api/v1/health', { headers: { 'x-origin-secret': 'forged-by-a-browser-0000' }, signal: AbortSignal.timeout(20000) });
    assert.equal(forged.status, 403);
    // through the web origin the real secret is added, and a forged one sent by the browser is replaced, not passed on
    const proxied = await fetch('http://127.0.0.1:3000/api/v1/health', { headers: { 'x-origin-secret': 'forged-by-a-browser-0000' }, signal: AbortSignal.timeout(20000) });
    assert.equal(proxied.status, 200);
    assert.equal(proxied.headers.get('cache-control'), 'private, no-store');
    const env = inspect('web').Config.Env.join('\n');
    assert.doesNotMatch(env, /NEXT_PUBLIC_[A-Z_]*SECRET/, 'the secret is server-side only');
  });

  test('page headers: nonce-based CSP that changes per request and matches the page scripts, and the fixed headers (P-07)', async () => {
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const page = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(60000) });
      assert.equal(page.status, 200);
      const csp = page.headers.get('content-security-policy');
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
      assert.ok(nonce, `a nonce in the CSP: ${csp}`);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /'strict-dynamic'/);
      assert.match(csp, /object-src 'none'/);
      const html = await page.text();
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
      assert.ok(scripts.length > 0, 'the page has scripts');
      for (const attrs of scripts) assert.match(attrs, new RegExp(`nonce="${nonce.replace(/[+/=]/g, (c) => '\\' + c)}"`), `every script carries the nonce: <script${attrs}>`);
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.match(page.headers.get('permissions-policy'), /camera=\(\)/);
      assert.match(page.headers.get('cache-control'), /no-store/);
      assert.equal(page.headers.get('x-powered-by'), null);
      nonces.push(nonce);
    }
    assert.notEqual(nonces[0], nonces[1], 'a fresh nonce per request');
  });

  test('caching (EF-02): two users on the same URL, interleaved, each receive only their own answer (P-07)', async () => {
    const users = { a: { cookie: '__Host-vm_session=user-a-session', id: 'user-a-req-0000' }, b: { cookie: '__Host-vm_session=user-b-session', id: 'user-b-req-0000' } };
    for (let round = 0; round < 6; round++) {
      for (const [name, u] of Object.entries(users)) {
        const id = `${u.id}${round}`;
        for (const path of ['/api/v1/health', '/api/v1/no-such-route']) {
          const r = await fetch(`http://127.0.0.1:3000${path}`, { headers: { cookie: u.cookie, 'x-request-id': id }, signal: AbortSignal.timeout(20000) });
          assert.equal(r.headers.get('x-request-id'), id, `${name} round ${round} ${path}: the answer is ${name}'s own`);
          assert.equal(r.headers.get('cache-control'), 'private, no-store');
          assert.equal(r.headers.get('age'), null, 'no cache served it');
          const body = await r.json();
          if (r.status === 404) assert.equal(body.request_id, id, `${name}'s own error body`);
        }
      }
    }
  });

  // Story P-09. The outbox row is written as the owner role through psql inside the Postgres container (no account exists yet to cause an
  // email); the worker relays it through Valkey and Dramatiq, and Mailpit (the development provider) receives it over SMTP.
  const RUN = Date.now().toString(36); // the Postgres volume survives `down`, so every run uses user ids of its own
  const MAIL1 = `e2e-mail-1-${RUN}`;
  const MAIL2 = `e2e-mail-2-${RUN}`;
  const enqueueMail = (user) =>
    docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO email_outbox (template, to_user_id, params) VALUES ('system.test', '${user}', '{}')`);
  async function mailTo(user, tries = 40) {
    for (let i = 0; i < tries; i++) {
      const res = await fetch('http://127.0.0.1:8025/api/v1/messages', { signal: AbortSignal.timeout(20000) });
      const found = (await res.json()).messages.filter((m) => m.To.some((t) => t.Address === `${user}@users.vulnmart.invalid`));
      if (found.length) return found;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return [];
  }

  test('mail (P-09): a row in the outbox is delivered once to Mailpit through Valkey and Dramatiq', async () => {
    assert.equal(enqueueMail(MAIL1).status, 0);
    const found = await mailTo(MAIL1);
    assert.equal(found.length, 1, 'exactly one message arrived');
    assert.equal(found[0].Subject, 'VulnMart test message');
    await new Promise((r) => setTimeout(r, 7000)); // more than one relay pass: it must not be sent again
    assert.equal((await mailTo(MAIL1)).length, 1);
    const state = docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c',
      `SELECT state || ',' || attempts FROM email_outbox WHERE to_user_id = '${MAIL1}'`);
    assert.equal(state.stdout.trim(), 'sent,1');
  }, { timeout: 120000 });

  test('mail (P-09): mail queued while the worker is down is delivered after it restarts (nothing is lost)', async () => {
    assert.equal(docker('stop', '--time', '5', NAME('worker')).status, 0);
    assert.equal(enqueueMail(MAIL2).status, 0);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await mailTo(MAIL2, 1)).length, 0, 'nothing is sent while the worker is down');
    assert.equal(docker('start', NAME('worker')).status, 0);
    assert.equal((await mailTo(MAIL2, 60)).length, 1);
  }, { timeout: 180000 });

  // Story P-11: the whole learner signup path on the real stack, through the web origin (proxy, origin secret), the API, Argon2id, Postgres,
  // the outbox, Valkey and Dramatiq, the worker's real address lookup, and Mailpit.
  async function mailFor(address, subjectPart, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const res = await fetch('http://127.0.0.1:8025/api/v1/messages', { signal: AbortSignal.timeout(20000) });
      const hit = (await res.json()).messages.find((m) => m.To.some((t) => t.Address === address) && m.Subject.includes(subjectPart));
      if (hit) return (await fetch(`http://127.0.0.1:8025/api/v1/message/${hit.ID}`, { signal: AbortSignal.timeout(20000) })).json();
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }
  // Every state-changing call must carry the dashboard origin (story P-12, the Origin check of the contract).
  const ORIGIN = 'http://127.0.0.1:3000';
  // A pooled keep-alive socket can be closed by the Next server (5 s idle) just as a call reuses it, which fetch reports as "other side
  // closed"; the long `docker exec` steps of some tests make that likely. The call never reached the server, so it is tried once more.
  const call = async (method, path, { body, headers = {} } = {}) => {
    const send = () =>
      fetch(`${ORIGIN}${path}`, {
        method,
        headers: { origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    try {
      return await send();
    } catch (e) {
      if (e?.cause?.code !== 'UND_ERR_SOCKET') throw e;
      return send();
    }
  };
  const postJson = (path, body, headers) => call('POST', path, { body, headers });

  test('accounts (P-11): signup sends a verification mail, its link verifies once, a repeat signup gets the "already registered" mail, and signup is rate limited', async () => {
    const email = `e2e-learner-${Date.now()}@example.com`;
    const body = { email, password: 'correct horse battery staple', display_name: 'E2E Learner', age_declaration: true };
    const first = await postJson('/api/v1/accounts', body);
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { status: 'accepted' });
    assert.equal(first.headers.get('cache-control'), 'private, no-store');
    const verify = await mailFor(email, 'Confirm your email');
    assert.ok(verify, 'the verification mail arrived in Mailpit');
    const token = /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(verify.Text)?.[1];
    assert.ok(token, `a link with a token in the mail text: ${verify.Text}`);
    assert.deepEqual([...new Set(verify.Text.match(/https?:\/\/[^\s]+/g))], [`http://127.0.0.1:3000/verify-email?token=${token}`], 'only its own link');
    // the account exists unverified, with an Argon2id hash and the learner role
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    assert.equal(psql(`SELECT account_type || ',' || (email_verified_at IS NULL) || ',' || left(password_hash, 9) FROM users WHERE email_ci = '${email}'`), 'participant,true,$argon2id');
    assert.equal(psql(`SELECT role FROM user_roles JOIN users ON users.id = user_roles.user_id WHERE email_ci = '${email}'`), 'learner');
    assert.equal(psql(`SELECT count(*) FROM email_tokens WHERE token_hash = '${token}'`), '0', 'the token itself is not stored');
    // verify once, then the same link is refused
    const ok = await postJson('/api/v1/accounts/verify-email', { token });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { status: 'verified' });
    const again = await postJson('/api/v1/accounts/verify-email', { token });
    assert.equal(again.status, 400);
    assert.equal((await again.json()).code, 'AUTH-TOKEN-INVALID');
    assert.equal(psql(`SELECT (email_verified_at IS NOT NULL) FROM users WHERE email_ci = '${email}'`), 't');
    // the same address again: the same answer, and a mail that says the address is known
    const repeat = await postJson('/api/v1/accounts', { ...body, email: email.toUpperCase(), display_name: 'Someone else' });
    assert.equal(repeat.status, 202);
    assert.ok(await mailFor(email, 'Someone tried to sign up'), 'the already-registered mail arrived');
    assert.equal(psql(`SELECT count(*) FROM users WHERE email_ci = '${email}'`), '1');
    // the per-address limit: three signups an hour (placeholder); the fourth is 429 with Retry-After
    const fourth = await postJson('/api/v1/accounts', body);
    const refused = await postJson('/api/v1/accounts', body);
    assert.equal(fourth.status, 202);
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).code, 'REQ-RATE-LIMITED');
    assert.match(refused.headers.get('retry-after'), /^\d+$/);
    // bad input is 422 and never echoes the password
    const bad = await postJson('/api/v1/accounts', { ...body, email: 'x@example.com', age_declaration: false });
    assert.equal(bad.status, 422);
    assert.doesNotMatch(await bad.text(), /correct horse/);
  }, { timeout: 180000 });

  // Story P-12: login, the session cookie through the real proxy, CSRF, the Origin check, logout, and a stolen cookie.
  test('sessions (P-12): login through the web origin sets the cookie, the session works, CSRF and Origin are checked, logout ends it for good', async () => {
    const email = `e2e-login-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Login', age_declaration: true })).status, 202);
    // right password, address not verified yet: 403, and no cookie; a wrong password is 401
    const early = await postJson('/api/v1/session', { email, password });
    assert.equal(early.status, 403);
    assert.equal((await early.json()).code, 'AUTH-EMAIL-NOT-VERIFIED');
    assert.equal(early.headers.getSetCookie().length, 0);
    const wrong = await postJson('/api/v1/session', { email, password: 'not the password at all' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'AUTH-INVALID-CREDENTIALS');
    const mail = await mailFor(email, 'Confirm your email');
    assert.ok(mail, 'the verification mail arrived');
    const token = /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1];
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token })).status, 200);

    // another site cannot log a visitor in
    const forged = await postJson('/api/v1/session', { email, password }, { origin: 'https://evil.example' });
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).code, 'AUTH-ORIGIN-FORBIDDEN');

    const login = await postJson('/api/v1/session', { email, password });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('cache-control'), 'private, no-store');
    const cookies = login.headers.getSetCookie();
    assert.equal(cookies.length, 1, 'one cookie came back through the proxy');
    assert.match(cookies[0], /^__Host-vm_session=[A-Za-z0-9_-]{43};/);
    for (const part of ['Path=/', 'Secure', 'HttpOnly']) assert.ok(cookies[0].includes(part), `${part} in ${cookies[0]}`);
    assert.match(cookies[0], /SameSite=lax/i);
    assert.doesNotMatch(cookies[0], /Domain=|Max-Age=|Expires=/i);
    const session = await login.json();
    const value = /__Host-vm_session=([^;]+)/.exec(cookies[0])[1];
    assert.equal(session.status, 'authenticated');
    assert.equal(session.user.email, email);
    assert.equal(session.user.account_type, 'participant');
    assert.equal(session.user.email_verified, true);
    assert.ok(!JSON.stringify(session).includes(value), 'the cookie value is not in the body');
    assert.equal(psql(`SELECT count(*) FROM sessions WHERE id_hash = '${value}'`), '0', 'the cookie value itself is not stored');
    assert.equal(psql(`SELECT count(*) FROM sessions JOIN users ON users.id = sessions.user_id WHERE email_ci = '${email}'`), '1');
    const cookie = `__Host-vm_session=${value}`;

    // the session, with the same csrf token
    const current = await call('GET', '/api/v1/session', { headers: { cookie } });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).csrf_token, session.csrf_token);
    const nobody = await call('GET', '/api/v1/session');
    assert.equal(nobody.status, 401);
    assert.equal((await nobody.json()).code, 'AUTH-SESSION-REQUIRED');

    // logout needs the right origin and this session's csrf token; refused calls leave the session alone
    const noToken = await call('DELETE', '/api/v1/session', { headers: { cookie } });
    assert.equal(noToken.status, 403);
    assert.equal((await noToken.json()).code, 'AUTH-CSRF-FAILED');
    const otherSite = await call('DELETE', '/api/v1/session', { headers: { cookie, 'x-csrf-token': session.csrf_token, origin: 'https://evil.example' } });
    assert.equal(otherSite.status, 403);
    assert.equal((await otherSite.json()).code, 'AUTH-ORIGIN-FORBIDDEN');
    assert.equal((await call('GET', '/api/v1/session', { headers: { cookie } })).status, 200);
    const out = await call('DELETE', '/api/v1/session', { headers: { cookie, 'x-csrf-token': session.csrf_token } });
    assert.equal(out.status, 204);
    assert.match(out.headers.getSetCookie()[0], /^__Host-vm_session=("")?;|Max-Age=0/i);
    // a copy of the old cookie no longer works
    const replay = await call('GET', '/api/v1/session', { headers: { cookie } });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).code, 'AUTH-SESSION-REQUIRED');
    assert.equal(psql(`SELECT (revoked_at IS NOT NULL) FROM sessions JOIN users ON users.id = sessions.user_id WHERE email_ci = '${email}'`), 't');
  }, { timeout: 180000 });

  // Story P-14: password reset by mail, password quality, the profile and a password change, on the real stack through the web proxy.
  test('password (P-14): reset by mail ends every session, weak passwords are refused with a fixed sentence, the profile and a password change work', async () => {
    const email = `e2e-pw-${RUN}@example.com`;
    const first = 'correct horse battery staple';
    const second = 'purple tractor midnight lantern';
    const third = 'orange bicycle morning window';
    const cookieOf = (res) => /__Host-vm_session=([^;]+)/.exec(res.headers.getSetCookie()[0])[1];
    const asCookie = (value) => ({ cookie: `__Host-vm_session=${value}` });
    assert.equal((await postJson('/api/v1/accounts', { email, password: first, display_name: 'E2E Password', age_declaration: true })).status, 202);
    const verifyMail = await mailFor(email, 'Confirm your email');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /token=([A-Za-z0-9_-]{43})/.exec(verifyMail.Text)[1] })).status, 200);
    // two browsers are signed in
    const loginA = await postJson('/api/v1/session', { email, password: first });
    const loginB = await postJson('/api/v1/session', { email, password: first });
    assert.equal(loginA.status, 200);
    assert.equal(loginB.status, 200);
    const [cookieA, cookieB] = [cookieOf(loginA), cookieOf(loginB)];

    // forgot password: the same answer for an unknown address, the mail holds only its own link
    const known = await postJson('/api/v1/password-reset/request', { email });
    const unknown = await postJson('/api/v1/password-reset/request', { email: `nobody-${RUN}@example.com` });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(await known.json(), await unknown.json());
    const resetMail = await mailFor(email, 'Reset your VulnMart password');
    assert.ok(resetMail, 'the reset mail arrived');
    const token = /reset-password\?token=([A-Za-z0-9_-]{43})/.exec(resetMail.Text)?.[1];
    assert.ok(token, `a reset link in the mail: ${resetMail.Text}`);
    assert.deepEqual([...new Set(resetMail.Text.match(/https?:\/\/[^\s]+/g))], [`http://127.0.0.1:3000/reset-password?token=${token}`], 'only its own link');
    // a password from the list of the 10,000 most common is refused with a fixed sentence, and the link survives
    const weak = await postJson('/api/v1/password-reset/confirm', { token, new_password: 'unbelievable' });
    assert.equal(weak.status, 422);
    assert.deepEqual((await weak.json()).errors, [{ pointer: '/new_password', detail: 'This password is too easy to guess. Choose another one.' }]);
    const done = await postJson('/api/v1/password-reset/confirm', { token, new_password: second });
    assert.equal(done.status, 204);
    assert.equal((await postJson('/api/v1/password-reset/confirm', { token, new_password: third })).status, 400, 'a link works once');
    // every old session ended; the old password no longer works, the new one does
    assert.equal((await call('GET', '/api/v1/session', { headers: asCookie(cookieA) })).status, 401);
    assert.equal((await call('GET', '/api/v1/session', { headers: asCookie(cookieB) })).status, 401);
    assert.equal((await postJson('/api/v1/session', { email, password: first })).status, 401);
    const login = await postJson('/api/v1/session', { email, password: second });
    assert.equal(login.status, 200);
    const { csrf_token: csrf } = await login.json();
    const cookieC = cookieOf(login);

    // the profile
    const me = await call('GET', '/api/v1/me', { headers: asCookie(cookieC) });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).display_name, 'E2E Password');
    const renamed = await call('PATCH', '/api/v1/me', { body: { display_name: 'E2E  Renamed' }, headers: { ...asCookie(cookieC), 'x-csrf-token': csrf } });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).display_name, 'E2E Renamed');
    assert.equal((await call('PATCH', '/api/v1/me', { body: { display_name: 'No token' }, headers: asCookie(cookieC) })).status, 403);

    // a password change: a wrong current password keeps the session, a right one gives a new session value and ends the others
    const wrong = await postJson('/api/v1/me/password', { current_password: 'not the password at all', new_password: third }, { ...asCookie(cookieC), 'x-csrf-token': csrf });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'AUTH-INVALID-CREDENTIALS');
    assert.equal((await call('GET', '/api/v1/session', { headers: asCookie(cookieC) })).status, 200);
    const other = await postJson('/api/v1/session', { email, password: second });
    const cookieOther = cookieOf(other);
    const changed = await postJson('/api/v1/me/password', { current_password: second, new_password: third }, { ...asCookie(cookieC), 'x-csrf-token': csrf });
    assert.equal(changed.status, 204);
    const cookieD = cookieOf(changed);
    assert.notEqual(cookieD, cookieC);
    assert.equal((await call('GET', '/api/v1/session', { headers: asCookie(cookieC) })).status, 401, 'the old value of this session is dead');
    assert.equal((await call('GET', '/api/v1/session', { headers: asCookie(cookieOther) })).status, 401, 'the other session ended');
    assert.equal((await call('GET', '/api/v1/session', { headers: asCookie(cookieD) })).status, 200);
    assert.equal((await postJson('/api/v1/session', { email, password: second })).status, 401);
    assert.equal((await postJson('/api/v1/session', { email, password: third })).status, 200);
    // nothing sensitive is stored readable: the reset token is only a hash
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    assert.equal(psql(`SELECT count(*) FROM email_tokens WHERE token_hash = '${token}'`), '0');
    assert.equal(psql(`SELECT used_at IS NOT NULL FROM email_tokens JOIN users ON users.id = email_tokens.user_id WHERE email_ci = '${email}' AND purpose = 'reset'`), 't');
  }, { timeout: 240000 });

  // Story P-13: an admin exists only through the seed command (or another admin); signup cannot make one; an admin has no learner role.
  test('admins (P-13): the seed command makes an admin with no learner role who signs in without admin powers, a second seed changes nothing, signup cannot make an admin', async () => {
    const email = `e2e-admin-${RUN}@example.com`;
    const password = 'a long admin password 123';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const seed = (extra = []) =>
      docker('exec', '-e', `VULNMART_SEED_ADMIN_PASSWORD=${password}`, NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', email, '--name', 'E2E Admin', ...extra);
    const first = seed();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.ok(!(first.stdout + first.stderr).includes(password), 'the password is never printed');
    assert.equal(psql(`SELECT account_type || ',' || (email_verified_at IS NOT NULL) || ',' || left(password_hash, 9) FROM users WHERE email_ci = '${email}'`), 'admin,true,$argon2id');
    assert.equal(psql(`SELECT count(*) FROM user_roles JOIN users ON users.id = user_roles.user_id WHERE email_ci = '${email}'`), '0', 'an admin holds no learner or candidate role');
    const again = seed();
    assert.equal(again.status, 3, 'a second seed for the same address changes nothing');
    assert.equal(psql(`SELECT count(*) FROM users WHERE email_ci = '${email}'`), '1');
    // the admin can sign in with the password (to enrol a second factor) but the session has no admin powers until one is proved (story P-15)
    const login = await postJson('/api/v1/session', { email, password });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.user.account_type, 'admin');
    assert.equal(loginBody.user.mfa_enabled, false);
    assert.equal(login.headers.getSetCookie().length, 1);
    assert.equal(psql(`SELECT count(*) FROM sessions JOIN users ON users.id = sessions.user_id WHERE email_ci = '${email}' AND mfa_at IS NULL`), '1', 'the session records that no second factor was proved');
    // a signup that names an account type or role is refused, and a normal signup makes a participant
    const forged = await postJson('/api/v1/accounts', { email: `e2e-forged-${RUN}@example.com`, password, display_name: 'Forged', age_declaration: true, account_type: 'admin' });
    assert.equal(forged.status, 422);
    assert.equal(psql(`SELECT count(*) FROM users WHERE email_ci = 'e2e-forged-${RUN}@example.com'`), '0');
    // a recruiter or admin cannot be given a participant role even by SQL: the database refuses
    const direct = docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO user_roles (user_id, role, account_type) SELECT id, 'candidate', 'participant' FROM users WHERE email_ci = '${email}'`);
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /violates foreign key constraint/);
  }, { timeout: 120000 });

  // Story P-15: the second factor on the real stack. The test is the authenticator app: it reads the secret from the otpauth address and makes the
  // 6-digit codes itself (RFC 6238: HMAC-SHA1 of the 30-second step).
  const base32 = (text) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0;
    const bytes = [];
    for (const ch of text.replace(/=+$/, '').toUpperCase()) {
      value = (value << 5) | alphabet.indexOf(ch);
      bits += 5;
      if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(bytes);
  };
  const totpCode = (secret, step) => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = crypto.createHmac('sha1', base32(secret)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const number = (((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]) % 1000000;
    return String(number).padStart(6, '0');
  };
  const stepNow = () => Math.floor(Date.now() / 30000);

  test('mfa (P-15): an admin enrols an authenticator app, then needs the code (or a recovery code, once) to sign in; a code cannot be replayed', async () => {
    const email = `e2e-mfa-${RUN}@example.com`;
    const password = 'a long admin password 123';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const seeded = docker('exec', '-e', `VULNMART_SEED_ADMIN_PASSWORD=${password}`, NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', email, '--name', 'E2E MFA Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const cookieOf = (res) => /__Host-vm_session=([^;]+)/.exec(res.headers.getSetCookie()[0])[1];
    const asCookie = (value) => ({ cookie: `__Host-vm_session=${value}` });

    // 1. password only: a session that carries no admin role, but can enrol
    const first = await postJson('/api/v1/session', { email, password });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.user.mfa_enabled, false);
    let cookie = cookieOf(first);
    const start = await postJson('/api/v1/me/mfa', undefined, { ...asCookie(cookie), 'x-csrf-token': firstBody.csrf_token });
    assert.equal(start.status, 200);
    const uri = (await start.json()).otpauth_uri;
    assert.match(uri, /^otpauth:\/\/totp\/VulnMart%3A/);
    const secret = new URL(uri).searchParams.get('secret');
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(psql(`SELECT enabled_at IS NULL FROM mfa_credentials JOIN users ON users.id = mfa_credentials.user_id WHERE email_ci = '${email}'`), 't', 'pending until a code confirms it');
    assert.equal((await postJson('/api/v1/me/mfa/confirm', { code: '000000' }, { ...asCookie(cookie), 'x-csrf-token': firstBody.csrf_token })).status, 401);
    const confirm = await postJson('/api/v1/me/mfa/confirm', { code: totpCode(secret, stepNow()) }, { ...asCookie(cookie), 'x-csrf-token': firstBody.csrf_token });
    assert.equal(confirm.status, 200);
    const recovery = (await confirm.json()).recovery_codes;
    assert.equal(recovery.length, 10);
    assert.ok(recovery.every((c) => /^[A-Z2-7]{10}$/.test(c)));
    assert.notEqual(cookieOf(confirm), cookie, 'the session value changed');
    cookie = cookieOf(confirm);
    assert.equal((await call('GET', '/api/v1/me', { headers: asCookie(cookie) })).status, 200);
    // what is stored: a sealed secret, keyed hashes, no codes
    const stored = psql(`SELECT secret_enc FROM mfa_credentials JOIN users ON users.id = mfa_credentials.user_id WHERE email_ci = '${email}'`);
    assert.ok(stored.startsWith('v1.') && !stored.includes(secret), 'the secret is sealed');
    assert.equal(psql(`SELECT count(*) FROM recovery_codes JOIN users ON users.id = recovery_codes.user_id WHERE email_ci = '${email}' AND length(code_hash) = 64`), '10');
    assert.equal(psql(`SELECT count(*) FROM recovery_codes WHERE code_hash = '${recovery[0]}'`), '0', 'a recovery code itself is not stored');
    // 2. an admin cannot turn it off
    const csrf = (await (await call('GET', '/api/v1/session', { headers: asCookie(cookie) })).json()).csrf_token;
    const off = await call('DELETE', '/api/v1/me/mfa', { body: { password }, headers: { ...asCookie(cookie), 'x-csrf-token': csrf } });
    assert.equal(off.status, 409);
    assert.equal((await off.json()).code, 'AUTH-MFA-STATE');
    assert.equal((await call('DELETE', '/api/v1/session', { headers: { ...asCookie(cookie), 'x-csrf-token': csrf } })).status, 204);

    // 3. the next sign-in: password, then a ticket and no cookie, then the code
    const step1 = await postJson('/api/v1/session', { email, password });
    assert.equal(step1.status, 200);
    const challenge = await step1.json();
    assert.equal(challenge.status, 'mfa_required');
    assert.equal(step1.headers.getSetCookie().length, 0, 'no cookie before the second step');
    assert.equal(psql(`SELECT count(*) FROM email_tokens WHERE purpose = 'mfa' AND token_hash = '${challenge.mfa_ticket}'`), '0', 'the ticket is stored only as a hash');
    const wrong = await postJson('/api/v1/session/mfa', { mfa_ticket: challenge.mfa_ticket, code: '000000' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'AUTH-MFA-INVALID');
    const goodCode = totpCode(secret, stepNow() + 1); // the confirming code used this step; the window accepts the next one
    const done = await postJson('/api/v1/session/mfa', { mfa_ticket: challenge.mfa_ticket, code: goodCode });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).user.mfa_enabled, true);
    assert.equal(done.headers.getSetCookie().length, 1);
    assert.equal(psql(`SELECT count(*) FROM sessions JOIN users ON users.id = sessions.user_id WHERE email_ci = '${email}' AND mfa_at IS NOT NULL AND revoked_at IS NULL`), '1');
    // 4. a ticket works once, and a code cannot be replayed
    assert.equal((await postJson('/api/v1/session/mfa', { mfa_ticket: challenge.mfa_ticket, code: goodCode })).status, 401);
    const again = await (await postJson('/api/v1/session', { email, password })).json();
    const replay = await postJson('/api/v1/session/mfa', { mfa_ticket: again.mfa_ticket, code: goodCode });
    assert.equal(replay.status, 401);
    // 5. a recovery code signs in once
    const viaRecovery = await postJson('/api/v1/session/mfa', { mfa_ticket: (await (await postJson('/api/v1/session', { email, password })).json()).mfa_ticket, code: recovery[0] });
    assert.equal(viaRecovery.status, 200);
    const reused = await postJson('/api/v1/session/mfa', { mfa_ticket: (await (await postJson('/api/v1/session', { email, password })).json()).mfa_ticket, code: recovery[0] });
    assert.equal(reused.status, 401);
    assert.equal(psql(`SELECT count(*) FROM recovery_codes JOIN users ON users.id = recovery_codes.user_id WHERE email_ci = '${email}' AND used_at IS NOT NULL`), '1');
  }, { timeout: 240000 });

  // Story P-16: the consent routes through the real proxy. No attempt in state consent exists on the stack until the invite flow (P-21), so the
  // routes can only show what they refuse; the notice, the record and the race are proved against a fake attempt side in the pytest suite.
  test('consent (P-16): the routes need a session and CSRF, answer 404 for an attempt that is not there, list nothing, and the database refuses to change a record', async () => {
    const email = `e2e-consent-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    const psqlAs = (...args) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', ...args);
    const psql = (sql) => psqlAs('-c', sql).stdout.trim();
    assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Consent', age_declaration: true })).status, 202);
    const mail = await mailFor(email, 'Confirm your email');
    assert.ok(mail, 'the verification mail arrived');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);
    const attempt = 'a-ABCDEFGHIJKLMNOP';
    const notice = `/api/v1/consent/notice?attempt_id=${attempt}`;
    const body = { attempt_id: attempt, notice_version: '2026-10-18.1', notice_text_sha256: '0'.repeat(64), decision: 'granted' };

    assert.equal((await call('GET', notice)).status, 401);
    assert.equal((await call('GET', '/api/v1/me/consents')).status, 401);
    assert.equal((await postJson('/api/v1/consent', body)).status, 401);

    const login = await postJson('/api/v1/session', { email, password });
    assert.equal(login.status, 200);
    const cookie = `__Host-vm_session=${/__Host-vm_session=([^;]+)/.exec(login.headers.getSetCookie()[0])[1]}`;
    const csrf = (await login.json()).csrf_token;

    const missing = await call('GET', notice, { headers: { cookie } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'ATT-NOT-FOUND');
    assert.equal(missing.headers.get('cache-control'), 'private, no-store');
    assert.equal((await call('GET', '/api/v1/consent/notice?attempt_id=nope', { headers: { cookie } })).status, 422);
    assert.equal((await postJson('/api/v1/consent', body, { cookie })).status, 403, 'no CSRF token');
    assert.equal((await postJson('/api/v1/consent', body, { cookie, 'x-csrf-token': csrf, origin: 'https://evil.example' })).status, 403, 'another site');
    const unknown = await postJson('/api/v1/consent', body, { cookie, 'x-csrf-token': csrf });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'ATT-NOT-FOUND');
    const own = await call('GET', '/api/v1/me/consents', { headers: { cookie } });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { items: [], has_more: false });
    assert.equal((await call('GET', '/api/v1/me/consents?limit=101', { headers: { cookie } })).status, 422);
    assert.equal(psql(`SELECT count(*) FROM consent_records`), '0', 'nothing was written by the refused calls');

    // the database itself: the application role has SELECT and INSERT only, and cannot change a record
    assert.equal(psql(`SELECT version_num FROM alembic_version`).length > 0, true);
    assert.equal(psql(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name = 'consent_records' AND grantee = 'vulnmart_app'`), 'INSERT,SELECT');
    assert.equal(psql(`INSERT INTO consent_records (id, user_id, attempt_id, notice_version, notice_text_sha256, notice_text_snapshot, retention_days_shown, controller_name_shown, action, audit_seq) VALUES ('k-E2ETESTE2ETESTAA', 'u-X', '${attempt}', '2026-10-18.1', '${'a'.repeat(64)}', 't', 180, 'C', 'granted', 1) RETURNING 1`).split('\n')[0], '1');
    for (const sql of ["UPDATE consent_records SET action = 'declined'", 'DELETE FROM consent_records', 'TRUNCATE consent_records']) {
      const refused = psqlAs('-c', `SET ROLE vulnmart_app; ${sql}`);
      assert.notEqual(refused.status, 0, sql);
      assert.match(refused.stderr, /permission denied/, sql);
    }
    assert.equal(psql(`SELECT action FROM consent_records WHERE attempt_id = '${attempt}'`), 'granted');
    psql(`DELETE FROM consent_records WHERE attempt_id = '${attempt}'`); // clean up as the owner, so a rerun on this volume starts empty
  }, { timeout: 120000 });

  // Story P-17: the audit log and the key service on the real stack. A login through the proxy leaves a pseudonymised entry in the hash chain, the chain
  // verifies and anchors, and the key service (database vm_keystore, its own role, the KEK from the environment) creates, uses and shreds a key.
  test('audit and keys (P-17): a login is logged under a pseudonym, the chain verifies and anchors; a key is created, used and shredded in vm_keystore', async () => {
    const email = `e2e-audit-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    const psqlDb = (db, sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', db, '-At', '-c', sql).stdout.trim();
    const psql = (sql) => psqlDb('vulnmart', sql);
    assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Audit', age_declaration: true })).status, 202);
    const mail = await mailFor(email, 'Confirm your email');
    assert.ok(mail, 'the verification mail arrived');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);
    assert.equal((await postJson('/api/v1/session', { email, password: 'not the password at all' })).status, 401);
    assert.equal((await postJson('/api/v1/session', { email, password })).status, 200);

    // the entries exist, under pseudonyms: the user id and the address are nowhere in the table
    const userId = psql(`SELECT id FROM users WHERE email_ci = '${email}'`);
    assert.match(userId, /^u-[A-Z2-7]{16}$/);
    const pseudonym = psql(`SELECT subject_id FROM subject_map WHERE user_id = '${userId}'`);
    assert.match(pseudonym, /^s-[A-Z2-7]{16}$/);
    assert.equal(psql(`SELECT string_agg(action, ',' ORDER BY seq) FROM audit_log WHERE subject = '${pseudonym}'`), 'auth.login_failed,auth.login');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE actor || coalesce(subject, '') || details LIKE '%${userId}%' OR details LIKE '%${email}%'`), '0');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE actor = '${pseudonym}' AND action = 'auth.login'`), '1');

    // the database role of the API can read and append to the log and cannot change it
    for (const sql of ["UPDATE audit_log SET actor = 'x'", 'DELETE FROM audit_log', 'TRUNCATE audit_log']) {
      const refused = docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-c', `SET ROLE vulnmart_app; ${sql}`);
      assert.notEqual(refused.status, 0, sql);
      assert.match(refused.stderr, /permission denied/, sql);
    }

    // inside the API container: the real ports, as the running process builds them
    const program = [
      'import json, secrets',
      'from vulnmart.main import app',
      'from vulnmart.ports.errors import KeyShredded',
      'p = app.state.ports',
      'a = "a-E2E" + secrets.token_hex(6).upper()',
      'out = {"keys": type(p.keys).__name__, "audit": type(p.audit_db).__name__}',
      'p.keys.create_attempt_key(a)',
      's = p.keys.encrypt(a, b"evidence", b"row")',
      'out["round_trip"] = p.keys.decrypt(a, s, b"row").decode()',
      'out["shred"] = p.keys.shred(a)',
      'try:',
      '    p.keys.decrypt(a, s, b"row")',
      '    out["after_shred"] = "readable"',
      'except KeyShredded:',
      '    out["after_shred"] = "shredded"',
      'v = p.audit_db.verify()',
      'out["verify"] = [v.ok, v.checked >= 2]',
      'r = app.state.audit_anchors.anchor()',
      'out["anchor"] = [r.head_seq >= 2, r.witness]',
      'out["attempt"] = a',
      'print(json.dumps(out))',
    ].join('\n');
    const run = docker('exec', NAME('api'), 'python', '-c', program);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split('\n').pop());
    const attempt = result.attempt;
    delete result.attempt;
    assert.deepEqual(result, {
      keys: 'DbKeyPort', audit: 'DbAuditPort', round_trip: 'evidence', shred: true, after_shred: 'shredded', verify: [true, true], anchor: [true, 'db'],
    });
    assert.equal(psql(`SELECT count(*) FROM audit_anchor WHERE anchor_date = current_date`), '1');

    // the keys are in their own database, with their own role, and the application's role cannot reach it
    // (the dev volume persists between runs, so look at this run's attempt only)
    assert.equal(psqlDb('vm_keystore', `SELECT count(*) FROM shredded WHERE attempt_id = '${attempt}'`), '1');
    assert.equal(psqlDb('vm_keystore', `SELECT count(*) FROM deks WHERE attempt_id = '${attempt}'`), '0', 'the wrapped key is gone, not marked');
    assert.equal(psql(`SELECT count(*) FROM pg_tables WHERE tablename IN ('deks', 'shredded')`), '0', 'no key table in the data database');
    const appToKeys = docker('exec', '-e', 'PGPASSWORD=vulnmart-app-dev-only-not-a-secret', NAME('postgres'), 'psql', '-h', '127.0.0.1', '-U', 'vulnmart_app', '-d', 'vm_keystore', '-c', 'SELECT 1');
    assert.notEqual(appToKeys.status, 0);
    assert.match(appToKeys.stderr, /permission denied|not allowed|CONNECT/i);
  }, { timeout: 120000 });

  // Story P-18: recruiter signup and company approval. IF-1 has no recruiter or admin route yet (handoff H-138), so the service is driven inside the API
  // container, as the application database role, which also proves the row-level security of migration 0008 on the real stack.
  test('companies (P-18): a recruiter signs up, verifies the address, the admin queue lists the company, the approval activates it and mails the owner', async () => {
    const domain = `recruiters-${RUN}.example`;
    const email = `e2e-recruiter@${domain}`;  // a domain of its own: the first recruiter of a work domain claims it, and the dev volume keeps earlier runs
    const adminEmail = `e2e-company-admin-${RUN}@example.com`;
    const password = 'a long admin password 123';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app', 'from vulnmart.ports.scope import Scope, Role', 'c = app.state.companies', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const seeded = docker('exec', '-e', `VULNMART_SEED_ADMIN_PASSWORD=${password}`, NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Company Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    const admin = `Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN}))`;

    // a disposable address is refused, a free webmail address is not (OI-10)
    const refused = py('from vulnmart.accounts.service import InvalidInput', 'try:', `    c.signup_recruiter(email="x${RUN}@mailinator.com", password="correct horse battery staple", display_name="X", company_name="X Ltd")`,
      '    print(json.dumps("accepted"))', 'except InvalidInput as e:', '    print(json.dumps([e.pointer, e.kind]))');
    assert.deepEqual(refused, ['/email', 'disposable_email']);
    assert.equal(psql(`SELECT count(*) FROM users WHERE email_ci LIKE 'x${RUN}@%'`), '0');

    py(`c.signup_recruiter(email="${email}", password="correct horse battery staple", display_name="E2E Recruiter", company_name="E2E Security Ltd")`, 'print(json.dumps(True))');
    assert.equal(psql(`SELECT account_type || ',' || (email_verified_at IS NULL) FROM users WHERE email_ci = '${email}'`), 'recruiter,true');
    assert.equal(psql(`SELECT o.status || ',' || o.email_domain || ',' || m.role FROM organizations o JOIN org_members m ON m.org_id = o.id JOIN users u ON u.id = m.user_id WHERE u.email_ci = '${email}'`), `pending,${domain},owner`);
    const uid = psql(`SELECT id FROM users WHERE email_ci = '${email}'`);
    assert.deepEqual(py(`s = c.standing("${uid}")`, 'print(json.dumps([s.state, s.org_name]))'), ['unverified_email', 'E2E Security Ltd']);

    // the verification mail arrives and its link verifies the recruiter through the existing route
    const mail = await mailFor(email, 'Confirm your email');
    assert.ok(mail, 'the verification mail arrived');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);
    assert.deepEqual(py(`s = c.standing("${uid}")`, 'print(json.dumps(s.state))'), 'pending_approval');
    assert.deepEqual(py(`try:`, `    c.active_company_of("${uid}")`, '    print(json.dumps("allowed"))', 'except Exception as e:', '    print(json.dumps([type(e).__name__, e.state]))'), ['NotActiveRecruiter', 'pending_approval']);

    // the admin queue lists the company with the owner's name and the domain, not the address; one approval activates it
    const queue = py(`q = c.pending(${admin})`, 'print(json.dumps([[x.name, x.owner_name, x.owner_email_domain, "@" in repr(x)] for x in q]))');
    assert.ok(queue.some((r) => r[0] === 'E2E Security Ltd' && r[1] === 'E2E Recruiter' && r[2] === domain && r[3] === false), JSON.stringify(queue));
    const orgId = psql(`SELECT m.org_id FROM org_members m WHERE m.user_id = '${uid}'`);
    py(`c.approve(${admin}, "${orgId}")`, 'print(json.dumps(True))');
    assert.equal(psql(`SELECT status FROM organizations WHERE id = '${orgId}'`), 'active');
    assert.deepEqual(py(`print(json.dumps([c.standing("${uid}").state, c.active_company_of("${uid}") == "${orgId}"]))`), ['active', true]);
    assert.ok(await mailFor(email, 'is approved on VulnMart'), 'the approval mail reached the owner');
    const second = py('from vulnmart.orgs.service import InvalidTransition', 'try:', `    c.approve(${admin}, "${orgId}")`, '    print(json.dumps("again"))', 'except InvalidTransition as e:', '    print(json.dumps(e.state))');
    assert.equal(second, 'active', 'a decision is made once');

    // the audit log has the three entries under pseudonyms, and an admin\'s own session has no company-table write path
    assert.equal(psql(`SELECT string_agg(action, ',' ORDER BY seq) FROM audit_log WHERE action LIKE 'org.%' AND (subject = (SELECT subject_id FROM subject_map WHERE user_id = '${uid}'))`), 'org.created,org.approved');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details LIKE '%${uid}%' OR details LIKE '%${email}%'`), '0');
    assert.equal(psql(`SELECT count(*) FROM pg_policies WHERE policyname IN ('admin_read', 'own_membership')`), '2');
  }, { timeout: 180000 });

  // Story P-19: colleagues, the terms, the cap, the admin's control of a recruiter and the company in the session scope; again through the service inside the
  // API container as the application role (IF-1 has no route for them yet, handoff H-138), with the real login and session over HTTP.
  test('company members (P-19): a colleague joins through the owner, the terms gate invites, the cap applies, a suspended recruiter is out at once', async () => {
    const domain = `corp-${RUN}.example`;
    const ownerEmail = `owner@${domain}`;
    const colleagueEmail = `colleague@${domain}`;
    const adminEmail = `e2e-members-admin-${RUN}@example.com`;
    const adminPassword = 'a long admin password 123';
    const password = 'correct horse battery staple';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app', 'from vulnmart.ports.scope import Scope, Role', 'c = app.state.companies', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const seeded = docker('exec', '-e', `VULNMART_SEED_ADMIN_PASSWORD=${adminPassword}`, NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Members Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    const admin = `Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN}))`;
    const signup = (email, company, name) => py(`c.signup_recruiter(email="${email}", password="${password}", display_name="${name}", company_name="${company}")`, 'print(json.dumps(True))');

    // the first recruiter of the domain starts the company and claims it; the second asks to join it
    signup(ownerEmail, 'Corp Security Ltd', 'E2E Owner');
    signup(colleagueEmail, 'Ignored Name', 'E2E Colleague');
    assert.equal(psql(`SELECT count(*) FROM organizations WHERE domain_claim = '${domain}'`), '1');
    assert.equal(psql(`SELECT count(*) FROM join_requests j JOIN organizations o ON o.id = j.org_id WHERE o.domain_claim = '${domain}' AND j.status = 'requested'`), '1');
    for (const email of [ownerEmail, colleagueEmail]) {
      const mail = await mailFor(email, 'Confirm your email');
      assert.ok(mail, `the verification mail of ${email} arrived`);
      assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);
    }
    const ownerId = psql(`SELECT id FROM users WHERE email_ci = '${ownerEmail}'`);
    const colleagueId = psql(`SELECT id FROM users WHERE email_ci = '${colleagueEmail}'`);
    const orgId = psql(`SELECT id FROM organizations WHERE domain_claim = '${domain}'`);
    assert.deepEqual(py(`print(json.dumps([c.standing("${colleagueId}").state, c.membership_of("${colleagueId}")]))`), ['pending_approval', null]);

    // the admin approves the company, the owner accepts the colleague; the gate needs the terms
    py(`c.approve(${admin}, "${orgId}")`, 'print(json.dumps(True))');
    const requests = py(`print(json.dumps([[r.request_id, r.user_id, r.display_name] for r in c.join_requests("${ownerId}")]))`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1], colleagueId);
    py(`c.approve_join("${ownerId}", "${requests[0][0]}")`, 'print(json.dumps(True))');
    assert.deepEqual(py(`print(json.dumps(c.membership_of("${colleagueId}")))`), [orgId, 'member']);
    assert.ok(await mailFor(colleagueEmail, 'is approved on VulnMart'), 'the colleague was told');
    const gate = (user) => py('from vulnmart.orgs.service import TermsNotAccepted', 'try:', `    print(json.dumps(["ok", c.invite_company_of("${user}")]))`, 'except TermsNotAccepted as e:', '    print(json.dumps(["terms", e.org_id]))');
    assert.deepEqual(gate(colleagueId), ['terms', orgId]);
    py(`t = c.terms_for("${ownerId}")`, `c.accept_terms("${ownerId}", t.version, t.sha256)`, 'print(json.dumps(True))');
    assert.deepEqual(gate(colleagueId), ['ok', orgId], 'the whole company can invite once the owner accepted');
    assert.equal(psql(`SELECT count(*) FROM dpa_acceptances WHERE org_id = '${orgId}' AND user_id = '${ownerId}'`), '1');

    // the cap: the global default, then an admin's number for this company
    assert.deepEqual(py(`print(json.dumps(c.invite_cap("${orgId}")))`), 50);
    py(`c.set_invite_cap(${admin}, "${orgId}", 5)`, 'print(json.dumps(True))');
    assert.deepEqual(py(`d = c.check_invite_cap("${orgId}", 4)`, 'e = c.check_invite_cap("' + orgId + '", 5)', 'print(json.dumps([d.allowed, d.remaining, e.allowed, e.remaining]))'), [true, 1, false, 0]);

    // the colleague signs in over HTTP; the session carries the company, and a suspension ends it at once
    const login = await postJson('/api/v1/session', { email: colleagueEmail, password });
    assert.equal(login.status, 200);
    const token = /__Host-vm_session=([^;]+)/.exec(login.headers.getSetCookie()[0])[1];
    assert.deepEqual(py(`s = app.state.session_service.resolve("${token}")`, 'print(json.dumps([s.scope.org_id, "recruiter" in [r.value for r in s.roles], "org_owner" in [r.value for r in s.roles]]))'), [orgId, true, false]);
    py(`c.suspend_recruiter(${admin}, "${orgId}", "${colleagueId}", "e2e: policy review")`, 'print(json.dumps(True))');
    assert.equal((await call('GET', '/api/v1/session', { headers: { cookie: `__Host-vm_session=${token}` } })).status, 401, 'the session ended at once');
    assert.equal((await postJson('/api/v1/session', { email: colleagueEmail, password })).status, 401, 'a suspended recruiter cannot sign in');
    py(`c.reinstate_recruiter(${admin}, "${orgId}", "${colleagueId}", "e2e: cleared")`, 'print(json.dumps(True))');
    assert.equal((await postJson('/api/v1/session', { email: colleagueEmail, password })).status, 200);

    // removing a member and deleting the company; the audit log has it all under pseudonyms
    py(`c.remove_member("${ownerId}", "${colleagueId}")`, 'print(json.dumps(True))');
    assert.deepEqual(py(`print(json.dumps(c.membership_of("${colleagueId}")))`), null);
    py(`c.delete_company(${admin}, "${orgId}", "e2e cleanup")`, 'print(json.dumps(True))');
    assert.equal(psql(`SELECT status || ',' || coalesce(domain_claim, 'none') FROM organizations WHERE id = '${orgId}'`), 'deleted,none');
    const actions = psql(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log WHERE action IN ('org.join_requested', 'org.join_approved', 'org.terms_accepted', 'org.invite_cap_set', 'account.suspended', 'account.reinstated', 'org.member_removed', 'org.deleted')`);
    assert.equal(actions, 'account.reinstated,account.suspended,org.deleted,org.invite_cap_set,org.join_approved,org.join_requested,org.member_removed,org.terms_accepted');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details LIKE '%${ownerId}%' OR details LIKE '%${colleagueId}%' OR details LIKE '%policy review%'`), '0');
  }, { timeout: 240000 });

  // Story P-20: a recruiter makes a template and invites a candidate who has no account; the mail really arrives through the worker, which opens the address that the
  // API sealed in the outbox row. The service is driven inside the API container as the application role (IF-1 has no recruiter route yet, handoff H-138).
  test('invites (P-20): a template, an invite by email to a person with no account, the mail arrives, the token is only a hash, resend kills the old link', async () => {
    const domain = `invites-${RUN}.example`;
    const ownerEmail = `owner@${domain}`;
    const candidate = `candidate-${RUN}@example.org`;
    const adminEmail = `e2e-invites-admin-${RUN}@example.com`;
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from sqlalchemy import text', 'from vulnmart.main import app', 'from vulnmart.ports.scope import Scope, Role',
        'c, a = app.state.companies, app.state.assessments', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const seeded = docker('exec', '-e', 'VULNMART_SEED_ADMIN_PASSWORD=a long admin password 123', NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Invites Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    const admin = `Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN}))`;
    py(`c.signup_recruiter(email="${ownerEmail}", password="correct horse battery staple", display_name="E2E Inviter", company_name="Invites Ltd")`, 'print(json.dumps(True))');
    const mail = await mailFor(ownerEmail, 'Confirm your email');
    assert.ok(mail, 'the verification mail of the recruiter arrived');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);
    const ownerId = psql(`SELECT id FROM users WHERE email_ci = '${ownerEmail}'`);
    const orgId = psql(`SELECT id FROM organizations WHERE domain_claim = '${domain}'`);
    py(`c.approve(${admin}, "${orgId}")`, `t = c.terms_for("${ownerId}")`, `c.accept_terms("${ownerId}", t.version, t.sha256)`, 'print(json.dumps(True))');
    const owner = `Scope(user_id="${ownerId}", org_id="${orgId}", roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))`;

    // a template, then an invite: while the mail waits in the outbox its address is sealed and its link carries the only copy of the token
    const created = py(`t = a.create_template(${owner}, {"title": "E2E assessment", "challenge_keys": ["C01", "C03"], "time_limit_min": 90})`,
      `i = a.create_invite(${owner}, t.template_id, "${candidate}")`,
      'with app.state.ports.sessions() as s:', '    row = s.execute(text("SELECT to_address_sealed, params::text FROM email_outbox WHERE to_user_id = :i"), {"i": i.invite_id}).one()',
      'print(json.dumps({"template": t.template_id, "invite": i.invite_id, "state": i.state, "sealed": bool(row[0]) and "@" not in row[0], "params_clean": "@" not in row[1], "version": t.version}))');
    assert.deepEqual([created.state, created.sealed, created.params_clean, created.version], ['created', true, true, 1]);
    assert.match(created.invite, /^i-[A-Z2-7]{16}$/);

    // the mail arrives at an address that has no account, through the worker
    const invitation = await mailFor(candidate, 'invited you to a security assessment');
    assert.ok(invitation, 'the invitation arrived in Mailpit');
    const link = /https?:\/\/[^\s]+\/invite\?token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})/.exec(invitation.Text);
    assert.ok(link, `a link with a token in the mail text: ${invitation.Text}`);
    const token = link[1];
    assert.deepEqual([...new Set(invitation.Text.match(/https?:\/\/[^\s]+/g))], [`http://127.0.0.1:3000/invite?token=${token}`], 'only its own link');
    assert.ok(invitation.Text.includes('Invites Ltd') && invitation.Text.includes('E2E assessment'));

    // the database holds the hash of the token and nothing that opens the invite; the address left the outbox with the mail
    const sha = crypto.createHash('sha256').update(token).digest('hex');
    assert.equal(psql(`SELECT token_hash FROM invites WHERE id = '${created.invite}'`), sha);
    assert.equal(psql(`SELECT state || ',' || coalesce(to_address_sealed, 'cleared') FROM email_outbox WHERE to_user_id = '${created.invite}'`), 'sent,cleared');
    assert.equal(psql(`SELECT count(*) FROM email_outbox WHERE params::text LIKE '%${token.slice(30)}%' OR to_address_sealed LIKE '%candidate%'`), '0', 'the sent row holds no token');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details LIKE '%${token.slice(30)}%' OR details LIKE '%${candidate}%'`), '0', 'no token and no address in the audit log');

    // the state `sent` is read from the mail; the link finds the invite; a resend gives a new link and kills the old one
    assert.deepEqual(py(`i = a.get_invite(${owner}, "${created.invite}")`, `f = a.find_by_token("${token}")`, 'print(json.dumps([i.state, f.invite_id, f.state, i.sent_at is not None]))'), ['sent', created.invite, 'sent', true]);
    py(`a.resend(${owner}, "${created.invite}")`, 'print(json.dumps(True))');
    const second = await (async () => {
      for (let i = 0; i < 60; i += 1) {
        const m = await mailFor(candidate, 'invited you to a security assessment', 1);
        const t = m && /invite\?token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})/.exec(m.Text)?.[1];
        if (t && t !== token) return t;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    })();
    assert.ok(second, 'a second mail with a new link arrived');
    assert.deepEqual(py(`print(json.dumps([a.find_by_token("${token}") is None, a.find_by_token("${second}").invite_id]))`), [true, created.invite], 'the old link is dead, the new one works');

    // the cap, a cancel, and the audit entries under pseudonyms
    py(`c.set_invite_cap(${admin}, "${orgId}", 1)`, 'print(json.dumps(True))');
    const capped = py('from vulnmart.assessments.service import InviteCapReached', 'try:', `    a.create_invite(${owner}, "${created.template}", "second-${RUN}@example.org")`,
      '    print(json.dumps(["created"]))', 'except InviteCapReached as e:', '    print(json.dumps(["cap", e.cap, e.remaining]))');
    assert.deepEqual(capped, ['cap', 1, 0], 'one invite a day for this company, and the refused one made nothing');
    assert.equal(py(`print(json.dumps(a.revoke(${owner}, "${created.invite}").state))`), 'revoked', 'the second mail had left, so the invite is revoked (a cancel is for an invite whose mail has not left)');
    assert.equal(py(`print(json.dumps(a.find_by_token("${second}").state))`), 'revoked', 'a closed invite stays closed');
    assert.equal(psql(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log WHERE action LIKE 'invite.%' OR action LIKE 'template.%'`), 'invite.created,invite.resent,invite.revoked,invite.sent,template.created');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details LIKE '%${ownerId}%'`), '0');
  }, { timeout: 240000 });

  test('ports: only web, API and Mailpit are published, on 127.0.0.1; Postgres and Valkey are not published', () => {
    for (const s of ['postgres', 'valkey']) {
      assert.deepEqual(inspect(s).NetworkSettings.Ports && Object.values(inspect(s).NetworkSettings.Ports).filter(Boolean), [], `${s} must publish nothing`);
    }
    for (const s of ['web', 'api', 'mailpit']) {
      const bindings = Object.values(inspect(s).NetworkSettings.Ports).flat().filter(Boolean);
      assert.ok(bindings.length > 0, `${s} should publish a port`);
      for (const b of bindings) assert.equal(b.HostIp, '127.0.0.1', `${s} must bind to loopback only`);
    }
  });

  test('hardening: non-root, read-only root, all capabilities dropped, no-new-privileges, memory and pids limits', () => {
    for (const s of SERVICES) {
      const c = inspect(s);
      const uid = String(c.Config.User).split(':')[0];
      assert.ok(uid && uid !== '0' && uid !== 'root', `${s} must not run as root (User=${c.Config.User})`);
      assert.equal(c.HostConfig.ReadonlyRootfs, true, `${s} root filesystem must be read-only`);
      assert.deepEqual(c.HostConfig.CapDrop, ['ALL'], `${s} must drop all capabilities`);
      assert.ok(c.HostConfig.SecurityOpt.includes('no-new-privileges:true'), `${s} needs no-new-privileges`);
      assert.equal(c.HostConfig.Privileged, false, `${s} must not be privileged`);
      assert.ok(c.HostConfig.Memory > 0, `${s} needs a memory limit`);
      assert.ok(c.HostConfig.PidsLimit > 0, `${s} needs a pids limit`);
    }
  });

  test('web has no secrets or flags in its environment', () => {
    const env = inspect('web').Config.Env.join('\n');
    assert.doesNotMatch(env, /VM\{/);
  });

  test('Postgres down: public health 503 degraded naming no store, /readyz names it; recovers', async () => {
    assert.equal(docker('stop', '--time', '2', NAME('postgres')).status, 0);
    try {
      const r = await waitForHealth(503);
      assert.deepEqual(r.body, { status: 'degraded' });
      const ready = await getJson('http://127.0.0.1:8000/readyz');
      assert.deepEqual(ready.body, { status: 'degraded', checks: { postgres: 'down', valkey: 'ok' } });
      assert.doesNotMatch(JSON.stringify(ready.body), /password|vulnmart-dev|host|error|exception/i);
    } finally {
      assert.equal(docker('start', NAME('postgres')).status, 0);
    }
    const back = await waitForHealth(200);
    assert.deepEqual(back.body, { status: 'ok' });
  }, { timeout: 180000 });

  test('Valkey down: public health 503 degraded, /readyz names valkey; recovers', async () => {
    assert.equal(docker('stop', '--time', '2', NAME('valkey')).status, 0);
    try {
      const r = await waitForHealth(503);
      assert.deepEqual(r.body, { status: 'degraded' });
      const ready = await getJson('http://127.0.0.1:8000/readyz');
      assert.deepEqual(ready.body, { status: 'degraded', checks: { postgres: 'ok', valkey: 'down' } });
    } finally {
      assert.equal(docker('start', NAME('valkey')).status, 0);
    }
    const back = await waitForHealth(200);
    assert.deepEqual(back.body, { status: 'ok' });
  }, { timeout: 180000 });

  test('down: `node scripts/dev.mjs down` leaves no platform or web container behind', () => {
    const r = dev('down');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(present(), []);
  });
});
