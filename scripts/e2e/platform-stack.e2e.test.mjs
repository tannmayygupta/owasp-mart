// End-to-end test of the platform and web profiles (story P-01) against the REAL Docker engine.
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
const SERVICES = ['postgres', 'valkey', 'mailpit', 'api', 'web'];
const NAME = (s) => `vulnmart-${s}`;
const PORTS = [3000, 8000, 8025];

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 240000, ...opts });
const dev = (...args) => sh(process.execPath, [DEV, ...args], { cwd: ROOT, timeout: 420000 });
const docker = (...args) => sh('docker', args);
const composeDown = () =>
  docker('compose', '-f', COMPOSE, '--profile', 'platform', '--profile', 'web', 'down', '--remove-orphans', '--timeout', '2');
const present = () =>
  docker('ps', '-a', '--filter', 'name=vulnmart-', '--format', '{{.Names}}').stdout.split(/\r?\n/).filter((n) => SERVICES.map(NAME).includes(n));
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
      last = await getJson('http://127.0.0.1:3000/api/healthz');
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

  test('up: exits 0 and starts all five services healthy', () => {
    assert.equal(up.status, 0, up.stdout + up.stderr);
    for (const s of SERVICES) {
      assert.match(up.stdout, new RegExp(`Started:.*\\b${s}\\b`), `"Started:" line should name ${s}`);
      const state = inspect(s).State;
      assert.equal(state.Running, true, `${s} should be running`);
      assert.equal(state.Health?.Status, 'healthy', `${s} should be healthy`);
    }
  });

  test('healthy stack: /api/healthz through the web origin reports all three ok', async () => {
    const r = await waitForHealth(200);
    assert.deepEqual(r.body, { status: 'ok', postgres: 'ok', valkey: 'ok' });
  });

  test('the page is served and the API is also reachable directly on its own port', async () => {
    const page = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(60000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /VulnMart/);
    const direct = await getJson('http://127.0.0.1:8000/healthz');
    assert.equal(direct.status, 200);
    const mail = await fetch('http://127.0.0.1:8025/', { signal: AbortSignal.timeout(20000) });
    assert.equal(mail.status, 200);
  });

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

  test('Postgres down: 503, "postgres":"down", no error text; recovers when Postgres returns', async () => {
    assert.equal(docker('stop', '--time', '2', NAME('postgres')).status, 0);
    try {
      const r = await waitForHealth(503);
      assert.deepEqual(r.body, { status: 'degraded', postgres: 'down', valkey: 'ok' });
      assert.doesNotMatch(JSON.stringify(r.body), /password|vulnmart-dev|host|error|exception/i);
    } finally {
      assert.equal(docker('start', NAME('postgres')).status, 0);
    }
    const back = await waitForHealth(200);
    assert.deepEqual(back.body, { status: 'ok', postgres: 'ok', valkey: 'ok' });
  }, { timeout: 180000 });

  test('Valkey down: 503, "valkey":"down"; recovers when Valkey returns', async () => {
    assert.equal(docker('stop', '--time', '2', NAME('valkey')).status, 0);
    try {
      const r = await waitForHealth(503);
      assert.deepEqual(r.body, { status: 'degraded', postgres: 'ok', valkey: 'down' });
    } finally {
      assert.equal(docker('start', NAME('valkey')).status, 0);
    }
    const back = await waitForHealth(200);
    assert.deepEqual(back.body, { status: 'ok', postgres: 'ok', valkey: 'ok' });
  }, { timeout: 180000 });

  test('down: `node scripts/dev.mjs down` leaves no platform or web container behind', () => {
    const r = dev('down');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(present(), []);
  });
});
