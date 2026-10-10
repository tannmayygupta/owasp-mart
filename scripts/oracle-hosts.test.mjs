// Unit tests of the host checks with injected network and ssh runners (no network, no Oracle account).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHosts, redact, parseKeyValues, parseArgs, printChecks } from './oracle-hosts.mjs';
import { verifyHosts, remoteBaseline, BASELINE_FILES, localBaselineHashes } from './verify-hosts.mjs';
import { checkPrivateLink, unlistedPort, SERVER_PY, CLIENT_PY, SERVER_SECONDS, CLIENT_STEPS_PER_LINK, SECONDS_PER_STEP } from './private-link-check.mjs';
import { RULES_FILE } from './check-network-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
// Documentation-range and private addresses only: not real hosts.
const raw = { vm_p_public_ip: { value: '192.0.2.10' }, vm_p_private_ip: { value: '10.0.0.11' }, vm_i_public_ip: { value: '192.0.2.20' }, vm_i_private_ip: { value: '10.0.0.12' } };
const hosts = parseHosts(raw);

test('parseHosts reads terraform output -json and rejects bad input', () => {
  assert.equal(hosts['vm-p'].pub, '192.0.2.10');
  assert.equal(hosts['vm-i'].priv, '10.0.0.12');
  assert.throws(() => parseHosts({ ...raw, vm_i_public_ip: { value: 'not-an-ip' } }), /vm_i_public_ip/);
  assert.throws(() => parseHosts({}), /missing/);
});

test('redact replaces known addresses by label and any other address by <ip>', () => {
  const out = redact('192.0.2.10 10.0.0.12 and 8.8.4.4 version 9.9.0', hosts);
  assert.equal(out, '<vm-p-public> <vm-i-private> and <ip> version 9.9.0');
});

test('redact respects address boundaries and handles IPv6', () => {
  const h = parseHosts({ vm_p_public_ip: '192.0.2.1', vm_p_private_ip: '10.0.0.1', vm_i_public_ip: '192.0.2.20', vm_i_private_ip: '10.0.0.12' });
  // 10.0.0.1 is a prefix of 10.0.0.12 and of 10.0.0.123: only the whole address is replaced; the longer ones are redacted too.
  assert.equal(redact('10.0.0.1 10.0.0.12 10.0.0.123 192.0.2.1 192.0.2.10', h), '<vm-p-private> <vm-i-private> <ip> <vm-p-public> <ip>');
  assert.equal(redact('host 2001:db8::1 and fe80::1ff:fe23:4567:890a and 2001:db8:0:0:0:0:0:2 at 12:34:56', h), 'host <ip6> and <ip6> and <ip6> at 12:34:56');
  assert.equal(redact('(10.0.0.1)', h), '(<vm-p-private>)');
});

test('parseKeyValues and parseArgs', () => {
  assert.deepEqual(parseKeyValues('a=1\nnoise\nb_c=x y'), { a: '1', b_c: 'x y' });
  assert.deepEqual(parseArgs(['--identity', 'k', '--require-listener', '--user=u']), { _: [], identity: 'k', 'require-listener': true, user: 'u' });
});

test('parseArgs: an option that needs a value is a usage error without one; --opt=a=b splits at the first =', () => {
  const values = ['evidence', 'hosts', 'identity'];
  assert.throws(() => parseArgs(['--evidence'], { values }), /--evidence needs a value/);
  assert.throws(() => parseArgs(['--hosts', '--identity', 'k'], { values }), /--hosts needs a value/);
  assert.throws(() => parseArgs(['--evidence='], { values }), /--evidence needs a value/);
  assert.equal(parseArgs(['--evidence=a=b'], { values }).evidence, 'a=b');
  assert.equal(parseArgs(['--evidence', 'x.txt', '--require-listener'], { values })['require-listener'], true);
});

test('printChecks returns false when a check fails', () => {
  const lines = [];
  assert.equal(printChecks([{ name: 'a', ok: true }, { name: 'b', ok: false, detail: 'x' }], (l) => lines.push(l)), false);
  assert.match(lines.join('\n'), /FAIL b - x/);
  assert.match(lines.join('\n'), /RESULT FAIL \(1 of 2/);
});

// ---- verify-hosts ----
const fakeHashes = Object.fromEntries(BASELINE_FILES.map((f) => [f.remote, f.remote.length.toString(16).padStart(2, '0').repeat(32)]));

function baselineOutput(vm, { fw = {}, marker = 'ok', hashes = fakeHashes, os = '24.04', sshd } = {}) {
  const wanted = [...rules.public_ingress.map((r) => r.port), ...rules.private_ingress.filter((r) => r.to === vm).map((r) => r.port)];
  const lines = [
    'arch=aarch64', `os=${os}`,
    `sshd=${sshd ?? 'authenticationmethods:publickey,kbdinteractiveauthentication:no,passwordauthentication:no,permitrootlogin:no,'}`,
    'secrets=700:root', 'docker=Docker_version_27', 'keepalive=active', 'cloudinit=status:_done', `marker=${marker}`,
    ...wanted.map((p) => `fw_${p}=${fw[p] ?? 'yes'}`),
    ...Object.entries(hashes).map(([p, h]) => (h === 'MISSING' ? `sha MISSING  ${p}` : `sha ${h}  ${p}`)),
  ];
  return `${lines.join('\n')}\n`;
}

function fakeSsh({ keyLogin = true, passwordRefused = true, rootRefused = true, out = baselineOutput } = {}) {
  const calls = [];
  const fn = async (a) => {
    calls.push(a);
    const vm = a.host === hosts['vm-p'].pub ? 'vm-p' : 'vm-i';
    if (a.user === 'root') return rootRefused ? { code: 255, stdout: '', stderr: 'root@h: Permission denied (publickey).' } : { code: 0, stdout: '', stderr: '' };
    if (a.options?.includes('PubkeyAuthentication=no')) return passwordRefused ? { code: 255, stdout: '', stderr: 'ubuntu@h: Permission denied (publickey).' } : { code: 255, stdout: '', stderr: 'Permission denied (publickey,password).' };
    if (a.command?.startsWith('set -o pipefail')) return keyLogin ? { code: 0, stdout: out(vm), stderr: '' } : { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
    throw new Error(`unexpected ssh ${a.command}`);
  };
  fn.calls = calls;
  return fn;
}
const probeFor = (map = {}) => async (_h, port) => map[port] ?? ([22, 80, 443].includes(port) ? 'open' : 'timeout');
const verify = (over = {}) => verifyHosts({ hosts, rules, tcpProbe: probeFor(), ssh: fakeSsh(), identity: 'k', localHashes: fakeHashes, ...over });
const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

test('verify-hosts passes on a healthy pair of hosts', async () => {
  const checks = await verify();
  assert.deepEqual(failed(checks), []);
  assert.ok(checks.some((c) => c.name === 'vm-p port 9443 closed from outside'));
  assert.ok(checks.some((c) => c.name === 'vm-i host firewall accepts port 9443'));
  assert.ok(checks.some((c) => c.name === 'vm-p host firewall accepts port 9444'));
  assert.ok(!checks.some((c) => c.name === 'vm-p host firewall accepts port 9443'), 'only the private ports addressed to that host');
});

test('the remote command uses pipefail and one iptables -C check per port, not a line count', () => {
  const c = remoteBaseline(rules, 'vm-i');
  assert.match(c, /^set -o pipefail;/);
  for (const p of [22, 80, 443]) assert.ok(c.includes(`iptables -C INPUT -p tcp --dport ${p} -m conntrack --ctstate NEW -j ACCEPT`), String(p));
  assert.ok(c.includes(`-s ${rules.subnet_cidr} --dport 9443`));
  assert.ok(!c.includes('--dport 9444'));
  assert.ok(!/grep -c/.test(c));
});

test('verify-hosts fails and names an unexpectedly open port', async () => {
  const checks = await verify({ tcpProbe: probeFor({ 5432: 'open' }) });
  assert.deepEqual(failed(checks), ['vm-p port 5432 closed from outside', 'vm-i port 5432 closed from outside']);
});

test('refused on 80 or 443 passes only when that host firewall rule exists; a timeout always fails', async () => {
  const refused = probeFor({ 80: 'refused' });
  assert.deepEqual(failed(await verify({ tcpProbe: refused })), []);
  const noRule = fakeSsh({ out: (vm) => baselineOutput(vm, { fw: { 80: 'no' } }) });
  const f = failed(await verify({ tcpProbe: refused, ssh: noRule }));
  assert.ok(f.includes('vm-p host firewall accepts port 80'));
  assert.ok(f.includes('vm-p port 80 reachable from outside'), 'refused without the host rule is not a pass');
  assert.ok((await verify({ tcpProbe: refused, requireListener: true })).some((c) => !c.ok && c.name.includes('port 80')));
  assert.ok((await verify({ tcpProbe: probeFor({ 443: 'timeout' }) })).some((c) => !c.ok && c.name.includes('port 443')));
});

test('a missing host firewall rule for the private port fails', async () => {
  const ssh = fakeSsh({ out: (vm) => baselineOutput(vm, { fw: { 9443: 'no', 9444: 'no' } }) });
  const f = failed(await verify({ ssh }));
  assert.ok(f.includes('vm-i host firewall accepts port 9443'));
  assert.ok(f.includes('vm-p host firewall accepts port 9444'));
});

test('verify-hosts fails when passwords or root are accepted, or ssh key login fails', async () => {
  assert.ok((await verify({ ssh: fakeSsh({ passwordRefused: false }) })).some((c) => !c.ok && c.name.includes('password login attempt refused')));
  assert.ok((await verify({ ssh: fakeSsh({ rootRefused: false }) })).some((c) => !c.ok && c.name.includes('root login attempt refused')));
  assert.ok((await verify({ ssh: fakeSsh({ keyLogin: false }) })).some((c) => !c.ok && c.name.includes('key login works')));
});

test('verify-hosts fails on a bad sshd setting and on a baseline marker that is failed or missing', async () => {
  const bad = fakeSsh({ out: (vm) => baselineOutput(vm, { sshd: 'passwordauthentication:yes,' }) });
  assert.ok((await verify({ ssh: bad })).some((c) => !c.ok && c.name.includes('refuses passwords')));
  const failedMarker = fakeSsh({ out: (vm) => baselineOutput(vm, { marker: 'failed:step=docker_exit=1' }) });
  const f = await verify({ ssh: failedMarker });
  assert.ok(f.some((c) => !c.ok && c.name.includes('baseline marker says ok') && c.detail.includes('step=docker')));
  assert.ok((await verify({ ssh: fakeSsh({ out: (vm) => baselineOutput(vm, { marker: 'missing' }) }) })).some((c) => !c.ok && c.name.includes('baseline marker')));
});

test('verify-hosts detects drift: a host file that differs from the repository file, or is missing, fails', async () => {
  const some = BASELINE_FILES[1].remote;
  const drift = fakeSsh({ out: (vm) => baselineOutput(vm, { hashes: { ...fakeHashes, [some]: 'f'.repeat(64) } }) });
  const f = (await verify({ ssh: drift })).filter((c) => !c.ok);
  assert.deepEqual(f.map((c) => c.name), [`vm-p ${some} matches the repository file`, `vm-i ${some} matches the repository file`]);
  assert.match(f[0].detail, /drift/);
  const gone = fakeSsh({ out: (vm) => baselineOutput(vm, { hashes: { ...fakeHashes, [some]: 'MISSING' } }) });
  assert.ok((await verify({ ssh: gone })).some((c) => !c.ok && c.detail === 'missing on the host'));
});

test('BASELINE_FILES covers every repository file that cloud-init writes, and the local hashes are real', () => {
  const ci = readFileSync(path.join(ROOT, 'infra', 'hosts', 'cloud-init.yaml.tftpl'), 'utf8');
  const b64Paths = [...ci.matchAll(/- path: (\S+)\n\s+encoding: b64/g)].map((m) => m[1]).sort();
  assert.deepEqual(BASELINE_FILES.map((f) => f.remote).sort(), b64Paths);
  const hashes = localBaselineHashes();
  assert.equal(Object.keys(hashes).length, BASELINE_FILES.length);
  assert.ok(Object.values(hashes).every((h) => /^[0-9a-f]{64}$/.test(h)));
});

// ---- private-link-check ----
function linkSsh({ mtls = true, nocert = '{"ok": false, "error": "SSLError"}', tail = 'rejected: SSLError', probe = '{"state": "timeout"}', cleanLeft = false } = {}) {
  const log = [];
  const fn = async (a) => {
    log.push(a);
    const c = a.command ?? '';
    const out = (stdout, code = 0) => ({ code, stdout, stderr: '' });
    if (c.includes('mkdir -m 700')) return out('ready');
    if (c.includes('tar c ca.crt')) return out('A'.repeat(200));
    if (c.includes('base64 -d | tar x')) return out('');
    if (c.includes('cat > ')) return out('');
    if (c.includes('server.py')) return out('4242\nlistening');
    if (c.includes('wc -l')) return out('3');
    if (c.includes('tail -n +4')) return out(tail);
    if (c.includes('client.py') && c.endsWith(' latency')) return out('{"ok": true, "n": 20, "min_ms": 0.4, "median_ms": 0.5, "p95_ms": 0.9, "max_ms": 1.1}');
    if (c.includes('client.py') && c.endsWith(' mtls')) return out(mtls ? '{"ok": true, "tls": "TLSv1.3", "tcp_ms": 0.5, "handshake_ms": 3.1}' : '{"ok": false, "error": "SSLError"}');
    if (c.includes('client.py') && c.endsWith(' nocert')) return out(nocert);
    if (c.includes('client.py') && c.endsWith(' probe')) return out(probe);
    if (c.includes('test ! -e')) return out(cleanLeft ? 'left' : 'clean');
    return out('');
  };
  fn.log = log;
  return fn;
}
const link = (over = {}) => checkPrivateLink({ hosts, rules, ssh: linkSsh(), tcpProbe: async () => 'timeout', identity: 'k', dirName: 'vm-link-test', ...over });

test('private-link-check passes: ports closed outside, mTLS works both ways, no-cert refused, wrong paths dropped, certificates removed', async () => {
  const ssh = linkSsh();
  const checks = await link({ ssh });
  assert.deepEqual(failed(checks), []);
  assert.equal(checks.filter((c) => c.name.includes('mutual-TLS handshake succeeds')).length, rules.private_ingress.length);
  assert.ok(checks.some((c) => c.name.startsWith('vm-p -> vm-i :9443')));
  assert.ok(checks.some((c) => c.name.startsWith('vm-i -> vm-p :9444')));
  assert.ok(checks.some((c) => /median 0\.5/.test(c.detail)), 'latency is recorded');
  assert.ok(checks.some((c) => c.name === 'vm-i -> vm-p :9443 (wrong direction) is dropped'));
  assert.ok(checks.some((c) => c.name === `vm-p -> vm-i :${unlistedPort(rules)} (port not in the rules) is dropped`));
  const servers = ssh.log.filter((a) => a.command?.includes('server.py /dev/shm'));
  assert.ok(servers.every((a) => /10\.0\.0\.1[12] 944[34] /.test(a.command)), 'bound to the private address of the server host');
});

test('the server lifetime comes from the step budget, and clean-up never uses a pattern kill', async () => {
  assert.equal(SERVER_SECONDS, CLIENT_STEPS_PER_LINK * SECONDS_PER_STEP + 20);
  const ssh = linkSsh();
  await link({ ssh });
  assert.ok(ssh.log.filter((a) => a.command?.includes('server.py /dev/shm')).every((a) => a.command.includes(` ${SERVER_SECONDS} >`)));
  assert.ok(ssh.log.every((a) => !/pkill|killall/.test(a.command ?? '')), 'no pkill');
  const cleanup = ssh.log.filter((a) => /rm -rf \/dev\/shm\/vm-link-test/.test(a.command ?? ''));
  assert.equal(cleanup.length, 2, 'one clean-up per host');
  assert.ok(cleanup.every((a) => a.command.includes('/dev/shm/vm-link-test')));
});

test('a running server that was not killed in its step is killed by saved id in the clean-up', async () => {
  const ssh = linkSsh();
  // The first link fails early after the server started: simulate by throwing at the nocert client of the first link.
  let thrown = false;
  const wrapped = async (a) => {
    if (!thrown && a.command?.endsWith(' nocert')) {
      thrown = true;
      throw new Error('ssh died');
    }
    return ssh(a);
  };
  await assert.rejects(() => link({ ssh: wrapped }), /ssh died/);
  const cleanup = ssh.log.filter((a) => /rm -rf \/dev\/shm\/vm-link-test/.test(a.command ?? ''));
  assert.equal(cleanup.length, 2);
  assert.ok(cleanup.some((a) => a.command.startsWith('kill 4242')), 'the saved pid is killed first');
});

test('private-link-check fails when a link port is open from the internet, or mTLS fails', async () => {
  assert.ok((await link({ tcpProbe: async (h, p) => (p === 9443 ? 'open' : 'timeout') })).some((c) => !c.ok && c.name.includes('9443 closed on')));
  assert.ok((await link({ ssh: linkSsh({ mtls: false }) })).some((c) => !c.ok && c.name.includes('mutual-TLS handshake succeeds')));
});

test('a client without a certificate is refused only on a TLS-level error with a rejection in the server log', async () => {
  const name = (c) => c.name.includes('without a certificate');
  assert.ok((await link({ ssh: linkSsh({ nocert: '{"ok": true, "tls": "TLSv1.3"}' }) })).some((c) => !c.ok && name(c)), 'it got in');
  assert.ok((await link({ ssh: linkSsh({ nocert: '{"ok": false, "error": "TimeoutError"}' }) })).some((c) => !c.ok && name(c)), 'a timeout is not a TLS refusal');
  assert.ok((await link({ ssh: linkSsh({ nocert: '{"ok": false, "error": "ConnectionRefusedError"}' }) })).some((c) => !c.ok && name(c)));
  assert.ok((await link({ ssh: linkSsh({ tail: '' }) })).some((c) => !c.ok && name(c) && c.detail.includes('no rejection')), 'server log shows nothing');
  assert.deepEqual(failed(await link({ ssh: linkSsh({ nocert: '{"ok": false, "error": "SSLEOFError"}' }) })), []);
});

test('the wrong direction and a port that is in no rule must time out; open or refused fails', async () => {
  for (const state of ['open', 'refused']) {
    const checks = await link({ ssh: linkSsh({ probe: `{"state": "${state}"}` }) });
    const f = failed(checks);
    assert.ok(f.includes('vm-i -> vm-p :9443 (wrong direction) is dropped'), state);
    assert.ok(f.some((n) => n.includes('(port not in the rules) is dropped')), state);
  }
  assert.equal(unlistedPort(rules), 9445);
  assert.equal(unlistedPort({ public_ingress: [{ port: 9445 }], private_ingress: [{ port: 9446 }] }), 9447);
});

test('private-link-check fails when a certificate is left on a host, and still cleans up after an early error', async () => {
  assert.ok((await link({ ssh: linkSsh({ cleanLeft: true }) })).some((c) => !c.ok && c.name.includes('no certificate or key left')));
  const log = [];
  const ssh = async (a) => {
    log.push(a.command);
    if (a.command.includes('mkdir -m 700')) return { code: 1, stdout: '', stderr: 'boom' };
    return { code: 0, stdout: 'clean', stderr: '' };
  };
  const early = await link({ ssh, dirName: 'd' });
  assert.ok(early.some((c) => !c.ok));
  assert.ok(log.some((c) => c.includes('rm -rf /dev/shm/d')));
});

test('the python helpers require a client certificate, bind privately and classify probes', () => {
  assert.match(SERVER_PY, /CERT_REQUIRED/);
  assert.match(SERVER_PY, /load_verify_locations/);
  assert.match(CLIENT_PY, /mode == "mtls"/);
  assert.match(CLIENT_PY, /mode == "probe"/);
  assert.ok(!/0\.0\.0\.0/.test(SERVER_PY));
});

// ---- keep-alive script ----
function findPython() {
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return exe;
  }
  return null;
}
const python = findPython();

test('keep-alive --check clamps huge, negative and non-numeric values and never crashes', { skip: python ? false : 'python3 is not installed here: keep-alive script check skipped' }, () => {
  const script = path.join(ROOT, 'infra', 'hosts', 'vulnmart-keepalive.py');
  const run = (env) => spawnSync(python, ['-I', script, '--check'], { encoding: 'utf8', env: { ...process.env, ...env } });
  const cases = [
    [{ KEEPALIVE_MEM_MB: '99999999999999999999', KEEPALIVE_CPU_PERCENT: '500' }, 'mem_mb=1900 cpu_percent=40'],
    [{ KEEPALIVE_MEM_MB: '-5', KEEPALIVE_CPU_PERCENT: '-1' }, 'mem_mb=0 cpu_percent=0'],
    [{ KEEPALIVE_MEM_MB: 'lots', KEEPALIVE_CPU_PERCENT: '12.5' }, 'mem_mb=1536 cpu_percent=0'],
    [{ KEEPALIVE_MEM_MB: '', KEEPALIVE_CPU_PERCENT: '' }, 'mem_mb=1536 cpu_percent=0'],
    [{ KEEPALIVE_MEM_MB: '1024', KEEPALIVE_CPU_PERCENT: '10' }, 'mem_mb=1024 cpu_percent=10'],
  ];
  for (const [env, expected] of cases) {
    const r = run(env);
    assert.equal(r.status, 0, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.ok(r.stdout.includes(expected), `${JSON.stringify(env)} -> ${r.stdout}`);
  }
  assert.match(run({ KEEPALIVE_MEM_MB: 'lots' }).stderr, /warning: KEEPALIVE_MEM_MB='lots' is not a whole number/);
});
