// End-to-end test of the platform and web profiles (stories P-01, P-06 and P-07) against the REAL Docker engine.
// Needs Docker running and the host ports 3000, 8000 and 8025 free.
// Run: node --test "scripts/e2e/platform-stack.e2e.test.mjs"   (about 2 minutes on a warm machine)
// Node built-ins only. The stack is started once, then the tests inspect and disturb it, then `down` is checked last.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  const call = (method, path, { body, headers = {} } = {}) =>
    fetch(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
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
