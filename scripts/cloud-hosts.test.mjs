// Unit tests of the host checks with injected network and ssh runners (no network, no cloud account).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHosts, redact, parseKeyValues, parseArgs, printChecks, resolveHostsFile, loadHosts, PROVIDER_HOSTS_FILES } from './cloud-hosts.mjs';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { verifyHosts, remoteBaseline, BASELINE_FILES, localBaselineHashes, metadataCommand, pullCommand, verifyOptions, tempListenerStart, IMDS_PY, IMDS_IMAGE } from './verify-hosts.mjs';
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

function baselineOutput(vm, { fw = {}, marker = 'ok', hashes = fakeHashes, os = '24.04', sshd, keepalive = 'inactive', arch = 'x86_64', reboot = 'no', cloudinit = 'status:_done', certs, certtimer = 'enabled', certtooling } = {}) {
  const wanted = [...rules.public_ingress.map((r) => r.port), ...rules.private_ingress.filter((r) => r.to === vm).map((r) => r.port)];
  const lines = [
    `arch=${arch}`, `os=${os}`,
    `sshd=${sshd ?? 'authenticationmethods:publickey,kbdinteractiveauthentication:no,passwordauthentication:no,permitrootlogin:no,'}`,
    'secrets=700:root', 'docker=Docker_version_27', `keepalive=${keepalive}`, `reboot=${reboot}`, `cloudinit=${cloudinit}`, `marker=${marker}`, ...(certs === undefined ? [] : [`certs=${certs}`, `certtimer=${certtimer}`, ...(certtooling === undefined ? [] : [`certtooling=${certtooling}`])]),
    ...wanted.map((p) => `fw_${p}=${fw[p] ?? 'yes'}`),
    ...Object.entries(hashes).map(([p, h]) => (h === 'MISSING' ? `sha MISSING  ${p}` : `sha ${h}  ${p}`)),
  ];
  return `${lines.join('\n')}\n`;
}

const GOOD_IMDS = 'host_imds=reachable\nhost_control=reachable\ncontainer_imds=blocked:TimeoutError\ncontainer_control=reachable\n';

function fakeSsh({ keyLogin = true, passwordRefused = true, rootRefused = true, out = baselineOutput, imds = GOOD_IMDS, pull = { code: 0, stdout: '', stderr: '' }, listener = { code: 0, stdout: '', stderr: '' } } = {}) {
  const calls = [];
  const fn = async (a) => {
    calls.push(a);
    const vm = a.host === hosts['vm-p'].pub ? 'vm-p' : 'vm-i';
    if (a.user === 'root') return rootRefused ? { code: 255, stdout: '', stderr: 'root@h: Permission denied (publickey).' } : { code: 0, stdout: '', stderr: '' };
    if (a.options?.includes('PubkeyAuthentication=no')) return passwordRefused ? { code: 255, stdout: '', stderr: 'ubuntu@h: Permission denied (publickey).' } : { code: 255, stdout: '', stderr: 'Permission denied (publickey,password).' };
    if (a.command?.startsWith('set -o pipefail')) return keyLogin ? { code: 0, stdout: out(vm), stderr: '' } : { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
    if (a.command?.startsWith('sudo -n docker pull')) return pull;
    if (a.command?.includes('vulnmart-verify')) return a.command.startsWith('sudo -n systemctl stop') ? { code: 0, stdout: '', stderr: '' } : listener;
    if (a.command?.includes('169.254.169.254')) return { code: 0, stdout: imds, stderr: '' };
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
  assert.ok(checks.some((c) => c.name === 'vm-i host firewall placeholder rule for port 9443 present'));
  assert.ok(checks.some((c) => c.name === 'vm-p host firewall placeholder rule for port 9444 present'));
  assert.ok(!checks.some((c) => c.name === 'vm-p host firewall placeholder rule for port 9443 present'), 'only the private ports addressed to that host');
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
  assert.ok(f.includes('vm-p host firewall placeholder rule for port 80 present'));
  assert.ok(f.includes('vm-p port 80 reachable from outside'), 'refused without the host rule is not a pass');
  assert.ok((await verify({ tcpProbe: refused, requireListener: true })).some((c) => !c.ok && c.name.includes('port 80')));
  assert.ok((await verify({ tcpProbe: probeFor({ 443: 'timeout' }) })).some((c) => !c.ok && c.name.includes('port 443')));
});

test('with the temporary listener the web ports must really answer: refused or a timeout fails, and the listener is stopped again', async () => {
  const ssh = fakeSsh();
  const ok = await verify({ ssh, tempListener: true });
  assert.deepEqual(failed(ok), []);
  assert.ok(ok.some((c) => c.name.includes('temporary listener on 80 and 443 started')));
  const cmds = ssh.calls.map((c) => c.command ?? '');
  const start = cmds.findIndex((c) => c.includes('vulnmart-verify-80') && !c.startsWith('sudo -n systemctl stop'));
  const stop = cmds.findIndex((c) => c.startsWith('sudo -n systemctl stop'));
  assert.ok(start >= 0 && stop > start, 'start before stop');
  assert.ok(cmds[start].includes('vulnmart-verify-443') && cmds[start].includes("ss -tln | grep -q ':80 '"));
  assert.ok((await verify({ ssh: fakeSsh(), tempListener: true, tcpProbe: probeFor({ 80: 'refused' }) })).some((c) => !c.ok && c.name === 'vm-p port 80 reachable from outside'));
  assert.ok((await verify({ ssh: fakeSsh(), tempListener: true, tcpProbe: probeFor({ 443: 'timeout' }) })).some((c) => !c.ok && c.name === 'vm-i port 443 reachable from outside'));
});

test('a listener that cannot be started is a named failure and nothing is stopped; the python code has no single quote', async () => {
  const ssh = fakeSsh({ listener: { code: 1, stdout: '', stderr: 'Failed to start transient service' } });
  const f = await verify({ ssh, tempListener: true });
  assert.ok(f.some((c) => !c.ok && c.name.includes('temporary listener') && c.detail.includes('Failed to start')));
  assert.ok(!ssh.calls.some((c) => (c.command ?? '').startsWith('sudo -n systemctl stop')));
  assert.ok(!tempListenerStart([80]).slice(tempListenerStart([80]).indexOf("-c '") + 4).split("' ")[0].includes("'"));
  assert.deepEqual(verifyOptions({}).tempListener, true);
  assert.deepEqual(verifyOptions({ 'no-temp-listener': true }).tempListener, false);
});
test('a missing host firewall rule for the private port fails', async () => {
  const ssh = fakeSsh({ out: (vm) => baselineOutput(vm, { fw: { 9443: 'no', 9444: 'no' } }) });
  const f = failed(await verify({ ssh }));
  assert.ok(f.includes('vm-i host firewall placeholder rule for port 9443 present'));
  assert.ok(f.includes('vm-p host firewall placeholder rule for port 9444 present'));
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

test('cloud-init error is accepted only with an ok baseline marker (repaired by hand) and is flagged as a warning', async () => {
  const repaired = await verify({ ssh: fakeSsh({ out: (vm) => baselineOutput(vm, { cloudinit: 'status:_error', marker: 'ok' }) }) });
  const ok = repaired.find((c) => c.name.includes('cloud-init finished'));
  assert.ok(ok.ok && ok.warn && /repaired and rerun by hand/.test(ok.detail));
  const broken = await verify({ ssh: fakeSsh({ out: (vm) => baselineOutput(vm, { cloudinit: 'status:_error', marker: 'failed:step=docker_exit=1' }) }) });
  assert.ok(broken.some((c) => !c.ok && c.name.includes('cloud-init finished')));
  const none = await verify({ ssh: fakeSsh({ out: (vm) => baselineOutput(vm, { cloudinit: 'status:_running', marker: 'ok' }) }) });
  assert.ok(none.some((c) => !c.ok && c.name.includes('cloud-init finished')));
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
  const b64Paths = [...ci.matchAll(/- path: (\S+)\n\s+encoding: b64/g), ...ci.matchAll(/- path: (\S+)\n\s+permissions: "\d+"\n\s+content: \|\n\s+\$\{\w+\}\n/g)].map((m) => m[1]).sort();
  assert.deepEqual(BASELINE_FILES.map((f) => f.remote).sort(), b64Paths);
  const hashes = localBaselineHashes();
  assert.equal(Object.keys(hashes).length, BASELINE_FILES.length);
  assert.ok(Object.values(hashes).every((h) => /^[0-9a-f]{64}$/.test(h)));
});

test('certificate checks: none yet is a warning, ok with enough days passes, few days or a failure marker fails, an old answer without the field adds nothing', async () => {
  const run = async (o) => (await verify({ ssh: fakeSsh({ out: (vm) => baselineOutput(vm, o) }) })).filter((c) => /certificate/.test(c.name));
  assert.deepEqual(await run({}), []);
  const none = await run({ certs: 'none:na' });
  assert.ok(none.every((c) => c.ok) && none.some((c) => c.warn && /none issued yet/.test(c.detail)));
  assert.ok((await run({ certs: 'ok:59' })).every((c) => c.ok && !c.warn));
  assert.ok((await run({ certs: 'ok:9' })).some((c) => !c.ok && /more than 14 days/.test(c.name)));
  assert.ok((await run({ certs: 'failed:40' })).some((c) => !c.ok && /has not failed/.test(c.name)));
  assert.ok((await run({ certs: 'ok:59', certtimer: 'disabled' })).some((c) => !c.ok && /timer enabled/.test(c.name)));
  // an empty or unknown answer is a warning, never "more than 14 days"
  for (const bad of ['', 'garbage', ':']) {
    const r = await run({ certs: bad });
    assert.ok(r.length > 0 && r.every((c) => c.ok && c.warn && /not installed or answer unreadable/.test(c.detail)), `answer "${bad}"`);
    assert.ok(!r.some((c) => /more than 14 days/.test(c.name)));
  }
  // a failed tooling install at first boot is a warning
  const tool = await run({ certs: 'none:na', certtooling: 'failed' });
  assert.ok(tool.every((c) => c.ok) && tool.some((c) => c.warn && /certs-tooling-failed/.test(c.detail)));
});

test('the remote command asks for certificate status and the timer state', () => {
  const cmd = remoteBaseline(rules, 'vm-p');
  assert.match(cmd, /vulnmart-certs\.sh status --short/);
  assert.match(cmd, /is-enabled vulnmart-certs\.timer/);
});

test('rendered cloud-init parses as YAML, carries the plain-text host files unchanged, and stays under the 16384 byte user-data limit (gzip, 3 distinct keys)', () => {
  const host = (n) => readFileSync(path.join(ROOT, 'infra', 'hosts', n));
  const b64 = (n) => host(n).toString('base64');
  // Terraform indent(6, text): every newline is followed by 6 spaces (the first line is not indented).
  const indent6 = (n) => host(n).toString('utf8').replace(/\n/g, '\n      ');
  // Distinct random ed25519-looking key lines (random bytes, not real keys).
  const fakeKey = (i) => `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), randomBytes(32)]).toString('base64')} dev${i}@laptop`;
  const v = {
    sshd_conf: b64('sshd-hardening.conf'), firewall_sh: b64('vulnmart-firewall.sh'), docker_sh: b64('vulnmart-install-docker.sh'), baseline_sh: b64('vulnmart-baseline.sh'),
    docker_daemon: b64('docker-daemon.json'), keepalive_py: b64('vulnmart-keepalive.py'), keepalive_unit: b64('vulnmart-keepalive.service'), egress_sh: indent6('vulnmart-egress.sh'),
    egress_unit: b64('vulnmart-egress.service'), certs_sh: indent6('vulnmart-certs.sh'), reload_caddy_sh: indent6('vulnmart-reload-caddy.sh'), certs_unit: indent6('vulnmart-certs.service'), certs_timer: indent6('vulnmart-certs.timer'),
    lego_pin: indent6('lego.pin.json'), lego_install_sh: indent6('vulnmart-install-lego.sh'),
    egress_env: JSON.stringify('VPC_CIDR=10.0.0.0/16\nVPC_RESOLVER=10.0.0.2\nPLATFORM_SUBNET=10.0.0.0/24\nLABS_HOST_SUBNET=10.0.1.0/24\nLABS_DOCKER_SUBNETS="172.17.0.0/16 172.30.0.0/16"\nINGEST_PORT=9444\n'),
    private_cidr: '10.0.0.0/16', ntp_server: '169.254.169.123', keepalive_enabled: 'no',
    ssh_keys_json: JSON.stringify([1, 2, 3].map(fakeKey)),
  };
  assert.equal(new Set(JSON.parse(v.ssh_keys_json)).size, 3, 'the keys are distinct');
  const text = readFileSync(path.join(ROOT, 'infra', 'hosts', 'cloud-init.yaml.tftpl'), 'utf8').replace(/\$\{(\w+)\}/g, (_, k) => { assert.ok(k in v, `unknown template variable ${k}`); return v[k]; });
  const doc = yaml.load(text);
  const plain = { '/usr/local/sbin/vulnmart-egress.sh': 'vulnmart-egress.sh', '/usr/local/sbin/vulnmart-certs.sh': 'vulnmart-certs.sh', '/usr/local/sbin/vulnmart-reload-caddy.sh': 'vulnmart-reload-caddy.sh', '/etc/systemd/system/vulnmart-certs.service': 'vulnmart-certs.service', '/etc/systemd/system/vulnmart-certs.timer': 'vulnmart-certs.timer', '/etc/vulnmart/lego.pin.json': 'lego.pin.json', '/usr/local/sbin/vulnmart-install-lego.sh': 'vulnmart-install-lego.sh' };
  for (const [remote, file] of Object.entries(plain)) {
    const entry = doc.write_files.find((w) => w.path === remote);
    assert.ok(entry, `${remote} is in write_files`);
    assert.equal(entry.encoding, undefined, `${remote} is plain text`);
    assert.equal(entry.content.replace(/\n$/, ''), host(file).toString('utf8').replace(/\n$/, ''), `${remote} content equals ${file}`);
  }
  const gz = gzipSync(text).length;
  console.log(`# rendered cloud-init: ${text.length} bytes, ${gz} bytes gzipped (limit 16384, 3 keys)`);
  assert.ok(gz < 16384, `gzip size ${gz}`);
});
// ---- private-link-check ----
function linkSsh({ mtls = true, nocert = '{"ok": false, "error": "SSLError"}', tail = 'rejected: SSLError', probe = '{"state": "timeout"}', cleanLeft = false } = {}) {
  const log = [];
  const fn = async (a) => {
    log.push(a);
    const c = a.command ?? '';
    const out = (stdout, code = 0) => ({ code, stdout, stderr: '' });
    if (c.includes('install -d -m 0700')) return out('ready');
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
  const servers = ssh.log.filter((a) => a.command?.includes('server.py /run'));
  assert.ok(servers.every((a) => /10\.0\.0\.1[12] 944[34] /.test(a.command)), 'bound to the private address of the server host');
});

test('the server lifetime comes from the step budget, and clean-up never uses a pattern kill', async () => {
  assert.equal(SERVER_SECONDS, CLIENT_STEPS_PER_LINK * SECONDS_PER_STEP + 20);
  const ssh = linkSsh();
  await link({ ssh });
  assert.ok(ssh.log.filter((a) => a.command?.includes('server.py /run')).every((a) => a.command.includes(` ${SERVER_SECONDS} >`)));
  assert.ok(ssh.log.every((a) => !/pkill|killall/.test(a.command ?? '')), 'no pkill');
  const cleanup = ssh.log.filter((a) => /sudo -n rm -rf \/run\/vm-link-test/.test(a.command ?? ''));
  assert.equal(cleanup.length, 2, 'one clean-up per host');
  assert.ok(cleanup.every((a) => a.command.includes('/run/vm-link-test')));
});

test('the work folder is under /run (memory-backed, root-owned and made with sudo), not /dev/shm which logind wipes when an ssh session ends', async () => {
  const log = [];
  const ssh = async (a) => { log.push(a.command ?? ''); return { code: 0, stdout: 'ready', stderr: '' }; };
  await checkPrivateLink({ hosts, rules, ssh, tcpProbe: async () => 'timeout', identity: 'k', dirName: 'vm-link-x' }).catch(() => {});
  const make = log.find((c) => c.includes('install -d'));
  assert.ok(make && make.includes('/run/vm-link-x') && make.startsWith('sudo -n install -d -m 0700'), make);
  assert.ok(!log.some((c) => c.includes('/dev/shm')));
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
  const cleanup = ssh.log.filter((a) => /sudo -n rm -rf \/run\/vm-link-test/.test(a.command ?? ''));
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
    if (a.command.includes('install -d -m 0700')) return { code: 1, stdout: '', stderr: 'boom' };
    return { code: 0, stdout: 'clean', stderr: '' };
  };
  const early = await link({ ssh, dirName: 'd' });
  assert.ok(early.some((c) => !c.ok));
  assert.ok(log.some((c) => c.includes('sudo -n rm -rf /run/d')));
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

test('the metadata check needs a working container control: reachable metadata, a container without network, a broken host control and no answer all fail', async () => {
  const name = 'a container cannot read instance metadata (IMDSv2, hop limit 1)';
  assert.deepEqual(failed(await verify({ ssh: fakeSsh({ imds: 'host_imds=reachable\ncontainer_imds=reachable\ncontainer_control=reachable\n' }) })), [`vm-p ${name}`, `vm-i ${name}`]);
  // blocked only because the container has no network: not accepted
  const dead = failed(await verify({ ssh: fakeSsh({ imds: 'host_imds=reachable\ncontainer_imds=blocked:URLError\ncontainer_control=failed:URLError\n' }) }));
  assert.deepEqual(dead, ['vm-p a container has network access (control)', `vm-p ${name}`, 'vm-i a container has network access (control)', `vm-i ${name}`]);
  assert.deepEqual(failed(await verify({ ssh: fakeSsh({ imds: 'host_imds=blocked:URLError\ncontainer_imds=blocked:URLError\ncontainer_control=reachable\n' }) })), ['vm-p instance metadata is reachable from the host (control)', 'vm-i instance metadata is reachable from the host (control)']);
  assert.equal(failed(await verify({ ssh: fakeSsh({ imds: '' }) })).length, 6);
  assert.deepEqual(failed(await verify({ checkMetadata: false, ssh: fakeSsh({ imds: '' }) })), []);
  const ok = await verify();
  assert.ok(ok.some((c) => c.name.endsWith(name) && c.detail === 'blocked:TimeoutError'), 'the exception class is printed');
});

test('a failed image pull is reported as an image pull failure, not as a metadata result', async () => {
  const bad = fakeSsh({ pull: { code: 1, stdout: '', stderr: 'toomanyrequests: rate limit' } });
  const checks = await verify({ ssh: bad });
  assert.deepEqual(failed(checks), ['vm-p metadata probe image pulled (pinned by digest)', 'vm-i metadata probe image pulled (pinned by digest)']);
  assert.match(checks.find((c) => !c.ok).detail, /^image pull failed/);
  assert.ok(!checks.some((c) => c.name.includes('a container cannot read')), 'no metadata verdict without the image');
});

test('the probe image is pinned by digest, the command pulls and runs that image, and no role credentials are requested', () => {
  assert.match(IMDS_IMAGE, /^python:3\.12-alpine@sha256:[0-9a-f]{64}$/);
  assert.equal(pullCommand(), `sudo -n docker pull ${IMDS_IMAGE}`);
  const c = metadataCommand();
  assert.ok(c.includes(`docker run --rm ${IMDS_IMAGE} python3 -c`));
  assert.match(c, /sed 's\/\^\/host_\/'/);
  assert.match(c, /^sudo -n python3 -c /, 'the host control runs as root: the metadata rule of ADR 0027 drops non-root processes (found live 2026-10-11)');
  assert.match(c, /sed 's\/\^\/container_\/'/);
  assert.match(IMDS_PY, /method="PUT"/);
  assert.match(IMDS_PY, /X-aws-ec2-metadata-token-ttl-seconds/);
  assert.match(IMDS_PY, /type\(e\)\.__name__/);
  assert.ok(!/security-credentials/.test(c));
});

test('keep-alive off requires inactive, failed or unknown and fails on missing data; on requires active; x86_64 and aarch64 pass; a pending reboot is a warning', async () => {
  assert.deepEqual(failed(await verify()), []);
  for (const state of ['active', 'activating', null]) {
    const bad = fakeSsh({ out: (vm) => baselineOutput(vm, { keepalive: state }).replace(/^keepalive=null\n/m, '') });
    assert.ok((await verify({ ssh: bad })).some((c) => !c.ok && c.name.includes('keep-alive service off')), String(state));
  }
  for (const state of ['inactive', 'failed', 'unknown']) assert.deepEqual(failed(await verify({ ssh: fakeSsh({ out: (vm) => baselineOutput(vm, { keepalive: state }) }) })), [], state);
  const on = fakeSsh({ out: (vm) => baselineOutput(vm, { keepalive: 'active', arch: 'aarch64' }) });
  assert.deepEqual(failed(await verify({ ssh: on, keepalive: true })), []);
  const odd = fakeSsh({ out: (vm) => baselineOutput(vm, { arch: 'riscv64' }) });
  assert.ok((await verify({ ssh: odd })).some((c) => !c.ok && c.name.includes('Ubuntu 24.04')));
  const pending = await verify({ ssh: fakeSsh({ out: (vm) => baselineOutput(vm, { reboot: 'required' }) }) });
  assert.deepEqual(failed(pending), []);
  const w = pending.find((c) => c.name.includes('a reboot is pending'));
  assert.ok(w.ok && w.warn && /reboot this host once/.test(w.detail));
  const lines = [];
  assert.equal(printChecks([w], (l) => lines.push(l)), true);
  assert.match(lines[0], /^WARN /);
  assert.match(remoteBaseline(rules, 'vm-p'), /reboot-required/);
});

test('verifyOptions maps the command line flags (--keepalive, --skip-metadata, --require-listener)', () => {
  assert.deepEqual(verifyOptions({ _: [] }), { requireListener: false, keepalive: false, checkMetadata: true, tempListener: true });
  assert.deepEqual(verifyOptions(parseArgs(['--keepalive', '--skip-metadata', '--require-listener'])), { requireListener: true, keepalive: true, checkMetadata: false, tempListener: true });
  assert.deepEqual(verifyOptions(parseArgs(['--identity', 'k', '--skip-metadata'], { values: ['identity'] })), { requireListener: false, keepalive: false, checkMetadata: false, tempListener: true });
});

test('the address file is never guessed: --hosts, then --provider, then the only file that exists, else an error naming the choice', () => {
  const none = () => false;
  const both = () => true;
  const only = (f) => f === PROVIDER_HOSTS_FILES.aws;
  assert.equal(resolveHostsFile({ hosts: 'x.json' }, both), 'x.json');
  assert.equal(resolveHostsFile({ provider: 'oci' }, none), PROVIDER_HOSTS_FILES.oci);
  assert.equal(resolveHostsFile({ provider: 'aws' }, both), PROVIDER_HOSTS_FILES.aws);
  assert.equal(resolveHostsFile({}, only), PROVIDER_HOSTS_FILES.aws);
  assert.throws(() => resolveHostsFile({}, both), /two address files exist.*--provider/);
  assert.throws(() => resolveHostsFile({}, none), /no address file found.*--provider/);
  assert.throws(() => resolveHostsFile({ provider: 'gcp' }, none), /--provider must be one of/);
  assert.throws(() => loadHosts(undefined), /no address file/);
  assert.throws(() => loadHosts('does-not-exist.json'), /Terraform folder of your provider/);
  for (const f of ['verify-hosts.mjs', 'private-link-check.mjs']) assert.match(readFileSync(path.join(ROOT, 'scripts', f), 'utf8'), /loadHosts\(resolveHostsFile\(opts\)\)/);
});

test('baseline.sh refuses a keep-alive argument other than yes or no (exit 2, before touching anything) and records a pending reboot', () => {
  const sh = readFileSync(path.join(ROOT, 'infra', 'hosts', 'vulnmart-baseline.sh'), 'utf8');
  assert.match(sh, /yes\|no\) ;;/);
  assert.match(sh, /exit 2/);
  assert.ok(sh.indexOf('exit 2') < sh.indexOf('mkdir -p'), 'validation comes before any change');
  assert.match(sh, /\/var\/run\/reboot-required.*reboot-required.*baseline-ok/);
  const probe = spawnSync('sh', ['-c', 'echo ok']);
  if (probe.status === 0) {
    const r = spawnSync('sh', [path.join(ROOT, 'infra', 'hosts', 'vulnmart-baseline.sh'), '10.0.0.0/24', 'maybe'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must be yes or no, got: maybe/);
  }
});