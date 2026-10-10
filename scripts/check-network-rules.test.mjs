// Policy test for the firewall rule data, plus static checks of the Terraform and host files (no credentials, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRules, checkTerraformReadsRules, cidrInside, RULES_FILE } from './check-network-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const rules = () => JSON.parse(readFileSync(RULES_FILE, 'utf8'));

test('the committed rule file passes the policy', () => {
  assert.deepEqual(checkRules(rules()), []);
});

test('public ingress is 22, 80 and 443 only', () => {
  assert.deepEqual(rules().public_ingress.map((r) => r.port).sort((a, b) => a - b), [22, 80, 443]);
});

test('an added public port fails and names the rule', () => {
  const r = rules();
  r.public_ingress.push({ name: 'debug-db', protocol: 'tcp', port: 5432, sources: ['0.0.0.0/0'] });
  const problems = checkRules(r);
  assert.ok(problems.some((p) => p.includes('debug-db') && p.includes('5432')), problems.join('\n'));
});

test('ssh from everywhere fails', () => {
  const r = rules();
  r.public_ingress.find((x) => x.port === 22).sources = ['0.0.0.0/0'];
  assert.ok(checkRules(r).some((p) => p.includes('ssh') && p.includes('port 22')));
});

test('a port range or a udp rule fails', () => {
  const r = rules();
  r.public_ingress.push({ name: 'range', protocol: 'udp', port: '1000-2000', sources: ['0.0.0.0/0'] });
  const text = checkRules(r).join('\n');
  assert.match(text, /range: only tcp/);
  assert.match(text, /range: port must be a single number/);
});

test('a private rule may not use a public port or an address', () => {
  const r = rules();
  r.private_ingress.push({ name: 'p443', protocol: 'tcp', port: 443, from: 'vm-p', to: 'vm-i' });
  r.private_ingress.push({ name: 'addr', protocol: 'tcp', port: 7000, from: 'vm-p', to: 'vm-i', sources: ['0.0.0.0/0'] });
  const text = checkRules(r).join('\n');
  assert.match(text, /p443: port 443 is a public port/);
  assert.match(text, /addr: private rules name a VM/);
});

test('removing a required public port fails', () => {
  const r = rules();
  r.public_ingress = r.public_ingress.filter((x) => x.port !== 443);
  assert.ok(checkRules(r).some((p) => p.includes('443 is missing')));
});

test('network.tf reads the rule file and has no port numbers of its own', () => {
  assert.deepEqual(checkTerraformReadsRules(read('infra', 'terraform', 'oci', 'network.tf')), []);
  assert.ok(checkTerraformReadsRules('min = 8080\n').length > 0);
});

test('both VMs get the same cloud-init and the same shape from one resource', () => {
  const tf = read('infra', 'terraform', 'oci', 'compute.tf');
  assert.equal((tf.match(/resource "oci_core_instance"/g) ?? []).length, 1);
  assert.match(tf, /for_each\s*=\s*toset\(local\.vm_names\)/);
  assert.match(tf, /VM\.Standard\.A1\.Flex/);
  assert.match(tf, /Canonical Ubuntu/);
  assert.match(tf, /operating_system_version\s*=\s*"24\.04"/);
  assert.equal((tf.match(/user_data\s*=\s*local\.user_data/g) ?? []).length, 1);
});

test('provider and Terraform are pinned', () => {
  const v = read('infra', 'terraform', 'oci', 'versions.tf');
  assert.match(v, /version\s*=\s*"= 9\.9\.0"/);
  assert.match(v, /required_version/);
  assert.match(read('infra', 'terraform', 'oci', '.terraform.lock.hcl'), /registry\.terraform\.io\/oracle\/oci/);
});

test('terraform ssh and credential variables are not defaulted, and ssh cannot be opened to the world', () => {
  const v = read('infra', 'terraform', 'oci', 'variables.tf');
  for (const name of ['tenancy_ocid', 'user_ocid', 'fingerprint', 'private_key_path', 'compartment_ocid', 'ssh_source_cidrs', 'ssh_public_keys', 'alarm_email']) {
    const block = v.split(`variable "${name}"`)[1].split(/^variable /m)[0];
    assert.ok(!/^\s*default\s*=/m.test(block), `${name} has no default`);
  }
  assert.match(v, /!contains\(var\.ssh_source_cidrs, "0\.0\.0\.0\/0"\)/);
});

test('sshd baseline is key-only with no root login', () => {
  const c = read('infra', 'hosts', 'sshd-hardening.conf');
  for (const line of ['PasswordAuthentication no', 'PermitRootLogin no', 'KbdInteractiveAuthentication no', 'AuthenticationMethods publickey']) assert.match(c, new RegExp(`^${line}$`, 'm'));
});

test('the host firewall script opens exactly the ports of the rule file', () => {
  const sh = read('infra', 'hosts', 'vulnmart-firewall.sh');
  const r = rules();
  const pub = sh.match(/PUBLIC_PORTS="([^"]*)"/)[1].split(' ').map(Number);
  const priv = sh.match(/PRIVATE_PORTS="([^"]*)"/)[1].split(' ').map(Number);
  assert.deepEqual(pub, r.public_ingress.map((x) => x.port));
  assert.deepEqual(priv, r.private_ingress.map((x) => x.port));
  assert.match(sh, /netfilter-persistent save/);
});

test('cloud-init runs one baseline script that stops at the first failure and writes a marker', () => {
  const c = read('infra', 'hosts', 'cloud-init.yaml.tftpl');
  assert.match(c, /runcmd:\n\s+- \[\/usr\/local\/sbin\/vulnmart-baseline\.sh, "\$\{private_cidr\}"\]/);
  for (const needle of ['00-vulnmart.conf', 'vulnmart-firewall.sh', 'vulnmart-install-docker.sh', 'vulnmart-keepalive.service', '/etc/docker/daemon.json', 'unattended-upgrades', 'timesyncd']) assert.ok(c.includes(needle), needle);
  const b = read('infra', 'hosts', 'vulnmart-baseline.sh');
  assert.match(b, /^set -eu$/m);
  assert.match(b, /baseline-ok/);
  assert.match(b, /baseline-failed/);
  assert.match(b, /step=\$STEP/);
  const steps = [...b.matchAll(/^STEP=([a-z-]+);[ \t]+.*$/gm)].map((m) => m[1]);
  assert.deepEqual(steps, ['lock-root', 'sshd-config-test', 'restart-ssh', 'firewall', 'docker', 'secrets-dir', 'time-sync', 'keepalive', 'unattended-upgrades']);
  assert.match(b, /passwd -l root/);
  assert.match(b, /install -d -m 0700 -o root -g root \/opt\/vulnmart \/opt\/vulnmart\/secrets/);
  assert.match(b, /sshd -t/);
});

test('docker daemon has log rotation and live-restore, sshd allows 6 tries', () => {
  const d = JSON.parse(read('infra', 'hosts', 'docker-daemon.json'));
  assert.deepEqual(d['log-opts'], { 'max-size': '10m', 'max-file': '3' });
  assert.equal(d['live-restore'], true);
  assert.match(read('infra', 'hosts', 'sshd-hardening.conf'), /^MaxAuthTries 6$/m);
});

test('the docker install waits for the apt lock and retries downloads with timeouts', () => {
  const sh = read('infra', 'hosts', 'vulnmart-install-docker.sh');
  assert.match(sh, /curl -fsSL --retry 5 --connect-timeout 10 --max-time 60/);
  assert.equal((sh.match(/DPkg::Lock::Timeout=300/g) ?? []).length, 2);
});
test('docker is installed from the official repository after a fingerprint check', () => {
  const sh = read('infra', 'hosts', 'vulnmart-install-docker.sh');
  assert.match(sh, /download\.docker\.com\/linux\/ubuntu/);
  assert.match(sh, /EXPECTED_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"/);
  assert.match(sh, /mismatch: refusing/);
});

test('the keep-alive service is bounded (memory, CPU, tasks, priority, sandbox)', () => {
  const u = read('infra', 'hosts', 'vulnmart-keepalive.service');
  for (const line of [/^MemoryMax=2200M$/m, /^CPUQuota=50%$/m, /^TasksMax=\d+$/m, /^Nice=19$/m, /^OOMScoreAdjust=1000$/m, /^DynamicUser=yes$/m, /^NoNewPrivileges=yes$/m]) assert.match(u, line);
  const py = read('infra', 'hosts', 'vulnmart-keepalive.py');
  assert.match(py, /MAX_MEM_MB = 1900/);
  assert.match(py, /MAX_CPU_PERCENT = 40/);
});

test('the idle alarm and its e-mail topic exist', () => {
  const a = read('infra', 'terraform', 'oci', 'alarms.tf');
  assert.match(a, /oci_monitoring_alarm/);
  assert.match(a, /protocol\s*=\s*"EMAIL"/);
});

test('a null or non-object entry is a named failure, not a crash', () => {
  for (const key of ['public_ingress', 'private_ingress', 'icmp_ingress']) {
    const r = rules();
    r[key].push(null);
    const text = checkRules(r).join('\n');
    assert.match(text, new RegExp(`${key}\\[\\d+\\]: entry must be an object`));
  }
  assert.deepEqual(checkRules(null), ['the rule file must be a JSON object']);
  const r = rules();
  r.public_ingress.push('x');
  assert.ok(checkRules(r).some((p) => p.includes('public_ingress[3]')));
});

test('::/0 on port 22 is rejected like 0.0.0.0/0', () => {
  const r = rules();
  r.public_ingress.find((x) => x.port === 22).sources = ['::/0'];
  assert.ok(checkRules(r).some((p) => p.includes('port 22 must not be open to ::/0')));
});

test('the subnet must lie inside the VCN', () => {
  assert.equal(cidrInside('10.0.0.0/24', '10.0.0.0/16'), true);
  assert.equal(cidrInside('10.1.0.0/24', '10.0.0.0/16'), false);
  assert.equal(cidrInside('10.0.0.0/8', '10.0.0.0/16'), false);
  assert.equal(cidrInside('nonsense', '10.0.0.0/16'), false);
  const r = rules();
  r.subnet_cidr = '192.168.0.0/24';
  assert.ok(checkRules(r).some((p) => p.includes('subnet_cidr must be a valid IPv4 CIDR inside vcn_cidr')));
  const bad = rules();
  delete bad.subnet_cidr;
  assert.ok(checkRules(bad).some((p) => p.includes('subnet_cidr')));
});

test('the Terraform variables refuse wide, duplicate and placeholder ssh sources and private-key lookalikes', () => {
  const v = read('infra', 'terraform', 'oci', 'variables.tf');
  assert.match(v, /can\(cidrhost\(c, 0\)\)/);
  assert.match(v, /"::\/0"/);
  assert.match(v, />= 16/);
  assert.match(v, /distinct\(var\.ssh_source_cidrs\)/);
  assert.match(v, /\^ssh-\(ed25519\|rsa\)/);
  assert.match(v, /PRIVATE/);
  assert.match(v, /AAAA\.\.\./);
});

test('a running VM is not replaced by a changed startup file or key list, and bad inputs give clear errors', () => {
  const tf = read('infra', 'terraform', 'oci', 'compute.tf');
  assert.match(tf, /ignore_changes = \[.*metadata\["user_data"\].*metadata\["ssh_authorized_keys"\]/);
  assert.match(tf, /availability_domain_index is outside/);
  assert.match(tf, /No Ubuntu 24\.04 image/);
});

test('a missing-metric alarm exists next to the low-memory alarm and uses the owner topic', () => {
  const a = read('infra', 'terraform', 'oci', 'alarms.tf');
  assert.match(a, /resource "oci_monitoring_alarm" "idle_memory"/);
  assert.match(a, /resource "oci_monitoring_alarm" "metric_missing"/);
  assert.match(a, /\.absent\(\)/);
  assert.equal((a.match(/destinations\s*=\s*\[oci_ons_notification_topic\.alerts\.id\]/g) ?? []).length, 2);
});

test('the Terraform native tests and the multi-platform lock file exist', () => {
  const t = read('infra', 'terraform', 'oci', 'tests', 'network.tftest.hcl');
  assert.match(t, /mock_provider "oci"/);
  assert.match(t, /private_rules_sit_on_the_to_side/);
  const lock = read('infra', 'terraform', 'oci', '.terraform.lock.hcl');
  assert.ok((lock.match(/"h1:/g) ?? []).length >= 5 || (lock.match(/"zh:/g) ?? []).length >= 5, 'hashes for several platforms');
});