// Tests of scripts/isolation-probe.mjs (story 4.1). The unit tests use a stub Docker runner and need no daemon; one real run is skipped without a daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runProbe, evaluate, buildTargets, main, cliDocker, PROBE_LABEL, validSubnet, abort } from './isolation-probe.mjs';
import { checkInspect } from './check-instance-conformance.mjs';

const GOOD_PROBE = (net) => ({
  Name: '/p', Config: { User: '65532:65532', Env: ['PATH=/usr/bin'] },
  HostConfig: { ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges:true'], CapDrop: ['ALL'], Privileged: false, PortBindings: {}, NetworkMode: net, PidsLimit: 32, Memory: 67108864 },
  Mounts: [], NetworkSettings: { Networks: { [net]: {} } },
});

// A stub Docker: `answer(targets)` returns the probe answers; `profile(info)` may change the inspect of the probe container.
function stubDocker({ answer, profile = (x) => x, daemon = true, leftovers = 0, listenerUp = true, execCode = 0, sameSubnet = false, raw } = {}) {
  const calls = []; let objects = leftovers; let netA = '';
  const fn = (args) => {
    calls.push(args);
    const [a, b] = args;
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (a === 'version') return daemon ? ok('29.0.0') : { code: 1, stdout: '', stderr: 'cannot connect' };
    if (a === 'image') return ok();
    if (a === 'ps') return ok(objects > 0 ? 'abc\n' : '');
    if (a === 'rm') { objects = 0; return ok(); }
    if (a === 'network' && b === 'ls') return ok('');
    if (a === 'network' && b === 'rm') return ok();
    if (a === 'network' && b === 'create') { if (!netA) netA = args.at(-1); return ok(); }
    if (a === 'run') { objects++; return ok('id'); }
    if (a === 'network' && b === 'inspect') return ok(JSON.stringify([args[2] === 'bridge' ? { IPAM: { Config: [{ Gateway: '172.17.0.1' }] } } : { Internal: true, IPAM: { Config: [{ Subnet: sameSubnet || !args[2].endsWith('-b') ? '172.30.0.0/24' : '172.31.0.0/24', Gateway: '172.30.0.1' }] } }]));
    if (a === 'inspect') {
      if (args[1].endsWith('-peer')) return ok(JSON.stringify([{ NetworkSettings: { Networks: { [args[1].replace('-peer', '-b')]: { IPAddress: '172.31.0.2' } } } }]));
      return ok(JSON.stringify([profile(GOOD_PROBE(netA))]));
    }
    if (a === 'exec') {
      if (args[2] === 'node' && args[4]?.includes("127.0.0.1")) return ok(listenerUp ? 'up' : 'down');
      const out = raw !== undefined ? raw : JSON.stringify(answer(JSON.parse(args[5])));
      return { code: execCode, stdout: out, stderr: '' };
    }
    return ok();
  };
  fn.calls = calls;
  return fn;
}
const allBlocked = (ts) => ts.map((t) => ({ name: t.name, state: t.control ? 'open' : 'timeout' }));

test('buildTargets covers gateway, host names, docker0, peer, metadata, public 443 and 53, three LAN addresses and platform names', () => {
  const names = buildTargets({ gateway: 'g', docker0: 'd', peerIp: 'p' }).map((t) => t.name).join(' ');
  for (const part of ['network-gateway', 'host.docker.internal', 'docker0-address', 'peer-instance-network', '169.254.169.254', 'public-address:443', 'public-address:53', 'lan-10.0.0.1', 'lan-192.168.1.1', 'platform-name']) assert.ok(names.includes(part), part);
  assert.equal(buildTargets({ gateway: 'g', docker0: 'd', peerIp: 'p' }).filter((t) => t.name.startsWith('lan-')).length, 3);
  assert.ok(names.includes('peer-instance-network:443') && names.includes('platform-ingest-port:9444'), 'audit blocker B4: a peer network on 443 and the platform event port are forbidden targets');
});

test('isolated network: every target blocked, control reached, exit 0, labelled objects used and removed', () => {
  const d = stubDocker({ answer: allBlocked });
  const { exitCode, report } = runProbe({ docker: d, image: 'img', nonce: 't1' });
  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(report.ok, true);
  assert.equal(report.control, 'open');
  assert.ok(report.targets.every((t) => !t.open));
  assert.ok(d.calls.some((c) => c[0] === 'network' && c[1] === 'create' && c.includes('--internal') && c.includes(PROBE_LABEL)));
  const run = d.calls.find((c) => c[0] === 'run');
  for (const f of ['--read-only', '--cap-drop', 'no-new-privileges:true', '--pids-limit', '--memory']) assert.ok(run.includes(f), f);
  assert.ok(!run.includes('--privileged') && !run.includes('-v') && !run.includes('--network=host'));
});

test('open target: the report marks it open and the exit code is 1', () => {
  const d = stubDocker({ answer: (ts) => ts.map((t) => ({ name: t.name, state: t.control || t.name.startsWith('metadata') ? 'open' : 'refused' })) });
  const { exitCode, report } = runProbe({ docker: d, image: 'img', nonce: 't2' });
  assert.equal(exitCode, 1);
  assert.ok(report.problems.some((p) => p.includes('metadata-169.254.169.254:80')));
  const out = []; const code = main(['--image', 'img'], { log: (x) => out.push(x), err: (x) => out.push(x), docker: stubDocker({ answer: (ts) => ts.map((t) => ({ name: t.name, state: 'open' })) }) });
  assert.equal(code, 1);
  assert.ok(out.join('\n').includes('open: network-gateway'));
});

test('control unreachable: exit 1 and "control not reached"', () => {
  const d = stubDocker({ answer: (ts) => ts.map((t) => ({ name: t.name, state: 'timeout' })) });
  const { exitCode, report } = runProbe({ docker: d, image: 'img', nonce: 't3' });
  assert.equal(exitCode, 1);
  assert.ok(report.problems.some((p) => p.includes('control not reached')));
});

test('leftovers: an earlier labelled object is removed first; at the end nothing remains', () => {
  const d = stubDocker({ answer: allBlocked, leftovers: 2 });
  const { exitCode, report } = runProbe({ docker: d, image: 'img', nonce: 't4' });
  assert.equal(exitCode, 0);
  assert.equal(report.leftovers, 0);
  const firstRm = d.calls.findIndex((c) => c[0] === 'rm');
  const firstRun = d.calls.findIndex((c) => c[0] === 'run');
  assert.ok(firstRm >= 0 && firstRm < firstRun);
});

test('an error in the middle still cleans up', () => {
  const d = stubDocker({ answer: () => { throw new Error('boom'); } });
  const { exitCode } = runProbe({ docker: d, image: 'img', nonce: 't5' });
  assert.equal(exitCode, 1);
  assert.ok(d.calls.filter((c) => c[0] === 'rm').length >= 1);
});

test('a listener that did not start fails the run (a peer that never listened would prove nothing)', () => {
  const { exitCode, report } = runProbe({ docker: stubDocker({ answer: allBlocked, listenerUp: false }), image: 'img', nonce: 't6' });
  assert.equal(exitCode, 1);
  assert.match(report.error, /did not start/);
});

test('Docker missing: exit 2 with a plain message', () => {
  const err = [];
  assert.equal(main([], { log: () => {}, err: (x) => err.push(x), docker: stubDocker({ daemon: false }) }), 2);
  assert.match(err.join(''), /Docker is not available/);
});

test('profile check: a probe container that differs from the profile fails the run', () => {
  for (const [what, fn] of [['user', (i) => { i.Config.User = 'root'; }], ['read-only', (i) => { i.HostConfig.ReadonlyRootfs = false; }], ['cap', (i) => { i.HostConfig.CapDrop = []; }],
    ['nnp', (i) => { i.HostConfig.SecurityOpt = []; }], ['mount', (i) => { i.Mounts = [{ Type: 'volume' }]; }], ['privileged', (i) => { i.HostConfig.Privileged = true; }]]) {
    const { exitCode, report } = runProbe({ docker: stubDocker({ answer: allBlocked, profile: (i) => { fn(i); return i; } }), image: 'img', nonce: 't7' });
    assert.equal(exitCode, 1, what);
    assert.ok(report.problems.some((p) => p.startsWith('profile:')), what);
  }
});

test('evaluate: only a completed connect is open', () => {
  const ts = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
  const v = evaluate(ts, [{ name: 'a', state: 'refused' }, { name: 'b', state: 'unreachable' }, { name: 'c', state: 'name-not-found' }, { name: 'd', state: 'timeout' }, { name: 'control-sidecar-alias', state: 'open' }]);
  assert.equal(v.ok, true);
  assert.equal(v.rows.find((r) => r.name === 'd').state, 'timeout');
});

test('conformance live rules: seccomp unconfined and a mounted socket fail and name the container', () => {
  const c = GOOD_PROBE('x'); c.Name = '/vulnmart-harness-shop';
  assert.deepEqual(checkInspect([c]).filter((r) => !r.ok).map((r) => r.rule), []);
  const u = GOOD_PROBE('x'); u.Name = '/shop-u'; u.HostConfig.SecurityOpt.push('seccomp=unconfined');
  const rs = checkInspect([u]).find((r) => r.rule === 'seccomp-not-unconfined');
  assert.equal(rs.ok, false); assert.match(rs.detail, /shop-u/);
  const s = GOOD_PROBE('x'); s.Name = '/shop-s'; s.Mounts = [{ Type: 'npipe', Source: '\\\\.\\pipe\\docker_engine', Destination: '\\\\.\\pipe\\docker_engine' }];
  const rd = checkInspect([s]).find((r) => r.rule === 'no-docker-socket');
  assert.equal(rd.ok, false); assert.match(rd.detail, /shop-s/);
  const h = GOOD_PROBE('x'); h.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'];
  assert.equal(checkInspect([h]).find((r) => r.rule === 'no-docker-socket').ok, false);
});

const hasDaemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
test('real Docker: the probe passes on a real internal network and leaves nothing behind', { skip: !hasDaemon && 'no Docker daemon', timeout: 240000 }, () => {
  const { exitCode, report } = runProbe({ docker: cliDocker, nonce: `ut${process.pid}` });
  if (process.platform === 'linux') {
    // A Linux host without the host rule of infra/hosts/vulnmart-egress.sh (a CI runner) answers on the bridge gateway, for example its
    // own sshd: that is the gap spike S-3 measures on VM-I, and the probe is right to report it. Everything else must still be blocked.
    assert.ok(exitCode === 0 || report.problems.every((p) => /^open: network-gateway:/.test(p)), JSON.stringify(report));
  } else {
    assert.equal(exitCode, 0, JSON.stringify(report)); // Docker Desktop: the gateway belongs to its VM, which refuses
  }
  assert.equal(report.control, 'open', JSON.stringify(report)); // the control must connect, or the probe proves nothing
  assert.equal(report.leftovers, 0);
  const left = cliDocker(['ps', '-aq', '--filter', `label=${PROBE_LABEL}`]).stdout.trim() + cliDocker(['network', 'ls', '-q', '--filter', `label=${PROBE_LABEL}`]).stdout.trim();
  assert.equal(left, '');
});

test('a missing answer, an error state or a truncated array fails the run and names the target', () => {
  const miss = runProbe({ docker: stubDocker({ answer: (ts) => allBlocked(ts).filter((a) => a.name !== 'metadata-169.254.169.254:80') }), image: 'img', nonce: 'm1' });
  assert.equal(miss.exitCode, 1);
  assert.match(miss.report.error ?? miss.report.problems.join(), /complete answer|metadata/);
  const err = runProbe({ docker: stubDocker({ answer: (ts) => allBlocked(ts).map((a) => (a.name === 'public-address:53' ? { ...a, state: 'error:EPERM' } : a)) }), image: 'img', nonce: 'm2' });
  assert.equal(err.exitCode, 1);
  assert.ok(err.report.problems.some((p) => p.includes('public-address:53') && p.includes('error:EPERM')));
  const trunc = runProbe({ docker: stubDocker({ answer: allBlocked, raw: '[{"name":"x","state":"time' }), image: 'img', nonce: 'm3' });
  assert.equal(trunc.exitCode, 1);
  // evaluate alone: a target with no answer is named
  const v = evaluate([{ name: 'a' }], [{ name: 'control-sidecar-alias', state: 'open' }]);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('a') && p.includes('no-answer')));
});

test('a non-zero exit code of the in-container program fails the run', () => {
  const { exitCode, report } = runProbe({ docker: stubDocker({ answer: allBlocked, execCode: 1 }), image: 'img', nonce: 'e1' });
  assert.equal(exitCode, 1);
  assert.match(report.error, /exit 1/);
});

test('the report holds the subnets and the host.docker.internal mapping; the probe gets --add-host; a peer on the same subnet fails', () => {
  const d = stubDocker({ answer: allBlocked });
  const { report } = runProbe({ docker: d, image: 'img', nonce: 's1' });
  assert.deepEqual(report.subnets, { probe: ['172.30.0.0/24'], peer: ['172.31.0.0/24'] });
  assert.match(report.host_docker_internal, /host-gateway/);
  const probeRun = d.calls.find((c) => c[0] === 'run' && c.includes('--add-host'));
  assert.ok(probeRun.includes('host.docker.internal:host-gateway'));
  const bad = runProbe({ docker: stubDocker({ answer: allBlocked, sameSubnet: true }), image: 'img', nonce: 's2' });
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.report.problems.some((p) => p.includes('same subnet')));
});

test('a signal during the run cleans up and exits 130', () => {
  const d = stubDocker({ answer: allBlocked });
  const wrapped = (args, o) => { const r = d(args, o); if (args[0] === 'run') return { ...r, signal: 'SIGINT' }; return r; };
  const { exitCode, report } = runProbe({ docker: wrapped, image: 'img', nonce: 'g1' });
  assert.equal(exitCode, 130);
  assert.equal(report.aborted, true);
  assert.ok(d.calls.filter((c) => c[0] === 'rm').length >= 1);
  abort.flag = false; // the signal left the module flag set: reset it so later tests start clean (the --help path of main returns before its own reset)
  assert.equal(main(['--help'], { log: () => {} }), 0);
});

test('--image and --timeout-ms are validated (exit 2, plain message)', () => {
  for (const argv of [['--image', '--privileged'], ['--image', 'a b'], ['--image', 'x;rm'], ['--timeout-ms', '5'], ['--timeout-ms', 'abc'], ['--timeout-ms', '99999']]) {
    const err = [];
    assert.equal(main(argv, { log: () => {}, err: (x) => err.push(x), docker: stubDocker({ answer: allBlocked }) }), 2, argv.join(' '));
    assert.match(err.join(''), /--image|--timeout-ms/);
  }
});

test('conformance: unconfined profiles, socket variants and parent directory binds fail; a benign container passes', () => {
  const rules = (mut) => { const c = GOOD_PROBE('x'); c.Name = '/svc'; mut(c); return checkInspect([c]).filter((r) => !r.ok).map((r) => r.rule); };
  assert.deepEqual(rules(() => {}), []);
  assert.ok(rules((c) => c.HostConfig.SecurityOpt.push('seccomp:unconfined')).includes('seccomp-not-unconfined'));
  for (const o of ['apparmor=unconfined', 'label=disable', 'systempaths=unconfined']) assert.ok(rules((c) => c.HostConfig.SecurityOpt.push(o)).includes('security-profiles-not-disabled'), o);
  assert.ok(rules((c) => { c.HostConfig.Binds = ['/run/containerd/containerd.sock:/x']; }).includes('no-docker-socket'));
  assert.ok(rules((c) => { c.Mounts = [{ Type: 'bind', Source: '/run/podman/podman.sock', Destination: '/s' }]; }).includes('no-docker-socket'));
  for (const p of ['/var/run', '/run', '/', '/var/lib/docker']) {
    assert.ok(rules((c) => { c.Mounts = [{ Type: 'bind', Source: p, Destination: '/h' }]; }).includes('no-docker-socket'), p);
    assert.ok(rules((c) => { c.HostConfig.Binds = [`${p}:/h:ro`]; }).includes('no-docker-socket'), `binds ${p}`);
  }
  assert.ok(rules((c) => { c.Mounts = [{ Type: 'npipe', Source: '\\\\.\\pipe\\x' }]; }).includes('no-docker-socket'));
  assert.deepEqual(rules((c) => { c.Mounts = [{ Type: 'volume', Name: 'vm-run', Source: '/var/lib/docker/volumes/vm-run/_data', Destination: '/run/vm' }]; }), []);
});

test('fixed subnets (S-3 variant): --subnet reaches docker network create, the report says custom, a bad value is refused', () => {
  const d = stubDocker({ answer: allBlocked });
  const { exitCode, report } = runProbe({ docker: d, image: 'img', nonce: 'c1', probeSubnet: '172.31.200.0/24', peerSubnet: '172.31.201.0/24' });
  assert.equal(exitCode, 0, JSON.stringify(report));
  const creates = d.calls.filter((c) => c[0] === 'network' && c[1] === 'create');
  assert.deepEqual(creates.map((c) => c[c.indexOf('--subnet') + 1]), ['172.31.200.0/24', '172.31.201.0/24']);
  assert.equal(report.subnets.custom, true);
  // default run: no --subnet and no "custom" key
  const plain = stubDocker({ answer: allBlocked });
  const r = runProbe({ docker: plain, image: 'img', nonce: 'c2' });
  assert.ok(plain.calls.filter((c) => c[0] === 'network' && c[1] === 'create').every((c) => !c.includes('--subnet')));
  assert.ok(!('custom' in r.report.subnets));
});

test('validSubnet accepts a network address and refuses everything else', () => {
  for (const ok of ['172.31.200.0/24', '10.99.0.0/16', '192.168.7.64/26']) assert.equal(validSubnet(ok), true, ok);
  for (const bad of ['172.31.200.5/24', '172.31.200.0/8', '172.31.200.0/30', '300.1.1.0/24', '172.31.200.0', '172.31.200.0/24; rm', '--subnet', '', 'a.b.c.d/24', '172.31.200.0/024x']) assert.equal(validSubnet(bad), false, bad);
});

test('--probe-subnet and --peer-subnet are validated and must differ (exit 2)', () => {
  for (const argv of [['--probe-subnet', '1.2.3.4/24'], ['--peer-subnet', 'nonsense'], ['--probe-subnet', '172.31.200.0/24', '--peer-subnet', '172.31.200.0/24']]) {
    const err = [];
    assert.equal(main(argv, { log: () => {}, err: (x) => err.push(x), docker: stubDocker({ answer: allBlocked }) }), 2, argv.join(' '));
    assert.match(err.join(''), /subnet/);
  }
});

test('--runtime (S-8): every probe container gets it, the report says which, a bad name is refused, the default has none', () => {
  const d = stubDocker({ answer: allBlocked });
  const { exitCode, report } = runProbe({ docker: d, image: 'img', nonce: 'r1', runtime: 'runsc' });
  assert.equal(exitCode, 0, JSON.stringify(report));
  const runs = d.calls.filter((c) => c[0] === 'run');
  assert.equal(runs.length, 3);
  for (const run of runs) assert.equal(run[run.indexOf('--runtime') + 1], 'runsc');
  assert.equal(report.runtime, 'runsc');
  const plain = stubDocker({ answer: allBlocked });
  const r = runProbe({ docker: plain, image: 'img', nonce: 'r2' });
  assert.ok(plain.calls.filter((c) => c[0] === 'run').every((c) => !c.includes('--runtime')));
  assert.ok(!('runtime' in r.report));
  for (const bad of ['RUNSC', 'runsc;rm', '-x', 'a', 'runsc --privileged', '../x']) {
    const err = [];
    assert.equal(main(['--runtime', bad], { log: () => {}, err: (e) => err.push(e), docker: stubDocker({ answer: allBlocked }) }), 2, bad);
    assert.match(err.join(''), /--runtime/);
  }
});