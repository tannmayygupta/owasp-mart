import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FILES, auditAll, auditDaemon, auditDockerInfo, auditImds, auditInspect, auditIptables, auditLabsChain, auditListeners, cidrContains, exitCodeOf,
  parseArgs, parseCidr, parseListeners, redactEvidence,
} from './vmi-audit.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vmi-audit');
const load = (dir) => Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readFileSync(path.join(FIX, dir, f), 'utf8')]));
const statuses = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.status]));

test('good fixtures: every line is PASS', () => {
  const rows = auditAll(load('good'));
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.filter((r) => r.status !== 'PASS'), []);
  assert.equal(exitCodeOf(rows), 0);
});

// bad folder -> the one check that must FAIL (all other lines stay PASS)
const BAD = {
  'bad-socket-mounted': 'container-hardening',
  'bad-privileged': 'container-hardening',
  'bad-no-capdrop': 'container-hardening',
  'bad-rule-missing': 'host-rule-docker-user',
  'bad-input-rule-not-first': 'host-rule-input',
  'bad-narrow-pools': 'daemon-pools',
  'bad-public-port': 'listening-ports',
  'bad-imds-optional': 'imds-v2-required',
  'bad-empty-info': 'docker-info',
  'bad-labs-chain-open': 'host-rule-labs-chain',
};
test('every bad fixture folder exists in the table and the table has no stale entry', () => {
  const dirs = readdirSync(FIX).filter((d) => d.startsWith('bad-')).sort();
  assert.deepEqual(dirs, Object.keys(BAD).sort());
});
for (const [dir, check] of Object.entries(BAD)) {
  test(`${dir}: exactly ${check} fails`, () => {
    const rows = auditAll(load(dir));
    const fails = rows.filter((r) => r.status === 'FAIL').map((r) => r.name);
    assert.deepEqual(fails, [check]);
    assert.equal(exitCodeOf(rows), 1);
  });
}

test('socket: names the container; proxy read-only passes; proxy read-write fails', () => {
  const mk = (name, rw) => JSON.stringify([{ Name: `/${name}`, HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] }, Config: { Labels: {} }, Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: rw }] }]);
  assert.equal(auditInspect(mk('vulnmart-docker-proxy', false))[0].status, 'PASS');
  assert.match(auditInspect(mk('vulnmart-docker-proxy', true))[0].detail, /read-write/);
  assert.match(auditInspect(mk('other', false))[0].detail, /other: mounts the Docker socket/);
});

test('inspect: host network, host pid, writable bind outside allow-list, sensitive read-only bind', () => {
  const base = { HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] }, Config: { Labels: {} } };
  const one = (extra) => auditInspect(JSON.stringify([{ Name: '/x', ...base, ...extra, HostConfig: { ...base.HostConfig, ...(extra.HostConfig ?? {}) } }]))[0];
  assert.match(one({ HostConfig: { NetworkMode: 'host' } }).detail, /host network/);
  assert.match(one({ HostConfig: { PidMode: 'host' } }).detail, /host PID/);
  assert.match(one({ Mounts: [{ Type: 'bind', Source: '/data/x', Destination: '/d', RW: true }] }).detail, /writable bind/);
  assert.equal(one({ Mounts: [{ Type: 'bind', Source: '/etc/vulnmart/keys', Destination: '/d', RW: true }] }).status, 'PASS');
  assert.equal(one({ Mounts: [{ Type: 'bind', Source: '/data/x', Destination: '/d', RW: false }] }).status, 'PASS');
  assert.match(one({ Mounts: [{ Type: 'bind', Source: '/etc', Destination: '/d', RW: false }] }).detail, /host path \/etc/);
});

test('inspect: zero containers is a valid empty list; garbled and empty text fail closed', () => {
  assert.equal(auditInspect('[]')[0].status, 'PASS');
  assert.match(auditInspect('')[0].detail, /unreadable: empty/);
  assert.match(auditInspect('not json')[0].detail, /unreadable/);
  assert.match(auditInspect('{}')[0].detail, /unreadable: not an array/);
  assert.match(auditInspect('[{"Name":"/a"}]')[0].detail, /no HostConfig/);
});

test('docker info: seccomp present passes, absent or unconfined fails, junk fails closed', () => {
  assert.equal(auditDockerInfo('{"SecurityOptions":["name=seccomp,profile=builtin"],"Driver":"overlay2"}')[0].status, 'PASS');
  assert.equal(auditDockerInfo('{"SecurityOptions":["name=seccomp,profile=unconfined"]}')[0].status, 'FAIL');
  assert.equal(auditDockerInfo('{"SecurityOptions":[]}')[0].status, 'FAIL');
  assert.match(auditDockerInfo('{"x":1}')[0].detail, /unreadable/);
  assert.match(auditDockerInfo('')[0].detail, /unreadable/);
  assert.match(auditDockerInfo('{"SecurityOptions":["name=seccomp","name=rootless","name=userns"]}')[0].detail, /rootless yes; userns yes/);
});

test('daemon: pool arithmetic, missing pools, bad pool, live-restore', () => {
  const d = (o) => JSON.stringify(o);
  const r1 = auditDaemon(d({ 'live-restore': true, 'default-address-pools': [{ base: '172.30.0.0/16', size: 24 }] }), 256);
  assert.match(r1[0].detail, /allow 256 networks, target 256/);
  assert.equal(r1[0].status, 'PASS');
  assert.equal(auditDaemon(d({ 'live-restore': true, 'default-address-pools': [{ base: '172.30.0.0/16', size: 24 }] }), 257)[0].status, 'FAIL');
  assert.equal(auditDaemon(d({ 'live-restore': true, 'default-address-pools': [{ base: '10.0.0.0/16', size: 24 }, { base: '10.5.0.0/16', size: 24 }] }), 500)[0].status, 'PASS');
  assert.match(auditDaemon(d({ 'live-restore': true }))[0].detail, /no default-address-pools/);
  assert.match(auditDaemon(d({ 'default-address-pools': [{ base: 'x', size: 24 }] }))[0].detail, /bad base or size/);
  assert.equal(auditDaemon(d({ 'default-address-pools': [{ base: '172.30.0.0/16', size: 24 }] }))[1].status, 'FAIL');
  assert.match(auditDaemon('')[0].detail, /unreadable/);
  assert.match(auditDaemon('[]')[0].detail, /unreadable/);
});

test('iptables: poolBases must be covered; garbled and empty fail closed', () => {
  const du = '-A DOCKER-USER -s 172.30.0.0/16 -j VULNMART-LABS\n';
  const inp = '-A INPUT -s 172.30.0.0/16 -m conntrack --ctstate NEW -j DROP\n';
  assert.deepEqual(auditIptables({ dockerUser: du, input: inp, poolBases: ['172.30.0.0/16'] }).map((r) => r.status), ['PASS', 'PASS']);
  assert.deepEqual(auditIptables({ dockerUser: du, input: inp, poolBases: ['172.31.0.0/16'] }).map((r) => r.status), ['FAIL', 'FAIL']);
  assert.deepEqual(auditIptables({ dockerUser: '', input: 'junk' }).map((r) => r.status), ['FAIL', 'FAIL']);
  assert.match(auditIptables({ dockerUser: '', input: inp })[0].detail, /unreadable/);
  assert.match(auditIptables({ dockerUser: du, input: '-A INPUT -j ACCEPT\n' })[1].detail, /no INPUT rule drops/);
});

test('listeners: ss formats, loopback, public ports, junk', () => {
  assert.deepEqual(parseListeners('LISTEN 0 128 [::1]:631 [::]:*\n'), [{ addr: '[::1]', port: 631 }]);
  assert.equal(parseListeners('garbage line'), null);
  assert.equal(auditListeners('LISTEN 0 128 *:22 *:*\nLISTEN 0 4096 [::]:443 [::]:*\n')[0].status, 'PASS');
  assert.equal(auditListeners('LISTEN 0 128 127.0.0.1:2375 0.0.0.0:*\n')[0].status, 'PASS');
  assert.match(auditListeners('LISTEN 0 4096 *:9443 *:*\n')[0].detail, /port 9443/);
  assert.equal(auditListeners('LISTEN 0 4096 [::]:2375 [::]:*\n')[0].status, 'FAIL');
  assert.match(auditListeners('')[0].detail, /unreadable: empty/);
  assert.match(auditListeners('nonsense')[0].detail, /unreadable/);
});

test('imds: required passes, optional fails, junk fails closed', () => {
  assert.equal(auditImds('["required"]')[0].status, 'PASS');
  assert.equal(auditImds('[["required"],["optional"]]')[0].status, 'FAIL');
  assert.match(auditImds('[]')[0].detail, /unreadable/);
  assert.match(auditImds('[1]')[0].detail, /unreadable/);
  assert.match(auditImds('')[0].detail, /unreadable/);
});

test('auditAll: missing required file is FAIL, missing imds is SKIP, skip map gives SKIP', () => {
  const inputs = { ...load('good'), ss: null, imds: null };
  const s = statuses(auditAll(inputs));
  assert.equal(s['listening-ports'], 'FAIL');
  assert.equal(s['imds-v2-required'], 'SKIP');
  const local = statuses(auditAll({ ...load('good'), dockerUser: null, input: null, ss: null }, { skip: { dockerUser: 'n/a', input: 'n/a', ss: 'n/a', imds: 'n/a' } }));
  assert.equal(local['host-rule-docker-user'], 'SKIP');
  assert.equal(local['host-rule-input'], 'SKIP');
  assert.equal(local['listening-ports'], 'SKIP');
  assert.equal(local['container-hardening'], 'PASS');
});

test('cidr helpers', () => {
  assert.deepEqual(parseCidr('172.30.0.0/16'), { start: 0xac1e0000, len: 16 });
  assert.equal(parseCidr('300.1.1.1/8'), null);
  assert.equal(cidrContains('172.30.0.0/16', '172.30.5.0/24'), true);
  assert.equal(cidrContains('172.30.0.0/24', '172.30.0.0/16'), false);
  assert.equal(cidrContains('172.30.0.0/16', '172.31.0.0/16'), false);
});

test('parseArgs and redaction', () => {
  assert.equal(parseArgs(['--local']).mode, 'local');
  assert.deepEqual(parseArgs(['--from', 'd', '--instances', '10', '--out', 'o']), { mode: 'from', from: 'd', instances: 10, out: 'o' });
  assert.match(parseArgs([]).error, /Usage/);
  assert.match(parseArgs(['--from']).error, /needs a folder/);
  assert.match(parseArgs(['--local', '--instances', 'x']).error, /positive integer/);
  assert.match(parseArgs(['--zzz']).error, /Unknown option/);
  const r = redactEvidence('host 203.0.113.9 account 123456789012 instance i-0abc1234def567890 key ' + 'AKIA' + 'ABCDEFGHIJKLMNOP');
  assert.ok(!/203\.0|123456789012|i-0abc|AKIA/.test(r));
});

test('labs chain (finding D1): the jump alone is not enough, the content must hold the drops and end in a DROP', () => {
  const good = readFileSync(path.join(FIX, 'good', FILES.labsChain), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout may hold CRLF
  assert.equal(auditLabsChain(good)[0].status, 'PASS');
  assert.equal(auditLabsChain('-N VULNMART-LABS\n')[0].status, 'FAIL');
  assert.equal(auditLabsChain('')[0].status, 'FAIL');
  assert.match(auditLabsChain(good.replace('-A VULNMART-LABS -j DROP\n', ''))[0].detail, /last rule is not a DROP/);
  assert.match(auditLabsChain(good.replace(/-A VULNMART-LABS -d 169\.254\.0\.0\/16 -j DROP\n/, ''))[0].detail, /metadata/);
  assert.match(auditLabsChain(good.replace(/-A VULNMART-LABS -d 10\.0\.0\.0\/16 -j DROP\n/, ''))[0].detail, /private network range/);
  assert.match(auditLabsChain(good.replace('-A VULNMART-LABS -d 169.254.0.0/16 -j DROP', '-A VULNMART-LABS -j RETURN\n-A VULNMART-LABS -d 169.254.0.0/16 -j DROP'))[0].detail, /blanket RETURN/);
  // audit blocker B4
  assert.match(auditLabsChain(good.replace('-A VULNMART-LABS -j DROP', '-A VULNMART-LABS -p tcp -m tcp --dport 443 -j ACCEPT\n-A VULNMART-LABS -j DROP'))[0].detail, /tcp 443 to every destination/);
  assert.match(auditLabsChain(good.replace(/-A VULNMART-LABS -d 172\.\d+\.0\.0\/16 -j DROP\n/g, ''))[0].detail, /between the container subnets/);
  assert.equal(auditLabsChain(good.replace('-A VULNMART-LABS -j DROP', '-A VULNMART-LABS -p tcp -d 10.0.0.9/32 --dport 443 -j ACCEPT\n-A VULNMART-LABS -j DROP'))[0].status, 'PASS', 'a 443 rule that names its destination is not the open one');
});

test('inspect (finding D2): added capabilities, host IPC, devices, unconfined profiles, a bind of a path below a sensitive one, a lookalike proxy name', () => {
  const base = { Name: '/x', HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] }, Config: { Labels: {} }, Mounts: [] };
  const one = (over) => auditInspect(JSON.stringify([{ ...base, ...over, HostConfig: { ...base.HostConfig, ...(over.HostConfig ?? {}) } }]))[0];
  assert.equal(one({}).status, 'PASS');
  assert.match(one({ HostConfig: { CapAdd: ['SYS_ADMIN'] } }).detail, /adds capabilities/);
  assert.equal(one({ Name: '/vulnmart-edge-caddy', HostConfig: { CapAdd: ['CAP_NET_BIND_SERVICE'] } }).status, 'PASS', 'the edge Caddy may bind 443');
  assert.match(one({ Name: '/vulnmart-edge-caddy', HostConfig: { CapAdd: ['CAP_NET_BIND_SERVICE', 'NET_RAW'] } }).detail, /NET_RAW/);
  assert.match(one({ Name: '/vulnmart-edge-gate', HostConfig: { CapAdd: ['CAP_NET_BIND_SERVICE'] } }).detail, /adds capabilities/, 'no other container may');
  assert.match(one({ HostConfig: { IpcMode: 'host' } }).detail, /host IPC/);
  assert.match(one({ HostConfig: { Devices: [{ PathOnHost: '/dev/sda' }] } }).detail, /host devices/);
  assert.match(one({ HostConfig: { SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] } }).detail, /unconfined/);
  assert.match(one({ Mounts: [{ Type: 'bind', Source: '/root/.ssh', Destination: '/k', RW: false }] }).detail, /host path \/root\/\.ssh/);
  assert.equal(one({ Mounts: [{ Type: 'bind', Source: '/opt/vulnmart/data', Destination: '/d', RW: false }] }).status, 'PASS');
  const sock = { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false };
  assert.equal(one({ Name: '/vulnmart-docker-proxy', Mounts: [sock] }).status, 'PASS');
  assert.equal(one({ Name: '/evil-docker-proxy-2', Mounts: [sock] }).status, 'FAIL');
});

test('listeners (finding D3): the orchestrator port is fine on a private address and a failure on every address', () => {
  const l = (addr) => `LISTEN 0 128 ${addr}:9443 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n`;
  assert.equal(auditListeners(l('10.0.2.10'))[0].status, 'PASS');
  assert.equal(auditListeners(l('0.0.0.0'))[0].status, 'FAIL');
  assert.equal(auditListeners(l('52.1.2.3'))[0].status, 'FAIL');
});
test('inspect (finding D11): only the edge gate may sit on an instance network besides the instance containers', () => {
  const c = (name, nets, labels = {}) => ({ Name: `/${name}`, HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] }, Config: { Labels: labels }, Mounts: [], NetworkSettings: { Networks: Object.fromEntries(nets.map((n) => [n, {}])) } });
  const run = (...list) => auditInspect(JSON.stringify(list))[0];
  assert.equal(run(c('vulnmart-edge-gate', ['edge-public', 'vm-i-aaaaaaaaaaaaaaaa-e1']), c('vm-i-aaaaaaaaaaaaaaaa-e1-shop', ['vm-i-aaaaaaaaaaaaaaaa-e1'], { 'vm.instance': 'x' })).status, 'PASS');
  const bad = run(c('vulnmart-orchestrator', ['labs-core', 'vm-i-aaaaaaaaaaaaaaaa-e1']));
  assert.equal(bad.status, 'FAIL');
  assert.match(bad.detail, /vulnmart-orchestrator: attached to an instance network/);
});
