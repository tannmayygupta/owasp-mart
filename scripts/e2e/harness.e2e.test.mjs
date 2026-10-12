// End-to-end tests of the lab harness (story L-06) against the REAL Docker engine (no mocks). Needs Docker running.
// Run: node --test scripts/e2e/harness.e2e.test.mjs      Node built-ins only. Every test leaves no container, network or volume behind.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHarness, harnessDown, leftovers } from '../harness.mjs';
import { resolveHarnessConfig } from '../check-instance-conformance.mjs';
import { freshValues, injectionDocument } from '../../contracts/mocks/stub-instance/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV = path.join(ROOT, 'scripts', 'dev.mjs');
const CONF = path.join(ROOT, 'scripts', 'check-instance-conformance.mjs');
const IMAGE = 'vulnmart-stub-instance:local';
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 400000, ...opts });
const dev = (...args) => sh(process.execPath, [DEV, ...args], { cwd: ROOT });
const empty = () => { const l = leftovers((c, a) => sh(c, a)); return JSON.stringify(l) === JSON.stringify({ containers: [], networks: [], volumes: [] }) ? '' : JSON.stringify(l); };
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); }).on('error', reject);
});
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); } return null; };

before(() => {
  const info = sh('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 });
  assert.ok(info.status === 0 && /^\d/.test(info.stdout.trim()), 'Docker is not running: start Docker Desktop, then run the e2e tests again.');
  harnessDown({ runner: (c, a) => sh(c, a), log: () => {}, err: () => {} });
  const b = sh('docker', ['build', '-q', '-f', 'contracts/mocks/stub-instance/Dockerfile', '-t', IMAGE, '.'], { cwd: ROOT });
  assert.equal(b.status, 0, b.stderr);
});
after(() => harnessDown({ runner: (c, a) => sh(c, a), log: () => {}, err: () => {} }));

test('help lists the harness commands', () => {
  const r = dev('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /harness \[--keep\]/);
  assert.match(r.stdout, /harness down/);
});

test('harness: a clean run prints PASS with every rule, exits 0 and leaves nothing behind', () => {
  const r = dev('harness');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const rule of ['live-healthz', 'live-readyz-after-marker', 'live-planted-flag', 'live-event-stored-and-verified', 'live-event-error-answers', 'live-no-secret-in-logs', 'injector-network-none']) {
    assert.match(r.stdout, new RegExp(`PASS  ${rule}`), rule);
  }
  assert.match(r.stdout, /conformance: PASS/);
  assert.match(r.stdout, /harness: PASS/);
  assert.equal(empty(), '', 'nothing may remain after the run');
});

test('harness --keep leaves a ready instance on 127.0.0.1; harness down then removes every container, network and volume', async () => {
  const r = dev('harness', '--keep');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const port = Number(r.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//)[1]);
  assert.equal((await get(port, '/readyz')).status, 200);
  assert.equal((await get(port, '/healthz')).status, 200);
  const v = JSON.parse((await get(port, '/version')).text);
  assert.ok(v.build_id);
  const now = leftovers((c, a) => sh(c, a));
  assert.equal(now.containers.length, 7);
  assert.equal(now.volumes.length, 4);
  const published = sh('docker', ['ps', '--filter', 'label=com.docker.compose.project=vulnmart-harness', '--format', '{{.Ports}}']).stdout;
  assert.ok(!/0\.0\.0\.0|\[::\]/.test(published), `a port is published beyond loopback: ${published}`);
  const down = dev('harness', 'down');
  assert.equal(down.status, 0, down.stderr);
  assert.equal(empty(), '');
  assert.equal(dev('harness', 'down').status, 0, 'down with nothing running still succeeds');
});

test('a bad injection document fails the run at the injector (exit 10), the instance containers never start, nothing remains', async () => {
  const errs = [];
  const logs = [];
  const code = await runHarness({ breakInjector: 'bad-document', runner: (c, a, o) => sh(c, a, o), err: (m) => errs.push(m), log: (m) => logs.push(m) });
  assert.equal(code, 1);
  assert.ok(errs.some((e) => e.startsWith('FAIL step injector') && e.includes('exited 10 (bad document)')), errs.join('\n'));
  assert.ok(!logs.some((l) => l.includes('step start instance')));
  assert.equal(empty(), '');
});

test('contract drift: the resolved harness config passes, and each deliberately broken copy fails with the rule name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-drift-'));
  try {
    const good = resolveHarnessConfig();
    const run = (name, fn, rule) => {
      const c = JSON.parse(JSON.stringify(good));
      fn(c);
      const f = path.join(dir, `${name}.json`);
      fs.writeFileSync(f, JSON.stringify(c));
      const r = sh(process.execPath, [CONF, '--config', f]);
      assert.equal(r.status, 1, `${name} must fail`);
      assert.match(r.stderr, new RegExp(`FAIL  ${rule}`), `${name}: ${r.stderr}`);
    };
    const f0 = path.join(dir, 'good.json');
    fs.writeFileSync(f0, JSON.stringify(good));
    const ok = sh(process.execPath, [CONF, '--config', f0]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    run('bind-mount', (c) => c.services.shop.volumes.push({ type: 'bind', source: '/etc', target: '/data' }), 'no-bind-mounts');
    run('writable-root', (c) => { c.services.shop.read_only = false; }, 'read-only-root');
    run('extra-capability', (c) => { c.services.sidecar.cap_add = ['NET_ADMIN']; }, 'cap-drop-all');
    run('wide-port', (c) => { c.services.edge.ports[0].host_ip = '0.0.0.0'; }, 'ports-loopback-only');
    run('injector-network', (c) => { delete c.services.injector.network_mode; c.services.injector.networks = { inst: null }; }, 'injector-network-none');
    run('key-in-env', (c) => { c.services.sidecar.environment = { VM_EVENT_KEY: 'x' }; }, 'env-allowlist-and-no-secrets');
    run('no-start-order', (c) => { delete c.services.shop.depends_on; }, 'start-order-injector-first');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the shop and the injector as real hardened containers, one at a time ----
const hardened = ['--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '128'];
const RUN_VM = ['--tmpfs', '/run/vm:rw,noexec,nosuid,size=16m,uid=65532,gid=65532,mode=0750'];
const TMP = ['--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,uid=65532,gid=65532,mode=1777', '--tmpfs', '/data:rw,noexec,nosuid,size=16m,uid=65532,gid=65532,mode=0700'];

test('shop: before the marker /healthz is 200 and /readyz is 503; marker without an open database is 503; ready only after both', async () => {
  const name = 'vm-e2e-shop';
  sh('docker', ['rm', '-f', name]);
  const up = sh('docker', ['run', '-d', '--name', name, ...hardened, ...RUN_VM, ...TMP, '-e', 'PORT=3000', '-p', '127.0.0.1::3000', IMAGE, 'shop']);
  assert.equal(up.status, 0, up.stderr);
  try {
    const port = Number(sh('docker', ['port', name, '3000/tcp']).stdout.match(/127\.0\.0\.1:(\d+)/)[1]);
    assert.ok(await waitFor(async () => { try { return (await get(port, '/healthz')).status === 200; } catch { return false; } }), 'healthz');
    assert.equal((await get(port, '/readyz')).status, 503, 'no marker');
    assert.equal(sh('docker', ['exec', name, 'sh', '-c', 'touch /run/vm/injected']).status, 0);
    assert.equal((await get(port, '/readyz')).status, 503, 'marker but no database');
    assert.equal(sh('docker', ['exec', name, 'sh', '-c', 'echo "{}" > /run/vm/snapshot.db']).status, 0);
    assert.equal((await get(port, '/readyz')).status, 200, 'marker and database');
  } finally { sh('docker', ['rm', '-f', name]); }
});

function injectorRun(doc, { mounts = [], env = [] } = {}) {
  return sh('docker', ['run', '--rm', '-i', '--network', 'none', ...hardened, ...TMP, ...mounts, ...env, IMAGE, 'inject'], { input: typeof doc === 'string' ? doc : JSON.stringify(doc) });
}
const PLACEMENT = ['--tmpfs', '/run/placement/import:rw,noexec,nosuid,size=2m,uid=65532,gid=65532,mode=0750', '--tmpfs', '/run/placement/mock:rw,noexec,nosuid,size=2m,uid=65532,gid=65532,mode=0750'];

test('injector: exit 0 with the marker last; exit 10, 11, 12 and 13 for each failure; nothing from the document is printed', () => {
  const v = freshValues();
  const secrets = [v.seed, ...v.flags.map((f) => f.flag)];
  const quiet = (r) => { for (const s of secrets) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), 'the document leaked into the output'); };
  const ok = injectorRun(injectionDocument(v), { mounts: [...RUN_VM, ...PLACEMENT] });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout.trim(), 'inject: done');
  quiet(ok);
  const bad = injectorRun('{"not":"a document"}', { mounts: [...RUN_VM, ...PLACEMENT] });
  assert.equal(bad.status, 10);
  assert.equal(bad.stdout.trim(), 'inject: exit 10 (bad document)');
  const notJson = injectorRun('not json at all', { mounts: [...RUN_VM, ...PLACEMENT] });
  assert.equal(notJson.status, 10);
  const noSnapshot = injectorRun(injectionDocument(v), { mounts: [...PLACEMENT] }); // no /run/vm on a read-only root: the snapshot cannot be written
  assert.equal(noSnapshot.status, 11);
  quiet(noSnapshot);
  const noPlacement = injectorRun(injectionDocument(v), { mounts: [...RUN_VM] });
  assert.equal(noPlacement.status, 12);
  quiet(noPlacement);
  const noMarker = injectorRun(injectionDocument(v), { mounts: [...RUN_VM, ...PLACEMENT], env: ['-e', 'VM_FLAGS_PATH=/nowhere/flags.json'] });
  assert.equal(noMarker.status, 13);
  quiet(noMarker);
});

test('injector network: a container with network none cannot open any connection', () => {
  const r = sh('docker', ['run', '--rm', '--network', 'none', ...hardened, '--entrypoint', 'node', IMAGE, '-e', "require('net').connect(80,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(7))"]);
  assert.equal(r.status, 7, 'a connection must be impossible');
});
