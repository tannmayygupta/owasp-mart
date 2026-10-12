import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkConfig, checkInspect, formatResults, main, ENV_ALLOWLIST, resolveHarnessConfig } from './check-instance-conformance.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-instance-conformance.mjs');
import { goodConfig as good, DOCKERFILE_OK } from './conformance-fixtures.mjs';
const failing = (config, dockerfile = DOCKERFILE_OK) => checkConfig(config, { dockerfile }).filter((r) => !r.ok).map((r) => r.rule);
const mutate = (fn) => { const c = good(); fn(c.services, c); return c; };

test('the planned harness shape passes every rule', () => {
  const r = checkConfig(good(), { dockerfile: DOCKERFILE_OK });
  assert.deepEqual(r.filter((x) => !x.ok), []);
  assert.ok(r.length >= 15);
  assert.match(formatResults(r).lines.at(-1), /^conformance: PASS \(\d+ rules\)$/);
});

const BROKEN = [
  ['a bind mount', (s) => s.shop.volumes.push({ type: 'bind', source: '/host/data', target: '/data' }), 'no-bind-mounts'],
  ['the docker socket', (s) => s.shop.volumes.push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }), 'no-bind-mounts'],
  ['a writable root filesystem', (s) => { s.sidecar.read_only = false; }, 'read-only-root'],
  ['an extra capability', (s) => { s.shop.cap_add = ['NET_ADMIN']; }, 'cap-drop-all'],
  ['no cap_drop', (s) => { delete s.shop.cap_drop; }, 'cap-drop-all'],
  ['a wide port', (s) => { s.edge.ports[0].host_ip = '0.0.0.0'; }, 'ports-loopback-only'],
  ['a port with no host ip', (s) => { delete s.edge.ports[0].host_ip; }, 'ports-loopback-only'],
  ['the injector on a network', (s) => { delete s.injector.network_mode; s.injector.networks = { inst: null }; }, 'injector-network-none'],
  ['the injector in bridge mode', (s) => { s.injector.network_mode = 'bridge'; }, 'injector-network-none'],
  ['a privileged container', (s) => { s.gate.privileged = true; }, 'not-privileged'],
  ['root as user', (s) => { s.shop.user = '0:0'; }, 'run-user-65532'],
  ['a user name', (s) => { s.shop.user = 'node'; }, 'run-user-65532'],
  ['privilege escalation allowed', (s) => { s.shop.security_opt = []; }, 'no-new-privileges'],
  ['a key in the environment', (s) => { s.sidecar.environment.VM_EVENT_KEY = 'x'; }, 'env-allowlist-and-no-secrets'],
  ['a flag-env name', (s) => { s.shop.environment.VM_FLAG_C05 = 'x'; }, 'env-allowlist-and-no-secrets'],
  ['a name outside the allowlist', (s) => { s.shop.environment.SOMETHING = 'x'; }, 'env-allowlist-and-no-secrets'],
  ['a flag-like value', (s) => { s.shop.environment.TZ = 'vm' + '{' + 'A'.repeat(24) + '}'; }, 'env-allowlist-and-no-secrets'],
  ['a flag in a command', (s) => { s.sidecar.command = ['sidecar', '--k', 'VM%7BAAAA']; }, 'env-allowlist-and-no-secrets'],
  ['tmpfs at a fifth place', (s) => { s.shop.tmpfs.push('/var/lib:rw,size=1m'); }, 'writable-places-memory-backed'],
  ['an anonymous volume', (s) => s.shop.volumes.push({ type: 'volume', target: '/x' }), 'writable-places-memory-backed'],
  ['a volume at the wrong target', (s) => { s.shop.volumes[1].target = '/run/elsewhere'; }, 'writable-places-memory-backed'],
  ['a mount target used twice', (s) => { s.shop.tmpfs.push('/tmp:rw,size=1m'); }, 'writable-places-memory-backed'],
  ['the sidecar mounting /run/vm', (s) => s.sidecar.volumes = [{ type: 'volume', source: 'vm-run', target: '/run/vm', read_only: true }], 'shared-volume-roles'],
  ['the shop writing /run/vm', (s) => { delete s.shop.volumes[0].read_only; }, 'shared-volume-roles'],
  ['the shop mounting a placement volume', (s) => s.shop.volumes.push({ type: 'volume', source: 'vm-placement-import', target: '/run/placement/import', read_only: true }), 'shared-volume-roles'],
  ['the injector read-only on /run/vm', (s) => { s.injector.volumes[0].read_only = true; }, 'shared-volume-roles'],
  ['no depends_on injector', (s) => { delete s.shop.depends_on; }, 'start-order-injector-first'],
  ['the wrong start condition', (s) => { s.sidecar.depends_on.injector.condition = 'service_started'; }, 'start-order-injector-first'],
  ['the injector waiting for another container', (s) => { s.injector.depends_on = { shop: { condition: 'service_started' } }; }, 'start-order-injector-first'],
  ['the shop on a network with outside access', (s, c) => { c.networks.inst.internal = false; }, 'no-outside-network'],
  ['a missing memory limit', (s) => { delete s.shop.mem_limit; }, 'resource-limits'],
  ['a missing pids limit', (s) => { delete s.shop.pids_limit; }, 'resource-limits'],
  ['a shop healthcheck that does not call /readyz', (s) => { s.shop.healthcheck.test = ['CMD', 'true']; }, 'shop-health-is-readyz'],
  ['a volume that is not memory-backed', (s, c) => { c.volumes['vm-run'].driver_opts = {}; }, 'named-volumes-memory-backed'],
  ['a volume with no size', (s, c) => { c.volumes['vm-run'].driver_opts.o = 'uid=65532'; }, 'named-volumes-memory-backed'],
  ['a missing volume', (s, c) => { delete c.volumes['vm-import']; }, 'named-volumes-memory-backed'],
  ['a fifth volume', (s, c) => { c.volumes['vm-extra'] = c.volumes['vm-run']; }, 'named-volumes-memory-backed'],
];
for (const [name, fn, rule] of BROKEN) {
  test(`drift: ${name} fails the rule ${rule}`, () => {
    const names = failing(mutate(fn));
    assert.ok(names.includes(rule), `expected ${rule}, got ${names.join(', ') || 'no failure'}`);
  });
}

test('drift: an unpinned base image fails base-image-pinned-by-digest', () => {
  assert.deepEqual(failing(good(), 'FROM node:24.21.0-alpine\n'), ['base-image-pinned-by-digest']);
  assert.deepEqual(failing(good(), ''), ['base-image-pinned-by-digest']);
});

test('the env allowlist is the 13 names of IF-6 section 2', () => {
  assert.equal(ENV_ALLOWLIST.length, 13);
  assert.ok(!ENV_ALLOWLIST.some((n) => /_(KEY|SECRET|TOKEN|PASSWORD)$|^VM_FLAG_|SEED/.test(n)));
});

test('formatResults names every failed rule in the last line', () => {
  const f = formatResults(checkConfig(mutate((s) => { s.shop.read_only = false; s.shop.cap_add = ['SYS_ADMIN']; }), { dockerfile: DOCKERFILE_OK }));
  assert.equal(f.ok, false);
  assert.match(f.lines.at(-1), /^conformance: FAIL \(2 rule\(s\): read-only-root, cap-drop-all\)$/);
  assert.ok(f.lines.some((l) => l.startsWith('FAIL  read-only-root: shop:')));
});

test('CLI: --config on a good file exits 0, on a broken copy exits 1 and names the rule on stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-conf-'));
  try {
    const ok = path.join(dir, 'good.json');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(ok, JSON.stringify(good()));
    fs.writeFileSync(bad, JSON.stringify(mutate((s) => { s.edge.ports[0].host_ip = '0.0.0.0'; })));
    const a = spawnSync(process.execPath, [SCRIPT, '--config', ok], { encoding: 'utf8' });
    assert.equal(a.status, 0, a.stdout + a.stderr);
    const b = spawnSync(process.execPath, [SCRIPT, '--config', bad], { encoding: 'utf8' });
    assert.equal(b.status, 1);
    assert.match(b.stderr, /FAIL  ports-loopback-only/);
    assert.match(b.stderr, /conformance: FAIL/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' }).status, 2);
    assert.equal(main(['--help'], { log: () => {}, err: () => {} }), 0);
    assert.equal(main(['--config', path.join(dir, 'missing.json')], { log: () => {}, err: () => {} }), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- docker inspect (live) ----
const container = (name, over = {}) => ({
  Name: `/${name}`, Config: { User: '65532:65532', Env: ['TZ=UTC', 'PATH=/usr/bin'] },
  HostConfig: { ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges:true'], CapDrop: ['ALL'], Privileged: false, PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18090' }] }, NetworkMode: 'x_inst' },
  Mounts: [{ Type: 'volume' }], NetworkSettings: { Networks: { x_inst: {} } }, ...over,
});
const failingLive = (cs) => checkInspect(cs).filter((r) => !r.ok).map((r) => r.rule);

test('live inspect: a conforming container set passes; each drift names its rule', () => {
  const inj = container('vulnmart-harness-injector', { HostConfig: { ...container('x').HostConfig, NetworkMode: 'none' }, NetworkSettings: { Networks: { none: {} } } });
  assert.deepEqual(failingLive([container('vulnmart-harness-shop'), inj]), []);
  const cases = {
    'live-run-user': (c) => { c.Config.User = ''; },
    'live-read-only-root': (c) => { c.HostConfig.ReadonlyRootfs = false; },
    'live-no-new-privileges': (c) => { c.HostConfig.SecurityOpt = []; },
    'live-cap-drop-all': (c) => { c.HostConfig.CapAdd = ['NET_RAW']; },
    'live-not-privileged': (c) => { c.HostConfig.Privileged = true; },
    'live-no-bind-mounts': (c) => { c.Mounts.push({ Type: 'bind' }); },
    'live-ports-loopback-only': (c) => { c.HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0'; },
    'live-no-secret-in-env': (c) => { c.Config.Env.push('VM_EVENT_KEY=x'); },
  };
  for (const [rule, fn] of Object.entries(cases)) {
    const c = container('vulnmart-harness-shop');
    fn(c);
    assert.ok(failingLive([c]).includes(rule), rule);
  }
  const networked = container('vulnmart-harness-injector');
  assert.ok(failingLive([networked]).includes('live-injector-no-network'));
});

// ---- services that escaped the rules when they were picked by label ----
const DRIFT2 = [
  ['an unlabelled service', (s) => { delete s.sidecar.labels; }, 'service-kind-label'],
  ['an unknown vm.kind', (s) => { s.sidecar.labels = { 'vm.kind': 'other' }; }, 'service-kind-label'],
  ['a helper name labelled as an instance role', (s) => { s.ingest.labels = { 'vm.kind': 'inst' }; }, 'service-kind-label'],
  ['an instance service labelled as a harness helper', (s) => { s.gate.labels = { 'vm.kind': 'harness' }; }, 'service-kind-label'],
  ['a service with no networks', (s) => { delete s.gate.networks; }, 'explicit-container-network'],
  ['network_mode host', (s) => { delete s.gate.networks; s.gate.network_mode = 'host'; }, 'explicit-container-network'],
  ['network_mode container:x', (s) => { s.gate.network_mode = 'container:shop'; }, 'explicit-container-network'],
  ['network_mode bridge', (s) => { s.shop.network_mode = 'bridge'; }, 'explicit-container-network'],
  ['an unlabelled service without depends_on the injector', (s) => { s.gate.labels = {}; delete s.gate.depends_on; }, 'service-kind-label'],
  ['an unlabelled service mounting /run/vm', (s) => { s.gate.labels = {}; s.gate.volumes = [{ type: 'volume', source: 'vm-run', target: '/run/vm' }]; }, 'shared-volume-roles'],
  ['a helper publishing a port', (s) => { s.ingest.ports = [{ mode: 'ingress', host_ip: '127.0.0.1', target: 8081, published: '18091', protocol: 'tcp' }]; }, 'harness-helpers-minimal'],
  ['a helper mounting a shared volume read-write', (s) => { s['volume-keeper'].volumes[0].read_only = false; }, 'harness-helpers-minimal'],
  ['a helper depending on an instance service', (s) => { s.ingest.depends_on = { shop: { condition: 'service_started' } }; }, 'harness-helpers-minimal'],
  ['a helper on a network with outside access', (s, c) => { s.ingest.networks = { front: null }; }, 'no-outside-network'],
  ['an unlisted service labelled harness', (s) => { s.sneaky = { ...s.gate, labels: { 'vm.kind': 'harness' } }; delete s.sneaky.depends_on; }, 'service-kind-label'],
  ['an extra service with no depends_on', (s) => { s.extra = { ...s.gate, labels: { 'vm.kind': 'inst' } }; delete s.extra.depends_on; }, 'start-order-injector-first'],
];
for (const [name, fn, rule] of DRIFT2) {
  test(`drift: ${name} fails the rule ${rule}`, () => {
    const names = failing(mutate(fn));
    assert.ok(names.includes(rule), `expected ${rule}, got ${names.join(', ') || 'no failure'}`);
  });
}

test('docker missing: a clear "docker not found" message, not a crash on a null stderr', () => {
  const saved = process.env.PATH;
  const savedExt = process.env.Path;
  process.env.PATH = ''; process.env.Path = '';
  try { assert.throws(() => resolveHarnessConfig(), /docker not found/); } finally { process.env.PATH = saved; if (savedExt !== undefined) process.env.Path = savedExt; }
});
test('the helper allowlist is frozen and names exactly the two helpers', async () => {
  const { HARNESS_HELPERS } = await import('./check-instance-conformance.mjs');
  assert.deepEqual([...HARNESS_HELPERS], ['ingest', 'volume-keeper']);
  assert.ok(Object.isFrozen(HARNESS_HELPERS));
  assert.throws(() => { 'use strict'; HARNESS_HELPERS.push('shop'); }, TypeError);
});
