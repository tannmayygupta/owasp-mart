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
    assert.equal(psql(`SELECT count(*) FROM consent_records WHERE user_id = (SELECT id FROM users WHERE email_ci = '${email}')`), '0', 'nothing was written by the refused calls');

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
    assert.equal(psql(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log WHERE (action LIKE 'invite.%' OR action LIKE 'template.%') AND details LIKE '%${orgId}%'`), 'invite.created,invite.resent,invite.revoked,invite.sent,template.created');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details LIKE '%${ownerId}%'`), '0');
  }, { timeout: 240000 });

  // Story P-21: a candidate with no account opens the invite link, registers (18 or over) and verifies the address, the verified address must match the invite, the consent
  // comes first, a grant adds the candidate role and hands a consented attempt to the lab port; a re-invite replaces the attempt; bulk invites go through the outbox and
  // the worker; the invite purge empties the token of a closed invite. The services are driven inside the API container as the application role (IF-1 has no recruiter or
  // invite route yet, handoff H-138), and the lab port is the real attempt engine in that process (the production wiring of the lab port is stream L's, handoff H-141).
  test('accepting invites (P-21): open the link, register, address must match, consent first, attempt and role after it, re-invite, bulk, purge', async () => {
    const domain = `accept-${RUN}.example`;
    const ownerEmail = `owner@${domain}`;
    const candidate = `taker-${RUN}@example.org`;
    const stranger = `stranger-${RUN}@example.org`;
    const adminEmail = `e2e-accept-admin-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from sqlalchemy import text', 'from vulnmart.main import app', 'from vulnmart.ports.scope import Scope, Role',
        'c, a, acc = app.state.companies, app.state.assessments, app.state.invite_acceptance', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const linkFrom = async (address, tries = 60) => {
      for (let i = 0; i < tries; i += 1) {
        const m = await mailFor(address, 'invited you to a security assessment', 1);
        const found = m && /invite\?token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})/.exec(m.Text)?.[1];
        if (found) return found;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    };
    const seeded = docker('exec', '-e', 'VULNMART_SEED_ADMIN_PASSWORD=a long admin password 123', NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Accept Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    const admin = `Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN}))`;
    py(`c.signup_recruiter(email="${ownerEmail}", password="${password}", display_name="E2E Acceptor", company_name="Accept Ltd")`, 'print(json.dumps(True))');
    const ownerMail = await mailFor(ownerEmail, 'Confirm your email');
    assert.ok(ownerMail, 'the verification mail of the recruiter arrived');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(ownerMail.Text)[1] })).status, 200);
    const ownerId = psql(`SELECT id FROM users WHERE email_ci = '${ownerEmail}'`);
    const orgId = psql(`SELECT id FROM organizations WHERE domain_claim = '${domain}'`);
    py(`c.approve(${admin}, "${orgId}")`, `t = c.terms_for("${ownerId}")`, `c.accept_terms("${ownerId}", t.version, t.sha256)`, 'print(json.dumps(True))');
    const owner = `Scope(user_id="${ownerId}", org_id="${orgId}", roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))`;
    const made = py(`t = a.create_template(${owner}, {"title": "E2E accept", "challenge_keys": ["C01", "C03"], "retention_days": 60})`,
      `i = a.create_invite(${owner}, t.template_id, "${candidate}")`, 'print(json.dumps({"template": t.template_id, "invite": i.invite_id}))');
    const token = await linkFrom(candidate);
    assert.ok(token, 'the invitation arrived at an address with no account');

    // the link is opened before any account exists: the invite is opened; no account, no binding
    assert.deepEqual(py(`v = acc.open_link("${token}")`, 'print(json.dumps([v.state, v.user_id, v.attempt_id]))'), ['opened', null, null]);

    // the candidate registers through the real API (18 or over) and verifies the address; a stranger registers too, with another address
    for (const email of [candidate, stranger]) {
      assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Taker', age_declaration: true })).status, 202);
      const m = await mailFor(email, 'Confirm your email');
      assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(m.Text)[1] })).status, 200);
    }
    const userId = psql(`SELECT id FROM users WHERE email_ci = '${candidate}'`);
    const strangerId = psql(`SELECT id FROM users WHERE email_ci = '${stranger}'`);

    // the verified address must match; the answer does not name the invited one; nothing is bound by the refusal
    const refused = py('from vulnmart.assessments.accept import AddressMismatch', 'try:', `    acc.accept("${strangerId}", "${token}")`, '    print(json.dumps(["bound"]))', 'except AddressMismatch as e:', '    print(json.dumps(["mismatch", str(e)]))');
    assert.deepEqual(refused, ['mismatch', '']);
    assert.equal(psql(`SELECT coalesce(user_id, 'none') FROM invites WHERE id = '${made.invite}'`), 'none');

    // the one flow in one process: accept, consent first (the notice shows the template's retention), the attempt and the role only after the grant; a repeat changes nothing
    const flow = py(
      'from vulnmart_attempts import AttemptEngine, FakeClock, InMemoryAttemptStore, InMemoryInstanceControl',
      'from datetime import datetime, UTC',
      'from vulnmart.ports.engine_attempts import EngineAttemptPort',
      'from vulnmart.assessments.accept import InviteConsentTargets',
      'from vulnmart.privacy.consent import ConsentService',
      'from vulnmart.kernel.scope import ContextScopePort',
      'from vulnmart.accounts.fieldkeys import from_settings',
      'sc = ContextScopePort()',
      'engine = AttemptEngine(InMemoryAttemptStore(), InMemoryInstanceControl(), FakeClock(datetime.now(UTC)))',
      'port = EngineAttemptPort(engine)',
      'targets = InviteConsentTargets(a, port, app.state.roles)',
      'consent = ConsentService(app.state.ports.sessions, targets, app.state.ports.audit, app.state.ports.settings, from_settings(app.state.settings))',
      `got = acc.accept("${userId}", "${token}")`,
      `me = Scope(user_id="${userId}", roles=frozenset({Role.LEARNER}))`,
      'with sc.acting_as(me):',
      `    target, notice = consent.notice("${userId}", got.attempt_id)`,
      'roles_before = sorted(app.state.roles.roles_of("' + userId + '"))',
      'try:', '    port.get(got.attempt_id)', '    attempt_before = "exists"', 'except Exception as e:', '    attempt_before = type(e).__name__',
      'with sc.acting_as(me):',
      `    rec = consent.record(user_id="${userId}", attempt_id=got.attempt_id, notice_version=notice.version, notice_sha256=notice.sha256, decision="granted", ip="203.0.113.9", user_agent="e2e")`,
      `    again = consent.record(user_id="${userId}", attempt_id=got.attempt_id, notice_version=notice.version, notice_sha256=notice.sha256, decision="granted", ip="203.0.113.9", user_agent="e2e")`,
      'att = port.get(got.attempt_id)',
      'print(json.dumps({"attempt": got.attempt_id, "state": target.state, "retention": notice.retention_days_shown, "roles_before": roles_before, "attempt_before": attempt_before,',
      '  "same_record": rec.consent_id == again.consent_id, "attempt_state": att.state.value, "attempt_user": att.user_id, "consent": rec.consent_id, "roles_after": sorted(app.state.roles.roles_of("' + userId + '"))}))');
    assert.match(flow.attempt, /^a-[A-Z2-7]{16}$/);
    assert.deepEqual([flow.state, flow.retention, flow.roles_before, flow.attempt_before], ['consent', 60, ['learner'], 'AttemptNotFound']);
    assert.deepEqual([flow.same_record, flow.attempt_state, flow.attempt_user, flow.roles_after], [true, 'ready', userId, ['candidate', 'learner']]);
    assert.equal(psql(`SELECT state || ',' || user_id || ',' || attempt_id FROM invites WHERE id = '${made.invite}'`), `consented,${userId},${flow.attempt}`);
    assert.equal(psql(`SELECT count(*) FROM consent_records WHERE attempt_id = '${flow.attempt}' AND retention_days_shown = 60`), '1');

    // a re-invite after a fault: a new invite (generation 2) names the old attempt, the old invite is revoked and marked, and the new link works for the same account
    const re = py(`n = a.reinvite(${owner}, "${made.invite}")`, 'print(json.dumps({"invite": n.invite_id, "generation": n.generation, "supersedes": n.supersedes_attempt_id}))');
    assert.deepEqual([re.generation, re.supersedes], [2, flow.attempt]);
    assert.equal(psql(`SELECT state || ',' || superseded_by FROM invites WHERE id = '${made.invite}'`), `revoked,${re.invite}`);
    let second = null;
    for (let i = 0; i < 60 && !second; i += 1) {
      const m = await mailFor(candidate, 'invited you to a security assessment', 1);
      const t = m && /invite\?token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})/.exec(m.Text)?.[1];
      if (t && t !== token) second = t; else await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(second, 'the new invite arrived');
    assert.equal(py(`print(json.dumps(acc.accept("${userId}", "${second}").attempt_id != "${flow.attempt}"))`), true, 'the new link gives the same account a new attempt id');

    // bulk invites: one invite and one mail each, bad and repeated addresses reported, at the cap the rest is handed back
    py(`c.set_invite_cap(${admin}, "${orgId}", 4)`, 'print(json.dumps(True))');
    const bulk = py(`r = a.create_invites(${owner}, "${made.template}", ["b1-${RUN}@example.org", "B1-${RUN}@example.org", "nonsense", "b2-${RUN}@example.org", "b3-${RUN}@example.org", "b4-${RUN}@example.org"])`,
      'print(json.dumps({"created": len(r.created), "skipped": [list(s) for s in r.skipped], "remaining": list(r.remaining), "cap": r.cap}))');
    assert.deepEqual([bulk.created, bulk.skipped, bulk.remaining.length, bulk.cap], [2, [[`B1-${RUN}@example.org`, 'duplicate'], ['nonsense', 'invalid']], 2, 4], JSON.stringify(bulk));
    for (const who of ['b1', 'b2']) assert.ok(await linkFrom(`${who}-${RUN}@example.org`), `the bulk invite of ${who} arrived through the worker`);

    // the invite purge sees the closed invite and empties its token; the purged link opens nothing
    const purged = py('from datetime import datetime, timedelta, UTC', 'n = a.purge_closed_tokens(datetime.now(UTC) + timedelta(minutes=1))', `print(json.dumps([n, acc.open_link("${token}") is None]))`);
    assert.ok(purged[0] >= 1 && purged[1], 'the revoked invite lost its token');
    assert.equal(psql(`SELECT count(*) FROM invites WHERE id = '${made.invite}' AND token_hash IS NULL`), '1');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details LIKE '%${token.slice(30)}%' OR details LIKE '%${candidate}%'`), '0', 'no token and no address in the audit log');
    assert.equal(psql(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log WHERE action IN ('invite.bound', 'invite.superseded', 'consent.granted', 'invite.consented')`), 'consent.granted,invite.bound,invite.consented,invite.superseded');
  }, { timeout: 300000 });

  // Story P-22: the live stream on the real stack, through the web origin (proxy, origin secret): an event row in `domain_events` is moved by the worker's relay to the
  // user's Valkey stream and arrives on an open `GET /api/v1/live` connection without buffering; a heartbeat comes while nothing happens; another user's events never
  // arrive; after the API is restarted a reconnect with `Last-Event-ID` gets what was missed, once and in order; an unknown id gets one `stream.resync`; the snapshot
  // answers. There is no lab runtime in this stack, so the attempt rows are written directly (the lab publishes the real events, stream L).
  test('live updates (P-22): events reach an open stream through the proxy, heartbeat, isolation, replay after an API restart, resync, snapshot', async () => {
    const email = `e2e-live-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql).stdout.trim();
    const upper = RUN.toUpperCase().replace(/[^A-Z2-7]/g, 'A');
    const attemptId = `a-${('L' + upper).padEnd(16, 'A').slice(0, 16)}`;
    const otherId = `a-${('O' + upper).padEnd(16, 'A').slice(0, 16)}`;
    assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Live', age_declaration: true })).status, 202);
    const mail = await mailFor(email, 'Confirm your email');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);
    const login = await postJson('/api/v1/session', { email, password });
    assert.equal(login.status, 200);
    const cookie = /(__Host-vm_session=[^;]+)/.exec(login.headers.getSetCookie()[0])[1];
    const userId = psql(`SELECT id FROM users WHERE email_ci = '${email}'`);
    psql(`INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES ('${attemptId}', '${userId}', 't-live-${RUN}', NULL, 'running', 0, '{}'::jsonb), ('${otherId}', 'u-someone-else-${RUN}', 't-other-${RUN}', NULL, 'running', 0, '{}'::jsonb)`);

    const event = (attempt, milestone) => JSON.stringify({ schema_version: 1, type: 'attempt.milestone_reached', occurred_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      data: { attempt_id: attempt, mode: 'learner', challenge_key: 'C01', milestone } });
    const publishRow = (attempt, milestone) => psql(`INSERT INTO domain_events (type, payload, created_at) VALUES ('attempt.milestone_reached', '${event(attempt, milestone)}'::jsonb, now())`);

    // an unauthenticated stream is refused through the proxy
    const refused = await call('GET', '/api/v1/live');
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).code, 'AUTH-SESSION-REQUIRED');

    // a small SSE client: frames as they arrive, with the time each was read
    const openStream = async (lastEventId) => {
      const controller = new AbortController();
      const res = await fetch(`${ORIGIN}/api/v1/live`, { headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: controller.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const seen = [];
      let ended = false;
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at;
            while ((at = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, at);
              buffer = buffer.slice(at + 2);
              const item = { at: Date.now(), raw: block };
              for (const line of block.split('\n')) {
                if (line.startsWith(': ')) item.comment = line.slice(2);
                else if (line.startsWith('id: ')) item.id = line.slice(4);
                else if (line.startsWith('event: ')) item.event = line.slice(7);
                else if (line.startsWith('data: ')) item.data = JSON.parse(line.slice(6));
              }
              seen.push(item);
            }
          }
        } catch { /* aborted */ }
        ended = true;
      })();
      const until = async (predicate, ms = 8000) => {
        const stop = Date.now() + ms;
        while (Date.now() < stop) {
          const found = seen.find(predicate);
          if (found) return found;
          await new Promise((r) => setTimeout(r, 20));
        }
        return null;
      };
      return { res, seen, until, isEnded: () => ended, close: () => { controller.abort(); return pump; } };
    };

    const stream = await openStream();
    assert.equal(stream.res.status, 200);
    assert.match(stream.res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(stream.res.headers.get('cache-control'), 'private, no-store');
    assert.equal(stream.res.headers.get('x-accel-buffering'), 'no');
    assert.ok(await stream.until((f) => f.comment === 'stream open', 3000), 'the first frame arrived at once: the proxy does not hold the stream back');

    // an event row becomes a frame on the open connection: through the worker's relay, Valkey and the hub, without buffering
    const sentAt = Date.now();
    publishRow(attemptId, 'M1');
    const first = await stream.until((f) => f.event === 'attempt.milestone_reached', 8000);
    assert.ok(first, 'the milestone arrived on the open stream');
    const latency = first.at - sentAt;
    console.log(`# live: event row to frame on the open stream ${latency} ms (relay every 250 ms)`);
    assert.ok(latency < 3000, `arrived in ${latency} ms`);
    assert.match(first.id, /^\d{1,15}-\d{1,9}$/);
    assert.equal(first.data.data.attempt_id, attemptId);
    assert.deepEqual(Object.keys(first.data).sort(), ['data', 'occurred_at', 'schema_version', 'type']);

    // the API's own port writes the same kind of row (an event published from inside the API process)
    const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app',
      `e = json.loads('${event(attemptId, 'M2')}')`, 'entry = app.state.ports.outbox.publish(e)', 'print(json.dumps(entry.audiences))'].join('\n'));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').pop()), ['user']);
    assert.ok(await stream.until((f) => f.data?.data?.milestone === 'M2', 8000), 'an event published through the API port arrived too');

    // another user's attempt: its events reach no stream of this user
    publishRow(otherId, 'M3');
    publishRow(attemptId, 'M3');
    assert.ok(await stream.until((f) => f.data?.data?.milestone === 'M3', 8000));
    assert.ok(!stream.seen.some((f) => f.data?.data?.attempt_id === otherId), "another user's event never arrived");

    // a heartbeat comment while nothing happens (the interval is 15 s)
    const beat = await stream.until((f) => f.comment === 'heartbeat', 20000);
    assert.ok(beat, 'a heartbeat came');

    // the replay buffer is in Valkey: one stream per audience, holding the events as the browser reads them
    const xlen = docker('exec', NAME('valkey'), 'valkey-cli', 'XLEN', `live:user:${userId}`).stdout.trim();
    assert.equal(xlen, '3');
    const ids = stream.seen.filter((f) => f.event).map((f) => f.id);
    assert.equal(ids.length, 3);
    await stream.close();

    // killing the API loses nothing: events published while it is down wait in Valkey and a reconnect with Last-Event-ID gets them, once and in order
    const last = ids[0]; // reconnect from the first one: the second and third are replayed, and the two published while the API is down
    assert.equal(docker('stop', '--time', '2', NAME('api')).status, 0);
    publishRow(attemptId, 'M1');
    publishRow(attemptId, 'M2');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(docker('start', NAME('api')).status, 0);
    await waitForHealth(200);
    const again = await openStream(last);
    assert.equal(again.res.status, 200);
    for (let i = 0; i < 400 && again.seen.filter((f) => f.event).length < 4; i += 1) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 500)); // and nothing more arrives
    const got = again.seen.filter((f) => f.event);
    assert.equal(got.length, 4, `second, third and the two missed ones, nothing twice: ${got.map((f) => f.id)}`);
    assert.deepEqual(got.map((f) => f.id), [...got.map((f) => f.id)].sort((a, b) => { const [x, y] = a.split('-').map(Number); const [p, q] = b.split('-').map(Number); return x - p || y - q; }));
    assert.deepEqual(got.slice(0, 2).map((f) => f.id), ids.slice(1));
    assert.equal(new Set(got.map((f) => f.id)).size, 4);
    await again.close();

    // an id the hub does not know: one resync, no id, and the connection ends
    const unknown = await openStream('99999999999999-1');
    assert.ok(await unknown.until((f) => f.event === 'stream.resync', 5000));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(unknown.seen.length, 1);
    assert.equal(unknown.seen[0].id, undefined);
    assert.equal(unknown.seen[0].data.data.reason, 'id_unknown');
    assert.ok(unknown.isEnded(), 'the connection ended after the resync');

    // the snapshot is the way back after a resync (no lab in this stack: nothing to show, but the shape is the contract's)
    const snapshot = await call('GET', '/api/v1/live/snapshot', { headers: { cookie } });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('cache-control'), 'private, no-store');
    const body = await snapshot.json();
    assert.deepEqual(Object.keys(body).sort(), ['attempts', 'instances', 'server_time']);
    assert.deepEqual([body.attempts, body.instances], [[], []]);

    // every event of this test was relayed: nothing waits in the outbox, nothing was dropped
    assert.equal(psql(`SELECT count(*) FROM domain_events WHERE published_at IS NULL AND payload->'data'->>'attempt_id' IN ('${attemptId}', '${otherId}')`), '0');
    assert.equal(psql(`SELECT count(*) FROM domain_events WHERE dropped AND payload->'data'->>'attempt_id' IN ('${attemptId}', '${otherId}')`), '0');
    assert.equal(psql(`SELECT count(*) FROM domain_events WHERE payload->'data'->>'attempt_id' = '${otherId}' AND published_at IS NOT NULL`), '1');
  }, { timeout: 240000 });

  // Story P-23: the stream is authorised per user (a second user cannot read the first one's events, with or without their ids), it ends when the session ends, and it
  // runs over HTTP/2 through the real Caddy image: one TLS connection carries the stream, a second stream of the same user and ordinary API calls at once.
  const H2_CADDY = 'vulnmart-h2-caddy';
  const DEV_SECRET = process.env.VULNMART_DEV_ORIGIN_SECRET ?? 'vulnmart-dev-origin-secret-not-a-secret';
  const signedIn = async (label) => {
    const email = `e2e-${label}-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: `E2E ${label}`, age_declaration: true })).status, 202);
    const mail = await mailFor(email, 'Confirm your email');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);
    const login = await postJson('/api/v1/session', { email, password });
    assert.equal(login.status, 200);
    return { cookie: /(__Host-vm_session=[^;]+)/.exec(login.headers.getSetCookie()[0])[1], csrf: (await login.json()).csrf_token, email };
  };
  const rowFor = (psql, attempt, milestone) => psql(`INSERT INTO domain_events (type, payload, created_at) VALUES ('attempt.milestone_reached', '${JSON.stringify({
    schema_version: 1, type: 'attempt.milestone_reached', occurred_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    data: { attempt_id: attempt, mode: 'learner', challenge_key: 'C01', milestone } })}'::jsonb, now())`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // frames of an SSE body as they arrive over fetch or http2: a list of { id, event, data, comment }
  const frameParser = () => {
    let buffer = '';
    const seen = [];
    return {
      seen,
      feed(text) {
        buffer += text;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const item = { at: Date.now() };
          for (const line of block.split('\n')) {
            if (line.startsWith(': ')) item.comment = line.slice(2);
            else if (line.startsWith('id: ')) item.id = line.slice(4);
            else if (line.startsWith('event: ')) item.event = line.slice(7);
            else if (line.startsWith('data: ')) item.data = JSON.parse(line.slice(6));
          }
          seen.push(item);
        }
      },
    };
  };

  test('stream authorisation (P-23): another user never reads your events, with or without their ids, and a logout ends the stream', async () => {
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql).stdout.trim();
    const upper = RUN.toUpperCase().replace(/[^A-Z2-7]/g, 'A');
    const alice = await signedIn('auth-a');
    const bob = await signedIn('auth-b');
    const idOf = (s) => psql(`SELECT id FROM users WHERE email_ci = '${s.email}'`);
    const [aliceId, bobId] = [idOf(alice), idOf(bob)];
    const aliceAttempt = `a-${('P' + upper).padEnd(16, 'A').slice(0, 16)}`;
    const bobAttempt = `a-${('Q' + upper).padEnd(16, 'A').slice(0, 16)}`;
    psql(`INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES ('${aliceAttempt}', '${aliceId}', 't-pa-${RUN}', NULL, 'running', 0, '{}'::jsonb), ('${bobAttempt}', '${bobId}', 't-pb-${RUN}', NULL, 'running', 0, '{}'::jsonb)`);

    const open = async (cookie, lastEventId) => {
      const controller = new AbortController();
      const res = await fetch(`${ORIGIN}/api/v1/live`, { headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: controller.signal });
      const parser = frameParser();
      let ended = false;
      const decoder = new TextDecoder();
      const pump = (async () => {
        const reader = res.body?.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }));
          }
        } catch { /* aborted */ }
        ended = true;
      })();
      return { res, seen: parser.seen, isEnded: () => ended, close: () => { controller.abort(); return pump; } };
    };
    const waitFor = async (predicate, ms = 10000) => { const stop = Date.now() + ms; while (Date.now() < stop) { if (predicate()) return true; await sleep(25); } return false; };

    // each user's own events arrive, the other's never do
    const a = await open(alice.cookie);
    const b = await open(bob.cookie);
    assert.ok(await waitFor(() => a.seen.length > 0 && b.seen.length > 0, 5000), 'both streams are open');
    rowFor(psql, aliceAttempt, 'M1');
    rowFor(psql, bobAttempt, 'M2');
    assert.ok(await waitFor(() => a.seen.some((f) => f.event) && b.seen.some((f) => f.event), 8000), 'each received an event');
    assert.deepEqual(a.seen.filter((f) => f.event).map((f) => f.data.data.attempt_id), [aliceAttempt]);
    assert.deepEqual(b.seen.filter((f) => f.event).map((f) => f.data.data.attempt_id), [bobAttempt]);
    const bobFirstId = b.seen.find((f) => f.event).id;
    await b.close();
    await a.close();

    // Alice presents Bob's event id (a place in time) and a cookie of her own: she gets her events after that point, never Bob's
    rowFor(psql, bobAttempt, 'M3');
    rowFor(psql, aliceAttempt, 'M3');
    await sleep(1500);
    const replay = await open(alice.cookie, bobFirstId);
    assert.ok(await waitFor(() => replay.seen.some((f) => f.event), 8000));
    await sleep(500);
    assert.deepEqual(replay.seen.filter((f) => f.event).map((f) => [f.data.data.attempt_id, f.data.data.milestone]), [[aliceAttempt, 'M3']], 'only her own event after that point');
    assert.ok(!replay.seen.some((f) => f.data?.data?.attempt_id === bobAttempt), "Bob's events never reach Alice, whatever id she presents");
    await replay.close();

    // another site's cookie, no cookie, a forged cookie: no stream
    for (const cookie of ['', '__Host-vm_session=' + 'A'.repeat(43)]) {
      const refused = await fetch(`${ORIGIN}/api/v1/live`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(10000) });
      assert.equal(refused.status, 401, `cookie "${cookie.slice(0, 20)}"`);
      assert.equal((await refused.json()).code, 'AUTH-SESSION-REQUIRED');
    }

    // a logout ends an open stream (the hub looks at the session every 30 s)
    const open2 = await open(alice.cookie);
    assert.ok(await waitFor(() => open2.seen.length > 0, 5000));
    const out = await call('DELETE', '/api/v1/session', { headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrf } });
    assert.equal(out.status, 204);
    const stopped = Date.now();
    assert.ok(await waitFor(() => open2.isEnded(), 45000), 'the stream ended after the logout');
    console.log(`# live: stream ended ${Date.now() - stopped} ms after the logout (the session is checked every 30 s)`);
    assert.ok(!open2.seen.some((f) => f.event === 'stream.resync'), 'a closed session is not a resync');
    const after = await fetch(`${ORIGIN}/api/v1/live`, { headers: { cookie: alice.cookie }, signal: AbortSignal.timeout(10000) });
    assert.equal(after.status, 401, 'the old cookie opens nothing');
  }, { timeout: 240000 });

  test('live updates over HTTP/2 (P-23): one connection carries six streams and ordinary calls through the real Caddy image', async () => {
    const http2 = await import('node:http2');
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql).stdout.trim();
    const upper = RUN.toUpperCase().replace(/[^A-Z2-7]/g, 'A');
    const user = await signedIn('h2');
    const userId = psql(`SELECT id FROM users WHERE email_ci = '${user.email}'`);
    const attempt = `a-${('H' + upper).padEnd(16, 'A').slice(0, 16)}`;
    psql(`INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES ('${attempt}', '${userId}', 't-h2-${RUN}', NULL, 'running', 0, '{}'::jsonb)`);
    docker('rm', '-f', H2_CADDY);
    const started = docker('run', '-d', '--name', H2_CADDY, '--network', 'vulnmart_default', '-p', '127.0.0.1:8443:8443', '-e', `ORIGIN_SECRET=${DEV_SECRET}`,
      '-v', `${path.join(ROOT, 'infra', 'caddy', 'Caddyfile.live-h2')}:/etc/caddy/Caddyfile:ro`, 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d');
    assert.equal(started.status, 0, started.stderr);
    let client;
    try {
      const connect = async () => {
        for (let i = 0; i < 60; i += 1) {
          try {
            const session = http2.connect('https://127.0.0.1:8443', { rejectUnauthorized: false, servername: 'localhost' });
            await new Promise((resolve, reject) => { session.once('connect', resolve); session.once('error', reject); });
            return session;
          } catch { await sleep(500); }
        }
        throw new Error('Caddy did not come up');
      };
      client = await connect();
      client.on('error', () => {});
      assert.equal(client.alpnProtocol, 'h2', 'HTTP/2 was negotiated');

      const request = (pathName, headers = {}) => new Promise((resolve) => {
        const req = client.request({ ':path': pathName, cookie: user.cookie, ...headers });
        const parser = frameParser();
        const out = { headers: null, body: '', seen: parser.seen, ended: false, close: () => req.close() };
        req.setEncoding('utf8');
        req.on('response', (h) => { out.headers = h; resolve(out); });
        req.on('data', (d) => { out.body += d; parser.feed(d); });
        req.on('end', () => { out.ended = true; });
        req.on('error', () => { out.ended = true; });
      });
      const waitFor = async (predicate, ms = 10000) => { const stop = Date.now() + ms; while (Date.now() < stop) { if (predicate()) return true; await sleep(25); } return false; };

      // six streams of one user on one TLS connection (the per-user cap is six)
      const streams = [];
      for (let i = 0; i < 6; i += 1) streams.push(await request('/api/v1/live'));
      for (const s of streams) {
        assert.equal(s.headers[':status'], 200);
        assert.match(s.headers['content-type'], /^text\/event-stream/);
        assert.equal(s.headers['cache-control'], 'private, no-store');
        assert.equal(s.headers['x-accel-buffering'], 'no');
        assert.equal(s.headers.connection, undefined, 'no connection-specific header in an HTTP/2 answer');
        assert.equal(s.headers['transfer-encoding'], undefined);
        assert.equal(s.headers['content-encoding'], undefined, 'the stream is not compressed');
      }
      assert.ok(await waitFor(() => streams.every((s) => s.seen.some((f) => f.comment === 'stream open')), 5000), 'the first frame reached every stream at once');

      // a seventh is refused with a hint, and an ordinary call on the same connection is answered while the six are open
      const seventh = await request('/api/v1/live');
      assert.equal(seventh.headers[':status'], 429);
      assert.equal(seventh.headers['retry-after'], '5');
      const t0 = Date.now();
      const snapshot = await request('/api/v1/live/snapshot');
      await waitFor(() => snapshot.ended, 5000);
      assert.equal(snapshot.headers[':status'], 200);
      assert.deepEqual(Object.keys(JSON.parse(snapshot.body)).sort(), ['attempts', 'instances', 'server_time']);
      console.log(`# live: a call on the same HTTP/2 connection while six streams are open took ${Date.now() - t0} ms`);

      // an event reaches all six
      const sentAt = Date.now();
      rowFor(psql, attempt, 'M1');
      assert.ok(await waitFor(() => streams.every((s) => s.seen.some((f) => f.event)), 8000), 'all six streams received the event');
      const slowest = Math.max(...streams.map((s) => s.seen.find((f) => f.event).at)) - sentAt;
      console.log(`# live: one event row to six HTTP/2 streams through Caddy ${slowest} ms`);
      assert.ok(slowest < 3000);
      for (const s of streams) assert.equal(s.seen.filter((f) => f.event).length, 1);
      for (const s of streams) s.close();
    } finally {
      client?.close();
      docker('rm', '-f', H2_CADDY);
    }
  }, { timeout: 180000 });

  // Story P-24: the retention scheduler on the real stack. It runs inside the API process (Compose turns it on) and ran every job once at start; the admin's view of the last run
  // of each job (`Scheduler.status`) shows them; an aged learner is warned by a real mail through the worker, and after the warning period deleted with the account and its
  // pseudonym; an aged invite the candidate never started is deleted by the candidate retention job; published event rows past their week are cleared. The jobs are run on demand
  // inside the API container with the application role (`app.state.scheduler.run`), so the test does not wait a day; the dates are set with psql as the owner role.
  test('retention (P-24): the scheduler ran at start, the admin sees the runs, an aged learner is warned and deleted, an aged invite goes, old event rows are cleared', async () => {
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app', 'sch = app.state.scheduler', 'c, a = app.state.companies, app.state.assessments',
        'from vulnmart.ports.scope import Scope, Role', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const JOBS = ['invite_expiry', 'invite_purge', 'candidate_retention', 'consent_purge', 'learner_warning', 'learner_retention', 'evidence_retention', 'account_housekeeping', 'log_purge', 'live_cleanup', 'audit_anchor', 'deletion_requests'];

    // every job ran when the API started, and the admin's view shows the last run of each
    for (let i = 0; i < 60 && Number(psql(`SELECT count(DISTINCT job) FROM job_runs WHERE status = 'succeeded' AND job IN (${JOBS.map((j) => `'${j}'`).join(',')})`)) < JOBS.length; i += 1) await sleep(1000);
    const status = py('print(json.dumps({s.name: [s.last_status, s.last_detail, s.last_success_at is not None, s.next_due_at.isoformat()] for s in sch.status()}))');
    assert.deepEqual(Object.keys(status).sort(), [...JOBS].sort());
    for (const [name, [state, detail, ok]] of Object.entries(status)) assert.ok(state === 'succeeded' && ok && detail, `${name}: ${state} ${detail}`);
    assert.equal(psql(`SELECT count(*) FROM job_runs WHERE status = 'failed' AND started_at > now() - interval '1 hour'`), '0', 'no job failed');

    // an aged learner: the warning mail really arrives, then the account goes
    const email = `e2e-retain-${RUN}@example.com`;
    const learner = `u-${('R' + RUN.toUpperCase().replace(/[^A-Z2-7]/g, 'A')).padEnd(16, 'A').slice(0, 16)}`;
    psql(`INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status, email_verified_at, last_login_at, created_at) VALUES ('${learner}', 'participant', '${email}', '${email}', 'x', 'Old Learner', 'active', now(), now() - interval '340 days', now() - interval '400 days')`);
    psql(`INSERT INTO user_roles (user_id, role, account_type) VALUES ('${learner}', 'learner', 'participant')`);
    assert.equal(py('print(json.dumps(sch.run("learner_warning")))'), true);
    assert.equal(psql(`SELECT retention_warned_at IS NOT NULL FROM users WHERE id = '${learner}'`), 't');
    const warning = await mailFor(email, 'will be deleted soon');
    assert.ok(warning, 'the warning mail arrived');
    assert.match(warning.Text, /deleted on \d{4}-\d{2}-\d{2}/);
    assert.match(warning.Text, /sign in/i);
    assert.doesNotMatch(warning.Text, /\b(law|legal|required)\b/i, 'no legal duty is claimed');
    assert.equal(psql(`SELECT count(*) FROM email_outbox WHERE template = 'learner.retention_warning' AND to_user_id = '${learner}'`), '1');
    // not yet: a day later the learner is still there; with the dates moved on, the account and its pseudonym are gone
    py('sch.run("learner_retention")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM users WHERE id = '${learner}'`), '1', 'warned today: not deleted today');
    psql(`UPDATE users SET last_login_at = now() - interval '400 days', retention_warned_at = now() - interval '40 days' WHERE id = '${learner}'`);
    psql(`INSERT INTO subject_map (subject_id, user_id) VALUES ('s-${learner.slice(2)}', '${learner}')`);
    py('sch.run("learner_retention")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM users WHERE id = '${learner}'`), '0', 'the account is deleted');
    assert.equal(psql(`SELECT count(*) FROM user_roles WHERE user_id = '${learner}'`), '0');
    assert.equal(psql(`SELECT count(*) FROM subject_map WHERE user_id = '${learner}'`), '0', 'the audit pseudonym is forgotten');
    assert.ok(Number(psql(`SELECT count(*) FROM audit_log WHERE action = 'retention.learner_deleted'`)) >= 1, 'the deletion is in the audit log');

    // a company, a template that keeps records for 30 days, an invite the candidate never opens, aged 40 days: the candidate retention job deletes it
    const domain = `retain-${RUN}.example`;
    const ownerEmail = `owner@${domain}`;
    const adminEmail = `e2e-retain-admin-${RUN}@example.com`;
    const seeded = docker('exec', '-e', 'VULNMART_SEED_ADMIN_PASSWORD=a long admin password 123', NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Retain Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    py(`c.signup_recruiter(email="${ownerEmail}", password="correct horse battery staple", display_name="E2E Retainer", company_name="Retain Ltd")`, 'print(json.dumps(True))');
    const ownerMail = await mailFor(ownerEmail, 'Confirm your email');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(ownerMail.Text)[1] })).status, 200);
    const ownerId = psql(`SELECT id FROM users WHERE email_ci = '${ownerEmail}'`);
    const orgId = psql(`SELECT id FROM organizations WHERE domain_claim = '${domain}'`);
    py(`c.approve(Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN})), "${orgId}")`, `t = c.terms_for("${ownerId}")`, `c.accept_terms("${ownerId}", t.version, t.sha256)`, 'print(json.dumps(True))');
    const made = py(`o = Scope(user_id="${ownerId}", org_id="${orgId}", roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))`,
      'tpl = a.create_template(o, {"title": "E2E retention", "challenge_keys": ["C01"], "retention_days": 30})',
      `inv = a.create_invite(o, tpl.template_id, "never-${RUN}@example.org")`, 'print(json.dumps({"invite": inv.invite_id}))');
    assert.equal(psql(`SELECT count(*) FROM invites WHERE id = '${made.invite}'`), '1');
    py('sch.run("candidate_retention")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM invites WHERE id = '${made.invite}'`), '1', 'a new invite is not due');
    psql(`UPDATE invites SET created_at = now() - interval '40 days' WHERE id = '${made.invite}'`);
    py('sch.run("candidate_retention")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM invites WHERE id = '${made.invite}'`), '0', 'the aged invite is deleted');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE action = 'retention.candidate_deleted' AND details LIKE '%${orgId}%'`), '1');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details LIKE '%never-${RUN}%'`), '0', 'no address in the audit log');

    // published event rows past their week are cleared, and the run is recorded
    psql(`INSERT INTO domain_events (type, payload, created_at, published_at) VALUES ('attempt.milestone_reached', '{}'::jsonb, now() - interval '9 days', now() - interval '8 days')`);
    const before = psql(`SELECT count(*) FROM domain_events WHERE published_at < now() - interval '7 days'`);
    assert.ok(Number(before) >= 1);
    py('sch.run("live_cleanup")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM domain_events WHERE published_at < now() - interval '7 days'`), '0');
    assert.equal(psql(`SELECT count(*) FROM job_runs WHERE status = 'failed' AND started_at > now() - interval '1 hour'`), '0');
  }, { timeout: 300000 });

  // Story P-25: the deletion workflow on the real stack. A learner signs up, asks for deletion through the proxy (the routes need a session and the CSRF header), sees the request
  // with its 7-day date, undoes it, asks again; the date is then moved into the past with psql as the owner role and the job `deletion_requests` is run inside the API container
  // with the application role: the account, its roles and its audit pseudonym are gone, and the audit entries stay without naming anyone.
  test('deletion (P-25): a learner asks, sees the date, undoes, asks again; after the hold the job deletes the account and forgets the pseudonym', async () => {
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app', 'sch = app.state.scheduler', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const email = `e2e-delete-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Delete', age_declaration: true })).status, 202);
    const mail = await mailFor(email, 'Confirm your email');
    assert.ok(mail, 'the verification mail arrived');
    assert.equal((await postJson('/api/v1/accounts/verify-email', { token: /verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text)[1] })).status, 200);

    for (const r of [await call('GET', '/api/v1/me/deletion-requests'), await call('GET', '/api/v1/me/data-views'), await postJson('/api/v1/me/deletion-requests', { kind: 'learner' })]) assert.equal(r.status, 401);
    const login = await postJson('/api/v1/session', { email, password });
    assert.equal(login.status, 200);
    const cookie = `__Host-vm_session=${/__Host-vm_session=([^;]+)/.exec(login.headers.getSetCookie()[0])[1]}`;
    const csrf = (await login.json()).csrf_token;
    const userId = psql(`SELECT id FROM users WHERE email_ci = '${email}'`);

    assert.equal((await postJson('/api/v1/me/deletion-requests', { kind: 'learner' }, { cookie })).status, 403, 'no CSRF token');
    const created = await postJson('/api/v1/me/deletion-requests', { kind: 'learner' }, { cookie, 'x-csrf-token': csrf });
    assert.equal(created.status, 201);
    const request = await created.json();
    assert.deepEqual([request.kind, request.status, request.can_undo, request.attempt_id], ['learner', 'pending', true, null]);
    const days = (Date.parse(request.execute_after) - Date.parse(request.requested_at)) / 86400000;
    assert.ok(days > 6.99 && days < 7.01, `held 7 days, got ${days}`);
    assert.equal((await postJson('/api/v1/me/deletion-requests', { kind: 'learner' }, { cookie, 'x-csrf-token': csrf })).status, 409, 'one open request at a time');
    assert.equal((await postJson('/api/v1/me/deletion-requests', { kind: 'candidate' }, { cookie, 'x-csrf-token': csrf })).status, 422, 'a candidate request names an attempt');
    assert.equal((await postJson('/api/v1/me/deletion-requests', { kind: 'candidate', attempt_id: 'a-ABCDEFGHIJKLMNOP' }, { cookie, 'x-csrf-token': csrf })).status, 404, 'not your attempt');
    const listed = await (await call('GET', '/api/v1/me/deletion-requests', { headers: { cookie } })).json();
    assert.deepEqual(listed.items.map((i) => i.request_id), [request.request_id]);
    assert.deepEqual(await (await call('GET', '/api/v1/me/data-views', { headers: { cookie } })).json(), { items: [], has_more: false });

    // undo: the job has nothing to do, even with the date in the past
    const undone = await call('DELETE', `/api/v1/me/deletion-requests/${request.request_id}`, { headers: { cookie, 'x-csrf-token': csrf, origin: ORIGIN } });
    assert.equal(undone.status, 200);
    assert.equal((await undone.json()).status, 'cancelled');
    assert.equal((await call('DELETE', `/api/v1/me/deletion-requests/${request.request_id}`, { headers: { cookie, 'x-csrf-token': csrf, origin: ORIGIN } })).status, 409);
    psql(`UPDATE deletion_requests SET execute_after = now() - interval '1 minute' WHERE user_id = '${userId}'`);
    py('sch.run("deletion_requests")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM users WHERE id = '${userId}'`), '1', 'undone: nothing was deleted');

    // ask again, move the date, run the job: the account, the roles and the pseudonym are gone, the audit entries stay
    const again = await (await postJson('/api/v1/me/deletion-requests', { kind: 'learner' }, { cookie, 'x-csrf-token': csrf })).json();
    assert.notEqual(again.request_id, request.request_id);
    const pseudonym = psql(`SELECT subject_id FROM subject_map WHERE user_id = '${userId}'`);
    assert.match(pseudonym, /^s-[A-Z2-7]{16}$/);
    py('sch.run("deletion_requests")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM users WHERE id = '${userId}'`), '1', 'inside the 7 days: nothing is deleted');
    psql(`UPDATE deletion_requests SET execute_after = now() - interval '1 minute' WHERE id = '${again.request_id}'`);
    py('sch.run("deletion_requests")', 'print(json.dumps(True))');
    assert.equal(psql(`SELECT count(*) FROM users WHERE id = '${userId}'`), '0', 'the account is deleted');
    assert.equal(psql(`SELECT count(*) FROM user_roles WHERE user_id = '${userId}'`), '0');
    assert.equal(psql(`SELECT count(*) FROM sessions WHERE user_id = '${userId}'`), '0');
    assert.equal(psql(`SELECT count(*) FROM subject_map WHERE user_id = '${userId}'`), '0', 'the audit pseudonym is forgotten');
    assert.equal(psql(`SELECT status FROM deletion_requests WHERE id = '${again.request_id}'`), 'done');
    assert.ok(Number(psql(`SELECT count(*) FROM audit_log WHERE subject = '${pseudonym}' AND action IN ('deletion.requested', 'deletion.cancelled', 'deletion.learner_done')`)) >= 3, 'the entries stay');
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE details::text LIKE '%${userId}%' OR details::text LIKE '%${email}%' OR actor LIKE '%${userId}%'`), '0', 'and name nobody');
    assert.equal(psql(`SELECT count(*) FROM job_runs WHERE status = 'failed' AND started_at > now() - interval '1 hour'`), '0');
    assert.equal((await call('GET', '/api/v1/me', { headers: { cookie } })).status, 401, 'the session of a deleted account is over');
  }, { timeout: 300000 });

  // Story P-28: the admin area on the real stack. An admin is seeded inside the API container, signs in through the proxy and (the stack has no authenticator app) the second
  // factor is marked on the session with psql; without it every admin route answers like a route that does not exist. The admin approves a company, locks and unlocks a learner,
  // changes a setting and a quota that the API process's own quota port then reads, and sees capacity and the scheduler's runs. Force-stop needs a lab in the API process, and the
  // stack has none: it is tested with a stand-in in test_admin_ops.py and test_admin_api.py only.
  test('admin (P-28): approve a company, lock a learner, change a setting and a quota the lab reads, capacity and jobs; nothing without the second factor', async () => {
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app', 'c = app.state.companies', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const password = 'correct horse battery staple';
    const adminEmail = `e2e-ops-admin-${RUN}@example.com`; // not the P-13 address: a second seed for an existing address changes nothing
    assert.equal(py(`print(json.dumps(app.state.admins.seed_admin(email="${adminEmail}", display_name="E2E Ops Admin", password="${password}")))`), true);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    // a learner to lock, and a company waiting for approval
    const learnerEmail = `e2e-adminlearner-${RUN}@example.com`;
    assert.equal((await postJson('/api/v1/accounts', { email: learnerEmail, password, display_name: 'E2E Locked', age_declaration: true })).status, 202);
    const learnerId = psql(`SELECT id FROM users WHERE email_ci = '${learnerEmail}'`);
    psql(`UPDATE users SET email_verified_at = now() WHERE id = '${learnerId}'`);
    const ownerEmail = `owner-${RUN}@e2e-${RUN}.example`;
    py(`c.signup_recruiter(email="${ownerEmail}", password="${password}", display_name="E2E Owner", company_name="E2E Admin Co ${RUN}")`, 'print(json.dumps(True))');
    psql(`UPDATE users SET email_verified_at = now() WHERE email_ci = '${ownerEmail}'`);
    const orgId = psql(`SELECT o.id FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE u.email_ci = '${ownerEmail}'`);

    const login = await postJson('/api/v1/session', { email: adminEmail, password });
    assert.equal(login.status, 200);
    const cookie = `__Host-vm_session=${/__Host-vm_session=([^;]+)/.exec(login.headers.getSetCookie()[0])[1]}`;
    const csrf = (await login.json()).csrf_token;
    const get = (path) => call('GET', path, { headers: { cookie } });
    const send = (method, path, body) => call(method, path, { body, headers: { cookie, 'x-csrf-token': csrf, origin: ORIGIN } });

    // without the second factor the admin area is not there
    const before = await get('/api/v1/admin/settings');
    assert.equal(before.status, 404);
    assert.equal((await before.json()).code, 'REQ-ROUTE-UNKNOWN');
    psql(`UPDATE sessions SET mfa_at = now() WHERE user_id = '${adminId}'`);

    // the queue and a decision
    const queue = await get('/api/v1/admin/companies/pending');
    assert.equal(queue.status, 200);
    assert.equal(queue.headers.get('cache-control'), 'private, no-store');
    assert.ok((await queue.json()).items.some((i) => i.org_id === orgId), 'the company waits');
    assert.equal((await send('POST', `/api/v1/admin/companies/${orgId}/decision`, { decision: 'approve' })).status, 204);
    assert.equal(psql(`SELECT status FROM organizations WHERE id = '${orgId}'`), 'active');
    assert.equal((await send('POST', `/api/v1/admin/companies/${orgId}/decision`, { decision: 'approve' })).status, 409);

    // lock and unlock: the learner cannot sign in while locked
    const users = await (await get(`/api/v1/admin/users?q=${encodeURIComponent(learnerEmail)}`)).json();
    assert.deepEqual(users.items.map((u) => u.user_id), [learnerId]);
    assert.doesNotMatch(JSON.stringify(users), /argon2|password/i);
    assert.deepEqual(await (await send('POST', `/api/v1/admin/users/${learnerId}/actions`, { action: 'lock', reason: 'e2e' })).json(), { outcome: 'locked' });
    assert.notEqual((await postJson('/api/v1/session', { email: learnerEmail, password })).status, 200, 'a locked account cannot sign in');
    assert.deepEqual(await (await send('POST', `/api/v1/admin/users/${learnerId}/actions`, { action: 'unlock', reason: 'e2e' })).json(), { outcome: 'unlocked' });
    assert.equal((await postJson('/api/v1/session', { email: learnerEmail, password })).status, 200);
    assert.equal((await send('POST', `/api/v1/admin/users/${adminId}/actions`, { action: 'lock', reason: 'e2e' })).status, 409, 'not the admin\'s own account');

    // a setting with its range, and a quota the API process's quota port reads at once
    assert.equal((await send('PUT', '/api/v1/admin/settings/candidate_retention_days', { value: 20 })).status, 422);
    const changed = await send('PUT', '/api/v1/admin/settings/candidate_retention_days', { value: 90 });
    assert.equal((await changed.json()).value, 90);
    assert.equal(py('print(json.dumps(app.state.ports.settings.get("candidate_retention_days")))'), 90);
    assert.equal((await send('PUT', '/api/v1/admin/quotas', { scope: 'user', scope_id: learnerId, max_instances: 3 })).status, 200);
    assert.equal(py(`print(json.dumps(app.state.ports.quota.max_instances("${learnerId}")))`), 3, 'the lab reads the new quota');
    assert.equal((await send('DELETE', `/api/v1/admin/quotas?scope=user&scope_id=${learnerId}`)).status, 204);
    assert.equal(py(`print(json.dumps(app.state.ports.quota.max_instances("${learnerId}")))`), 1);
    assert.equal((await (await send('DELETE', '/api/v1/admin/settings/candidate_retention_days')).json()).value, 180);

    // capacity and the scheduler's runs
    const capacity = await (await get('/api/v1/admin/capacity')).json();
    assert.deepEqual(Object.keys(capacity).sort(), ['failures', 'instances', 'memory', 'queue']);
    const jobs = await (await get('/api/v1/admin/jobs')).json();
    assert.ok(jobs.items.some((j) => j.name === 'log_purge' && j.last_status === 'succeeded'), 'the admin sees the last run');

    // every change is in the audit log, under pseudonyms
    for (const action of ['org.approved', 'account.suspended', 'admin.setting_changed', 'admin.quota_changed']) {
      assert.ok(Number(psql(`SELECT count(*) FROM audit_log WHERE action = '${action}'`)) >= 1, action);
    }
    assert.equal(psql(`SELECT count(*) FROM audit_log WHERE actor = '${adminId}' OR subject = '${learnerId}'`), '0', 'no raw user id in the log');
  }, { timeout: 300000 });

  // Story P-26: the dashboards' pages are served through the proxy with the per-request CSP, and the candidate's invite routes work through the web origin:
  // open with no session (no address in the answer), accept as the invited account, see it in "my invites", and another account sees none of it. Consent and
  // the attempt itself need a lab in the API process, which this stack does not have; they are tested in test_invite_api.py and test_invite_acceptance.py.
  test('dashboards (P-26): the pages are served with the CSP; open, accept and list an invite through the web origin; another account sees nothing', async () => {
    for (const path of ['/login', '/signup', '/verify-email', '/forgot-password', '/reset-password', '/account', '/dashboard', '/invite', '/assessment/a-AAAAAAAAAAAAAAAA']) {
      const page = await fetch(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(60000) });
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-security-policy') ?? '', /'nonce-[A-Za-z0-9+/=]+'/, `${path} has the nonce CSP`);
      assert.match(page.headers.get('cache-control') ?? '', /no-store/, path); // the page answer of the dev server, as in the P-07 page test
      assert.doesNotMatch(await page.text(), /VM\{/, `${path} carries no flag`);
    }

    const domain = `dash-${RUN}.example`;
    const ownerEmail = `owner@${domain}`;
    const candidate = `dash-taker-${RUN}@example.org`;
    const other = `dash-other-${RUN}@example.org`;
    const adminEmail = `e2e-dash-admin-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app', 'from vulnmart.ports.scope import Scope, Role',
        'c, a = app.state.companies, app.state.assessments', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const seeded = docker('exec', '-e', 'VULNMART_SEED_ADMIN_PASSWORD=a long admin password 123', NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Dash Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    py(`c.signup_recruiter(email="${ownerEmail}", password="${password}", display_name="E2E Dash Owner", company_name="Dash Ltd ${RUN}")`, 'print(json.dumps(True))');
    psql(`UPDATE users SET email_verified_at = now() WHERE email_ci = '${ownerEmail}'`);
    const ownerId = psql(`SELECT id FROM users WHERE email_ci = '${ownerEmail}'`);
    const orgId = psql(`SELECT id FROM organizations WHERE domain_claim = '${domain}'`);
    py(`c.approve(Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN})), "${orgId}")`, `t = c.terms_for("${ownerId}")`, `c.accept_terms("${ownerId}", t.version, t.sha256)`, 'print(json.dumps(True))');
    const owner = `Scope(user_id="${ownerId}", org_id="${orgId}", roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))`;
    py(`t = a.create_template(${owner}, {"title": "E2E dashboard", "challenge_keys": ["C01", "C03"], "retention_days": 60, "hints_mode": "on", "hint_cost_pct": 10})`,
      `i = a.create_invite(${owner}, t.template_id, "${candidate}")`, 'print(json.dumps(True))');
    let token = null;
    for (let i = 0; i < 60 && !token; i += 1) {
      const m = await mailFor(candidate, 'invited you to a security assessment', 1);
      token = (m && /invite\?token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})/.exec(m.Text)?.[1]) || null;
      if (!token) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(token, 'the invite mail arrived and links to /invite');

    // opening needs no session and never says the invited address
    const opened = await postJson('/api/v1/invites/open', { token });
    assert.equal(opened.status, 200);
    const summary = await opened.json();
    assert.equal(summary.state, 'opened');
    assert.equal(summary.title, 'E2E dashboard');
    assert.equal(summary.hints_mode, 'on');
    assert.equal(summary.hint_cost_pct, 10);
    assert.equal(summary.challenge_count, 2);
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(candidate.replace(/[.]/g, '\\.')));
    assert.equal((await postJson('/api/v1/invites/open', { token: 'not-a-token' })).status, 400);

    // both people register and confirm; the invited one accepts, the other cannot
    const signIn = async (email) => {
      const r = await postJson('/api/v1/session', { email, password });
      assert.equal(r.status, 200, email);
      const cookie = `__Host-vm_session=${/__Host-vm_session=([^;]+)/.exec(r.headers.getSetCookie()[0])[1]}`;
      return { cookie, csrf: (await r.json()).csrf_token };
    };
    for (const email of [candidate, other]) {
      assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Dash', age_declaration: true })).status, 202);
      psql(`UPDATE users SET email_verified_at = now() WHERE email_ci = '${email}'`);
    }
    const them = await signIn(other);
    const refused = await postJson('/api/v1/invites/accept', { token }, { cookie: them.cookie, 'x-csrf-token': them.csrf });
    assert.equal(refused.status, 409);
    assert.doesNotMatch(await refused.text(), new RegExp(candidate.replace(/[.]/g, '\\.')));
    const me = await signIn(candidate);
    assert.equal((await postJson('/api/v1/invites/accept', { token })).status, 401, 'accepting needs a session');
    const accepted = await postJson('/api/v1/invites/accept', { token }, { cookie: me.cookie, 'x-csrf-token': me.csrf });
    assert.equal(accepted.status, 200);
    const mine = await accepted.json();
    assert.match(mine.attempt_id, /^a-[A-Z2-7]{16}$/);

    const listed = await (await call('GET', '/api/v1/me/invites', { headers: { cookie: me.cookie } })).json();
    assert.deepEqual(listed.items.map((i) => [i.attempt_id, i.company_name, i.title]), [[mine.attempt_id, `Dash Ltd ${RUN}`, 'E2E dashboard']]);
    assert.deepEqual(await (await call('GET', '/api/v1/me/invites', { headers: { cookie: them.cookie } })).json(), { items: [] });
    assert.equal(psql(`SELECT state || ',' || (user_id = (SELECT id FROM users WHERE email_ci = '${candidate}')) FROM invites WHERE attempt_id = '${mine.attempt_id}'`), 'opened,true');
  }, { timeout: 300000 });

  // Story P-27: the recruiter's routes through the web origin on the real stack: sign-up over HTTP, approval by an admin, the terms, a template, an invite, the
  // candidate accepting it, and the recruiter's list showing it; a second company and a learner see none of it. The candidate's results are the lab's reviewer routes,
  // and this stack has no lab in the API process; they are tested by stream L.
  test('recruiter (P-27): sign up, approval, terms, template, invite, the candidate accepts, the list shows it; another company and a learner see nothing', async () => {
    for (const path of ['/company', '/company/candidates', '/company/candidates/a-AAAAAAAAAAAAAAAA']) {
      const page = await fetch(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(60000) });
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-security-policy') ?? '', /'nonce-[A-Za-z0-9+/=]+'/, `${path} has the nonce CSP`);
    }
    const domain = `rec-${RUN}.example`;
    const owner = `owner@${domain}`;
    const otherOwner = `owner@rec2-${RUN}.example`;
    const candidate = `rec-taker-${RUN}@example.org`;
    const learner = `rec-learner-${RUN}@example.org`;
    const adminEmail = `e2e-rec-admin-${RUN}@example.com`;
    const password = 'correct horse battery staple';
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const py = (...lines) => {
      const run = docker('exec', NAME('api'), 'python', '-c', ['import json', 'from vulnmart.main import app', 'from vulnmart.ports.scope import Scope, Role',
        'c = app.state.companies', ...lines].join('\n'));
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    };
    const signIn = async (email) => {
      const r = await postJson('/api/v1/session', { email, password });
      assert.equal(r.status, 200, email);
      const cookie = `__Host-vm_session=${/__Host-vm_session=([^;]+)/.exec(r.headers.getSetCookie()[0])[1]}`;
      return { cookie, csrf: (await r.json()).csrf_token };
    };
    const as = (who) => ({
      get: (path) => call('GET', path, { headers: { cookie: who.cookie } }),
      send: (method, path, body) => call(method, path, { body, headers: { cookie: who.cookie, 'x-csrf-token': who.csrf } }),
    });

    // two recruiters sign up over HTTP; the same answer twice
    for (const [email, company] of [[owner, `Rec Ltd ${RUN}`], [otherOwner, `Rec Two ${RUN}`]]) {
      const r = await postJson('/api/v1/recruiters', { email, password, display_name: 'E2E Recruiter', company_name: company });
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { status: 'accepted' });
      psql(`UPDATE users SET email_verified_at = now() WHERE email_ci = '${email}'`);
    }
    let rec = as(await signIn(owner));
    assert.equal((await (await rec.get('/api/v1/company')).json()).state, 'pending_approval');
    assert.equal((await rec.send('POST', '/api/v1/company/templates', { title: 'Too early', challenge_keys: ['C01'] })).status, 409);

    // an admin approves both companies
    const seeded = docker('exec', '-e', 'VULNMART_SEED_ADMIN_PASSWORD=a long admin password 123', NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Rec Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    for (const email of [owner, otherOwner]) {
      const orgId = psql(`SELECT o.id FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE u.email_ci = '${email}'`);
      py(`c.approve(Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN})), "${orgId}")`, 'print(json.dumps(True))');
    }

    // the owner reads and accepts the terms, makes a template and invites the candidate
    rec = as(await signIn(owner));
    const standing = await (await rec.get('/api/v1/company')).json();
    assert.deepEqual([standing.state, standing.role, standing.terms_accepted], ['active', 'owner', false]);
    const terms = await (await rec.get('/api/v1/company/terms')).json();
    assert.match(terms.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await rec.send('POST', '/api/v1/company/terms', { version: terms.version, sha256: terms.sha256 })).status, 204);
    const template = await rec.send('POST', '/api/v1/company/templates', { title: 'E2E recruiter', challenge_keys: ['C01', 'C03'], hints_mode: 'on', hint_cost_pct: 10 });
    assert.equal(template.status, 201);
    const tid = (await template.json()).template_id;
    const invited = await rec.send('POST', '/api/v1/company/invites', { template_id: tid, emails: [candidate] });
    assert.equal(invited.status, 201);
    const inviteId = (await invited.json()).created[0].invite_id;

    // the candidate gets the mail, signs up, accepts
    let token = null;
    for (let i = 0; i < 60 && !token; i += 1) {
      const m = await mailFor(candidate, 'invited you to a security assessment', 1);
      token = (m && /invite\?token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})/.exec(m.Text)?.[1]) || null;
      if (!token) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(token, 'the invite mail arrived');
    for (const email of [candidate, learner]) {
      assert.equal((await postJson('/api/v1/accounts', { email, password, display_name: 'E2E Person', age_declaration: true })).status, 202);
      psql(`UPDATE users SET email_verified_at = now() WHERE email_ci = '${email}'`);
    }
    const cand = await signIn(candidate);
    const accepted = await postJson('/api/v1/invites/accept', { token }, { cookie: cand.cookie, 'x-csrf-token': cand.csrf });
    assert.equal(accepted.status, 200);
    const attemptId = (await accepted.json()).attempt_id;

    // the recruiter's list shows the candidate's state and attempt
    const listed = (await (await rec.get('/api/v1/company/invites')).json()).items;
    assert.deepEqual(listed.map((i) => [i.invite_id, i.email, i.state, i.attempt_id, i.hints_mode, i.hint_cost_pct]), [[inviteId, candidate, 'opened', attemptId, 'on', 10]]);

    // another company and a learner see none of it
    const other = as(await signIn(otherOwner));
    assert.deepEqual(await (await other.get('/api/v1/company/invites')).json(), { items: [] });
    assert.deepEqual(await (await other.get('/api/v1/company/templates')).json(), { items: [] });
    assert.equal((await other.get(`/api/v1/company/templates/${tid}`)).status, 404);
    const lea = as(await signIn(learner));
    const refused = await lea.get('/api/v1/company/invites');
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).code, 'REQ-ROUTE-UNKNOWN');
  }, { timeout: 300000 });

  // Story P-29: the exports through the web origin on the real stack: a learner downloads their own data (a zip with their profile; the stack has no lab in the API
  // process, so the attempts part is empty and says why), a recruiter downloads one template's results, both answers are zips and both are in the audit log.
  test('exports (P-29): a learner downloads their own data, a recruiter one template\'s results; both are zips and both are audited', async () => {
    const password = 'correct horse battery staple';
    const learner = `exp-learner-${RUN}@example.org`;
    const owner = `owner@exp-${RUN}.example`;
    const adminEmail = `e2e-exp-admin-${RUN}@example.com`;
    const psql = (sql) => docker('exec', NAME('postgres'), 'psql', '-U', 'vulnmart', '-d', 'vulnmart', '-At', '-c', sql).stdout.trim();
    const signIn = async (email) => {
      const r = await postJson('/api/v1/session', { email, password });
      assert.equal(r.status, 200, email);
      const cookie = `__Host-vm_session=${/__Host-vm_session=([^;]+)/.exec(r.headers.getSetCookie()[0])[1]}`;
      return { cookie, csrf: (await r.json()).csrf_token };
    };
    // a zip's file names, read from its central directory (no unzip tool needed)
    const zipNames = (buf) => {
      const names = [];
      for (let i = 0; i + 46 <= buf.length; i += 1) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
          const len = buf.readUInt16LE(i + 28);
          names.push(buf.subarray(i + 46, i + 46 + len).toString('utf8'));
        }
      }
      return names.sort();
    };
    const auditCount = (action) => Number(psql(`SELECT count(*) FROM audit_log WHERE action = '${action}'`));

    // the learner
    assert.equal((await postJson('/api/v1/accounts', { email: learner, password, display_name: 'E2E Exporter', age_declaration: true })).status, 202);
    psql(`UPDATE users SET email_verified_at = now() WHERE email_ci = '${learner}'`);
    const me = await signIn(learner);
    assert.equal((await call('POST', '/api/v1/me/exports', { headers: { cookie: me.cookie } })).status, 403, 'the CSRF header is needed');
    const before = auditCount('export.own');
    const own = await call('POST', '/api/v1/me/exports', { headers: { cookie: me.cookie, 'x-csrf-token': me.csrf } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-type'), 'application/zip');
    assert.equal(own.headers.get('content-disposition'), 'attachment; filename="vulnmart-my-data.zip"');
    const ownZip = Buffer.from(await own.arrayBuffer());
    assert.deepEqual(zipNames(ownZip), ['README.txt', 'attempts.csv', 'attempts.json', 'consents.csv', 'consents.json', 'data_views.csv', 'data_views.json',
      'deletion_requests.json', 'profile.json']);
    assert.equal(auditCount('export.own'), before + 1, 'the export is in the audit log');

    // the recruiter: sign up, approval, terms, a template, the export
    assert.equal((await postJson('/api/v1/recruiters', { email: owner, password, display_name: 'E2E Exp Owner', company_name: `Exp Ltd ${RUN}` })).status, 202);
    psql(`UPDATE users SET email_verified_at = now() WHERE email_ci = '${owner}'`);
    const seeded = docker('exec', '-e', 'VULNMART_SEED_ADMIN_PASSWORD=a long admin password 123', NAME('api'), 'python', '-m', 'vulnmart.accounts.seed_admin', '--email', adminEmail, '--name', 'E2E Exp Admin');
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const adminId = psql(`SELECT id FROM users WHERE email_ci = '${adminEmail}'`);
    const orgId = psql(`SELECT o.id FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE u.email_ci = '${owner}'`);
    const approved = docker('exec', NAME('api'), 'python', '-c', ['from vulnmart.main import app', 'from vulnmart.ports.scope import Scope, Role',
      `app.state.companies.approve(Scope(user_id="${adminId}", roles=frozenset({Role.ADMIN})), "${orgId}")`].join('\n'));
    assert.equal(approved.status, 0, approved.stderr);
    const rec = await signIn(owner);
    const send = (method, path, body) => call(method, path, { body, headers: { cookie: rec.cookie, 'x-csrf-token': rec.csrf } });
    const terms = await (await call('GET', '/api/v1/company/terms', { headers: { cookie: rec.cookie } })).json();
    assert.equal((await send('POST', '/api/v1/company/terms', { version: terms.version, sha256: terms.sha256 })).status, 204);
    const tid = (await (await send('POST', '/api/v1/company/templates', { title: 'E2E export', challenge_keys: ['C01', 'C02'] })).json()).template_id;
    const beforeCompany = auditCount('export.company');
    const results = await send('POST', '/api/v1/company/exports', { template_id: tid });
    assert.equal(results.status, 200);
    assert.equal(results.headers.get('content-type'), 'application/zip');
    assert.deepEqual(zipNames(Buffer.from(await results.arrayBuffer())), ['README.txt', 'results.csv', 'results.json']);
    assert.equal(auditCount('export.company'), beforeCompany + 1);
    // the learner cannot export a company's results
    const refused = await call('POST', '/api/v1/company/exports', { body: { template_id: tid }, headers: { cookie: me.cookie, 'x-csrf-token': me.csrf } });
    assert.equal(refused.status, 404);
  }, { timeout: 300000 });

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
