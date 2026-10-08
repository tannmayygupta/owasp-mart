// End-to-end tests for `node scripts/dev.mjs` against the REAL Docker engine (no mocks).
// Needs Docker running. Run: node --test "scripts/e2e/*.test.mjs"   (or: pnpm run test:e2e)
// Node built-ins only. Every test cleans up the project's containers before and after.
import test, { before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV = path.join(ROOT, 'scripts', 'dev.mjs');
const COMPOSE = path.join(ROOT, 'infra', 'compose', 'compose.yaml');
const NAME = 'vulnmart-hello';
const PORT = 18080;
const IMAGE = readFileSync(COMPOSE, 'utf8').match(/^\s*image:\s*(\S+)/m)[1];

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 240000, ...opts });
const dev = (...args) => sh(process.execPath, [DEV, ...args], { cwd: ROOT });
const containers = () => sh('docker', ['ps', '-a', '--filter', `name=${NAME}`, '--format', '{{.Names}}']).stdout.trim();
const cleanup = () => sh('docker', ['rm', '-f', NAME]);
const holdPort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
const closeServer = (srv) => new Promise((resolve) => srv.close(resolve));

before(() => {
  const info = sh('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 });
  assert.ok(info.status === 0 && /^\d/.test(info.stdout.trim()), 'Docker is not running: start Docker Desktop, then run the e2e tests again.');
});
beforeEach(cleanup);
afterEach(cleanup);
after(cleanup);

test('help: prints the commands and exits 0', () => {
  const r = dev('--help');
  assert.equal(r.status, 0);
  for (const word of ['hello', 'up', 'down', 'doctor']) assert.match(r.stdout, new RegExp(word));
});

test('unknown command: exits 1 with a message on stderr', () => {
  const r = dev('nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command/);
});

test('doctor: every check passes against the real tools', () => {
  const r = dev('doctor');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.ok(lines.length >= 6);
  assert.ok(lines.every((l) => l.startsWith('PASS')), r.stdout);
  assert.match(r.stdout, /Docker engine\s+running/);
});

test('hello: starts a real container, answers hello, exits 0 and leaves nothing behind', async () => {
  const r = dev('hello');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'hello');
  assert.equal(containers(), '', 'the hello container must be removed');
  const srv = await holdPort(); // port 18080 is free again after the run
  await closeServer(srv);
});

test('hello: removes a stale container from an earlier run first', () => {
  const made = sh('docker', ['create', '--name', NAME, IMAGE, 'true']);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(containers(), NAME);
  const r = dev('hello');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'hello');
  assert.equal(containers(), '');
});

test('hello: a busy port exits 1, names the port and starts no container', async () => {
  const srv = await holdPort();
  try {
    const r = dev('hello');
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(String(PORT)));
    assert.equal(containers(), '');
  } finally {
    await closeServer(srv);
  }
});

test('up: a profile with no services yet exits 1 and starts nothing', () => {
  const r = dev('up', 'lab');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no services yet/);
  assert.equal(containers(), '');
});

test('up: an unknown profile is refused before Docker is used', () => {
  const r = dev('up', 'bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown profile: bogus/);
});

test('down: stops and removes a running hello container', () => {
  const up = sh('docker', ['compose', '-f', COMPOSE, '--profile', 'hello', 'up', '-d', '--wait', '--quiet-pull']);
  assert.equal(up.status, 0, up.stderr);
  assert.equal(containers(), NAME);
  const r = dev('down');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(containers(), '');
});

test('hello container hardening: non-root, read-only, no capabilities, loopback port, limits, no mounts', () => {
  const up = sh('docker', ['compose', '-f', COMPOSE, '--profile', 'hello', 'up', '-d', '--wait', '--quiet-pull']);
  assert.equal(up.status, 0, up.stderr);
  const raw = sh('docker', ['inspect', NAME]).stdout;
  const c = JSON.parse(raw)[0];
  assert.equal(c.Config.User, '65532:65532');
  assert.equal(c.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
  assert.ok(c.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(c.HostConfig.Privileged, false);
  assert.deepEqual(c.HostConfig.Binds ?? [], []);
  assert.equal(c.Mounts.filter((m) => m.Type === 'bind').length, 0);
  assert.deepEqual(c.HostConfig.PortBindings['8080/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(PORT) }]);
  assert.equal(c.HostConfig.Memory, 64 * 1024 * 1024);
  assert.equal(c.HostConfig.PidsLimit, 64);
  assert.equal(c.State.Health.Status, 'healthy');
});
