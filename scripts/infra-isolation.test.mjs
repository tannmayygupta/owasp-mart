// Tests for the labs host isolation (D-43 to D-45, ADR 0027): host scripts run against a stub iptables, IAM policy, backend files, compose lint, verify-hosts probes.
// No network, no credentials, no AWS. The host-script tests need a POSIX shell (Linux CI has one; on Windows Git for Windows' bash is used) and skip if none is found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkComposeText, findComposeFiles, checkFiles } from './check-lab-compose-rules.mjs';
import { verifyHosts, isolationCommand, ISOLATION_PY, BASELINE_FILES, localBaselineHashes } from './verify-hosts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const rules = () => JSON.parse(read('infra', 'network-rules.json'));
const aws = (f) => read('infra', 'terraform', 'aws', f);

function findShell() {
  const candidates = process.platform === 'win32'
    ? ['C:\\git\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash', '/bin/sh'];
  return candidates.find((c) => existsSync(c));
}
const SHELL = findShell();
const skip = SHELL ? false : 'no POSIX shell found: the host script tests were not run (static tests below still run)';

// A stateful stub iptables: -C answers from the state, -A/-I/-F/-N change it, every call is logged.
const STUB_IPTABLES = `#!/bin/sh
echo "iptables $*" >> "$STUB_LOG"
op="$1"; shift
state="$STUB_DIR/state"; touch "$state"
case "$op" in
  -C) chain="$1"; shift; if grep -Fxq -- "$chain $*" "$state"; then exit 0; else exit 1; fi ;;
  -A) chain="$1"; shift; echo "$chain $*" >> "$state" ;;
  -I) chain="$1"; shift; case "$1" in [0-9]*) shift ;; esac; { echo "$chain $*"; cat "$state"; } > "$state.new"; mv "$state.new" "$state" ;;
  -F) chain="$1"; grep -v "^$chain " "$state" > "$state.new" || true; mv "$state.new" "$state" ;;
  -N) chain="$1"; if grep -Fxq -- "CHAIN $chain" "$state"; then exit 1; fi; echo "CHAIN $chain" >> "$state" ;;
  -P) echo "POLICY $*" >> "$STUB_DIR/policy" ;;
  -n) if [ "$1" = "-L" ] && [ "$2" = "DOCKER-USER" ]; then [ "\${STUB_DOCKER_USER:-1}" = 1 ] && exit 0 || exit 1; fi
      if [ "$1" = "-L" ] && [ "$2" = "DOCKER" ]; then [ "\${STUB_DOCKER:-0}" = 1 ] && exit 0 || exit 1; fi
      exit 0 ;;
  -L) exit 0 ;;
  *) echo "stub iptables: unexpected $op $*" >&2; exit 9 ;;
esac
`;
const STUB_PERSIST = '#!/bin/sh\necho "netfilter-persistent $*" >> "$STUB_LOG"\n';

async function stubEnv(extra = {}) {
  const { mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vm-stub-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  for (const [n, body] of [['iptables', STUB_IPTABLES], ['netfilter-persistent', STUB_PERSIST]]) {
    writeFileSync(path.join(bin, n), body);
    chmodSync(path.join(bin, n), 0o755);
  }
  const fwd = (p) => p.replaceAll('\\', '/');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_DIR: fwd(dir), STUB_LOG: fwd(path.join(dir, 'log')), ...extra };
  const run = (script, ...args) => {
    const r = spawnSync(SHELL, [fwd(path.join(ROOT, 'infra', 'hosts', script)), ...args], { env, encoding: 'utf8' });
    return r;
  };
  const state = () => (existsSync(path.join(dir, 'state')) ? read2(path.join(dir, 'state')) : []);
  const log = () => (existsSync(path.join(dir, 'log')) ? read2(path.join(dir, 'log')) : []);
  const reset = () => rmSync(path.join(dir, 'log'), { force: true });
  return { dir, run, state, log, reset, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
const read2 = (f) => readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);

const LABS_ENV = {
  VPC_CIDR: '10.0.0.0/16', VPC_RESOLVER: '10.0.0.2', PLATFORM_SUBNET: '10.0.0.0/24', LABS_HOST_SUBNET: '10.0.1.0/24',
  LABS_DOCKER_SUBNETS: '172.17.0.0/16 172.30.0.0/16', INGEST_PORT: '9444', VULNMART_EGRESS_ENV: '/nonexistent',
};
const idx = (arr, needle) => arr.findIndex((l) => l.includes(needle));

test('egress script on the labs host: DOCKER-USER jump, allowlist order, final DROP, metadata and INPUT rules', { skip }, async () => {
  const s = await stubEnv({ ...LABS_ENV, HOST_PRIVATE_IP: '10.0.1.37' });
  try {
    const r = s.run('vulnmart-egress.sh');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const st = s.state();
    const chain = st.filter((l) => l.startsWith('VULNMART-LABS ')).map((l) => l.slice('VULNMART-LABS '.length));
    const at = (needle) => idx(chain, needle);
    assert.ok(at('--ctstate ESTABLISHED,RELATED -j RETURN') === 0, 'replies RETURN first');
    assert.ok(at('-p udp -d 10.0.0.2/32 --dport 53 -j ACCEPT') > 0 && at('-p tcp -d 10.0.0.2/32 --dport 53 -j ACCEPT') > 0);
    assert.ok(at('-p udp -d 169.254.169.123/32 --dport 123 -j ACCEPT') > 0);
    const ingest = at('-p tcp -d 10.0.0.0/24 --dport 9444 -j ACCEPT');
    const dropLink = at('-d 169.254.0.0/16 -j DROP');
    const dropVpc = at('-d 10.0.0.0/16 -j DROP');
    const dropHost = at('-d 10.0.1.37/32 -j DROP');
    const https = at('-p tcp --dport 443 -j ACCEPT');
    assert.ok(ingest > 0 && ingest < dropLink && dropLink < dropVpc && dropVpc < dropHost && dropHost < https, `order: ${chain.join(' | ')}`);
    assert.equal(chain.at(-1), '-j DROP', 'the final rule is DROP');
    assert.ok(!chain.some((l) => /--dport 80\b/.test(l)), 'no port 80 for containers');
    assert.ok(!chain.some((l) => /ACCEPT/.test(l) && !/--dport (53|123|9444|443)\b/.test(l)), 'only the allowlist is accepted');
    for (const sub of ['172.17.0.0/16', '172.30.0.0/16']) {
      assert.ok(st.includes(`DOCKER-USER -s ${sub} -j VULNMART-LABS`), `jump for ${sub}`);
      assert.ok(st.includes(`INPUT -s ${sub} -m conntrack --ctstate NEW -j DROP`), `INPUT drop for ${sub}`);
    }
    assert.ok(st.includes('OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j DROP'), 'metadata blocked for non-root');
    // Docker's own chains are never flushed or changed except by the one jump we add.
    const flushes = s.log().filter((l) => l.startsWith('iptables -F'));
    assert.deepEqual(flushes, ['iptables -F VULNMART-LABS']);
    assert.ok(!s.log().some((l) => /iptables -(X|P|D)\b/.test(l)), 'no delete, no policy change');
    assert.ok(!s.log().some((l) => /FORWARD/.test(l)), 'FORWARD is not touched');
  } finally { s.clean(); }
});

test('egress script is idempotent: a second run changes nothing and checks with -C before it inserts', { skip }, async () => {
  const s = await stubEnv({ ...LABS_ENV, HOST_PRIVATE_IP: '10.0.1.37' });
  try {
    assert.equal(s.run('vulnmart-egress.sh').status, 0);
    const first = s.state();
    s.reset();
    assert.equal(s.run('vulnmart-egress.sh').status, 0);
    assert.deepEqual(s.state(), first, 'state is identical after the second run');
    const log = s.log();
    assert.ok(!log.some((l) => /^iptables -I /.test(l)), 'the second run inserts nothing');
    assert.ok(log.some((l) => l.startsWith('iptables -C DOCKER-USER -s 172.17.0.0/16 -j VULNMART-LABS')), 'the jump is checked with -C');
    assert.ok(log.some((l) => l.startsWith('iptables -C OUTPUT -d 169.254.169.254/32')), 'the metadata rule is checked with -C');
  } finally { s.clean(); }
});

test('egress script on a host outside the labs subnet only blocks metadata for non-root; with no settings it does nothing', { skip }, async () => {
  const s = await stubEnv({ ...LABS_ENV, HOST_PRIVATE_IP: '10.0.0.5' });
  try {
    const r = s.run('vulnmart-egress.sh');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.state(), ['OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j DROP']);
  } finally { s.clean(); }
  const n = await stubEnv({ VULNMART_EGRESS_ENV: '/nonexistent', LABS_HOST_SUBNET: '' });
  try {
    assert.equal(n.run('vulnmart-egress.sh').status, 0);
    assert.deepEqual(n.log(), []);
  } finally { n.clean(); }
});

test('egress script fails clearly when Docker has not created DOCKER-USER yet', { skip }, async () => {
  const s = await stubEnv({ ...LABS_ENV, HOST_PRIVATE_IP: '10.0.1.37', STUB_DOCKER_USER: '0' });
  try {
    const r = s.run('vulnmart-egress.sh');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /DOCKER-USER chain does not exist/);
    assert.ok(!s.state().some((l) => l.startsWith('DOCKER-USER')), 'nothing was added to DOCKER-USER');
  } finally { s.clean(); }
});

test('firewall script: loopback and established first, ports allowed, policy DROP last, no flush, FORWARD untouched; save only without Docker', { skip }, async () => {
  const s = await stubEnv();
  try {
    const r = s.run('vulnmart-firewall.sh', '10.0.0.0/16');
    assert.equal(r.status, 0, r.stderr);
    const input = s.state().filter((l) => l.startsWith('INPUT ')).map((l) => l.slice(6));
    assert.equal(input[0], '-i lo -j ACCEPT');
    assert.equal(input[1], '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    for (const p of [22, 80, 443]) assert.ok(input.includes(`-p tcp --dport ${p} -m conntrack --ctstate NEW -j ACCEPT`), `port ${p}`);
    for (const p of [9443, 9444]) assert.ok(input.includes(`-p tcp -s 10.0.0.0/16 --dport ${p} -m conntrack --ctstate NEW -j ACCEPT`), `private port ${p}`);
    const calls = s.log().filter((l) => l.startsWith('iptables'));
    const last = calls.filter((l) => !/^iptables -n -L/.test(l)).at(-1);
    assert.equal(last, 'iptables -P INPUT DROP', 'the policy is the last change');
    assert.ok(!calls.some((l) => /^iptables -(F|X|D|Z)\b/.test(l)), 'no flush, delete or zero');
    assert.ok(!calls.some((l) => /FORWARD|DOCKER/.test(l) && !/-n -L DOCKER$/.test(l)), 'FORWARD and the Docker chains are not touched');
    assert.ok(s.log().includes('netfilter-persistent save'), 'saved on a host without Docker');
    // A second run adds nothing.
    const first = s.state();
    s.reset();
    assert.equal(s.run('vulnmart-firewall.sh', '10.0.0.0/16').status, 0);
    assert.deepEqual(s.state(), first);
  } finally { s.clean(); }
  const d = await stubEnv({ STUB_DOCKER: '1' });
  try {
    const r = d.run('vulnmart-firewall.sh', '10.0.0.0/16');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!d.log().includes('netfilter-persistent save'), 'not saved on a Docker host');
    assert.match(r.stderr, /NOT saved/);
  } finally { d.clean(); }
});

test('host files: LF endings, the unit starts after Docker and reruns when Docker restarts, daemon pool matches the rule file', () => {
  for (const f of ['vulnmart-egress.sh', 'vulnmart-egress.service', 'vulnmart-firewall.sh', 'vulnmart-baseline.sh', 'docker-daemon.json']) assert.ok(!read('infra', 'hosts', f).includes('\r'), `${f} must use LF`);
  assert.ok(!read('infra', 'terraform', 'aws', 'bootstrap-state-bucket.sh').includes('\r'));
  const unit = read('infra', 'hosts', 'vulnmart-egress.service');
  assert.match(unit, /^After=docker\.service/m);
  assert.match(unit, /^Requires=docker\.service/m);
  assert.match(unit, /^PartOf=docker\.service/m);
  assert.match(unit, /^Type=oneshot/m);
  assert.match(unit, /^RemainAfterExit=yes/m);
  assert.match(unit, /^WantedBy=multi-user\.target/m);
  const daemon = JSON.parse(read('infra', 'hosts', 'docker-daemon.json'));
  assert.deepEqual(daemon['default-address-pools'], [{ base: '172.30.0.0/16', size: 24 }]);
  assert.ok(rules().labs_docker_subnets.includes('172.30.0.0/16'), 'the pool is one of the labs subnets the egress rules cover');
  const sh = read('infra', 'hosts', 'vulnmart-egress.sh');
  assert.ok(!/iptables -F (DOCKER|FORWARD|INPUT|OUTPUT)/.test(sh) && !/iptables -X/.test(sh), 'never flush a Docker or system chain');
  assert.match(sh, /root or privileged container/);
  assert.ok(!/--dport 80\b/.test(sh), 'no port 80 for containers');
  const fw = read('infra', 'hosts', 'vulnmart-firewall.sh');
  assert.ok(!/iptables -(F|X)\b/.test(fw.replace(/^#.*$/gm, '')), 'the firewall script never flushes');
  assert.match(fw, /iptables -P INPUT DROP/);
  const b = read('infra', 'hosts', 'vulnmart-baseline.sh');
  assert.match(b, /STEP=egress;\s+systemctl daemon-reload && systemctl enable --now vulnmart-egress\.service/);
  assert.ok(b.indexOf('STEP=docker;') < b.indexOf('STEP=egress;'), 'egress rules come after Docker is installed');
});

test('cloud-init template renders to valid YAML and writes the egress files', async () => {
  const text = read('infra', 'hosts', 'cloud-init.yaml.tftpl').replace(/\$\{[a-z_]+\}/g, 'x');
  assert.match(text, /\/usr\/local\/sbin\/vulnmart-egress\.sh/);
  assert.match(text, /\/etc\/systemd\/system\/vulnmart-egress\.service/);
  assert.match(text, /\/etc\/vulnmart\/egress\.env/);
  let yaml;
  try { yaml = (await import('js-yaml')).default; } catch { yaml = null; }
  if (!yaml) return; // js-yaml is a dev dependency of the repository; skipped where it is not installed
  const doc = yaml.load(text);
  assert.ok(Array.isArray(doc.write_files) && doc.write_files.every((f) => f.path && f.content));
  assert.equal(doc.write_files.filter((f) => f.path.includes('keepalive')).length, 2);
});

test('network: two subnets with their own route tables and ACLs, egress allowlist, no all-protocol egress, no NAT', () => {
  const n = aws('network.tf');
  assert.match(n, /resource "aws_subnet" "p"/);
  assert.match(n, /resource "aws_subnet" "i"/);
  assert.match(n, /resource "aws_route_table" "p"/);
  assert.match(n, /resource "aws_route_table" "i"/);
  assert.match(n, /resource "aws_network_acl" "main"/);
  assert.ok(!/ip_protocol\s*=\s*"-1"/.test(n), 'no security group rule with protocol -1');
  assert.ok(!/aws_nat_gateway/.test(n));
  assert.match(n, /referenced_security_group_id\s*=\s*aws_security_group\.vm\[each\.value\.to\]\.id/);
  assert.match(n, /number = 150, action = "deny", protocol = "-1", cidr = local\.rules\.vcn_cidr/);
  const r = rules();
  assert.notEqual(r.subnet_p_cidr, r.subnet_i_cidr);
  assert.ok(!aws('compute.tf').includes('iam_instance_profile'), 'no instance profile');
  assert.match(aws('compute.tf'), /http_put_response_hop_limit\s*=\s*1\b/);
  assert.match(aws('compute.tf'), /http_tokens\s*=\s*"required"/);
});

test('D-44 IAM policy: no ModifyInstanceAttribute allow, an explicit RunInstances deny for other instance types, no real account id', () => {
  const pol = JSON.parse(aws('iam-policy.json'));
  const allows = pol.Statement.filter((s) => s.Effect === 'Allow');
  for (const s of allows) assert.ok(![].concat(s.Action).includes('ec2:ModifyInstanceAttribute'), `${s.Sid} must not allow ModifyInstanceAttribute`);
  assert.ok(!JSON.stringify(pol).includes('ModifyInstanceAttribute') || pol.Statement.some((s) => s.Effect === 'Deny'), 'only a Deny may name it');
  const deny = pol.Statement.find((s) => s.Effect === 'Deny' && [].concat(s.Action).includes('ec2:RunInstances'));
  assert.ok(deny, 'an explicit Deny of RunInstances exists');
  assert.equal(deny.Resource, 'arn:aws:ec2:ap-southeast-2:*:instance/*');
  const types = deny.Condition.StringNotEquals['ec2:InstanceType'];
  const variable = read('infra', 'terraform', 'aws', 'variables.tf').match(/contains\(\[([^\]]*)\], t\)/)[1].match(/"([^"]+)"/g).map((x) => x.replaceAll('"', ''));
  assert.deepEqual(types, variable, 'the deny list equals the variable list');
  assert.ok(types.includes('t3.small') && types.includes('m7i-flex.large'), 'both default types are allowed');
  const allowsRun = allows.find((s) => s.Condition?.StringEquals?.['ec2:InstanceType']);
  assert.deepEqual(allowsRun.Condition.StringEquals['ec2:InstanceType'], types);
  for (const a of ['ec2:CreateNetworkAcl', 'ec2:DeleteNetworkAcl', 'ec2:CreateNetworkAclEntry', 'ec2:DeleteNetworkAclEntry', 'ec2:ReplaceNetworkAclEntry', 'ec2:ReplaceNetworkAclAssociation']) {
    assert.ok(allows.some((s) => [].concat(s.Action).includes(a)), `${a} is granted (the ACLs are Terraform resources)`);
  }
  // Terraform state bucket (D-45): the named bucket only, placeholder name, no wildcard bucket.
  const s3 = pol.Statement.filter((s) => [].concat(s.Action).some((a) => a.startsWith('s3:')));
  assert.ok(s3.length >= 2);
  for (const s of s3) {
    for (const res of [].concat(s.Resource)) assert.match(res, /^arn:aws:s3:::vulnmart-tfstate-[A-Za-z0-9-]+(\/\*)?$/, `${s.Sid} names the one state bucket`);
  }
  const objects = s3.find((s) => s.Sid === 'TerraformStateObjects');
  assert.deepEqual([].concat(objects.Action).sort(), ['s3:DeleteObject', 's3:GetObject', 's3:PutObject']);
  assert.ok(!/\b\d{12}\b/.test(JSON.stringify(pol)), 'no account id');
  assert.ok(!s3.some((s) => [].concat(s.Action).includes('s3:*')));
});

test('D-45 state: backend example uses partial config, backend.hcl is git-ignored, version floor allows S3 locking, bootstrap never overwrites and is not run by tests', () => {
  assert.match(aws('backend.tf.example'), /backend "s3" \{\}/);
  assert.ok(!existsSync(path.join(ROOT, 'infra', 'terraform', 'aws', 'backend.tf')), 'backend.tf stays an example until the developer migrates (init -backend=false and the local state keep working)');
  const hcl = aws('backend.hcl.example');
  assert.match(hcl, /^encrypt\s*=\s*true/m);
  assert.match(hcl, /^use_lockfile\s*=\s*true/m);
  assert.match(hcl, /^region\s*=\s*"ap-southeast-2"/m);
  assert.match(hcl, /REPLACE-WITH-YOUR-BUCKET/);
  assert.ok(!/\b\d{12}\b/.test(hcl));
  assert.match(aws('.gitignore'), /^backend\.hcl$/m);
  assert.match(aws('versions.tf'), /required_version\s*=\s*">= 1\.11\.0, < 2\.0\.0"/);
  const ci = read('.github', 'workflows', 'ci.yml');
  const pinned = /terraform[^\n]*?(\d+)\.(\d+)\.(\d+)/i.exec(ci);
  if (pinned) assert.ok(Number(pinned[1]) > 1 || Number(pinned[2]) >= 11, `CI pins Terraform ${pinned[0]}: it must be 1.11 or newer`);
  const boot = aws('bootstrap-state-bucket.sh');
  assert.match(boot, /put-bucket-versioning/);
  assert.match(boot, /AES256/);
  assert.match(boot, /BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true/);
  assert.ok(!/delete-bucket|\brm\s|--force/.test(boot), 'the bootstrap never deletes or overwrites');
});

test('lab compose lint: the committed compose and harness files pass; every banned right fails with its line', () => {
  const files = findComposeFiles([path.join(ROOT, 'infra')]);
  assert.ok(files.length >= 2);
  assert.deepEqual(checkFiles(files), []);
  const bad = (yml) => checkComposeText(yml, 'x.yaml');
  assert.match(bad('services:\n  a:\n    privileged: true\n')[0], /x\.yaml:3: privileged: true/);
  assert.equal(bad('services:\n  a:\n    privileged: false\n').length, 0);
  assert.equal(bad('# privileged: true is banned\nservices: {}\n').length, 0, 'comments do not count');
  assert.match(bad('services:\n  a:\n    network_mode: host\n')[0], /network_mode: host/);
  assert.equal(bad('services:\n  a:\n    network_mode: none\n').length, 0);
  assert.match(bad('services:\n  a:\n    pid: "host"\n')[0], /pid: host/);
  assert.match(bad('services:\n  a:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n')[0], /Docker socket/);
  assert.match(bad('services:\n  a:\n    volumes:\n      - { type: bind, source: /var/run/docker.sock, target: /s }\n')[0], /Docker socket/);
  assert.match(bad('services:\n  a:\n    cap_add:\n      - NET_ADMIN\n')[0], /cap_add NET_ADMIN/);
  assert.match(bad('services:\n  a:\n    cap_add: [CAP_SYS_ADMIN, CHOWN]\n')[0], /cap_add SYS_ADMIN/);
  assert.equal(bad('services:\n  a:\n    cap_add:\n      - CHOWN\n    cap_drop:\n      - ALL\n').length, 0, 'cap_drop ALL is the good pattern');
  assert.match(bad('services:\n  a:\n    security_opt:\n      - seccomp:unconfined\n')[0], /unconfined/);
});

test('verify-hosts isolation probes: containers cannot reach metadata or vm-p:443, can reach the ingest port; the root host-network probe is information only', async () => {
  const cmd = isolationCommand('10.0.0.5', 9444, '10.0.1.7');
  assert.match(cmd, /docker run --rm\s+python:3\.12-alpine@sha256:/, 'a bridge container, image pinned by digest');
  assert.match(cmd, /--network host --user 65534:65534/);
  assert.match(cmd, /docker run --rm --network host python/);
  assert.match(ISOLATION_PY, /169\.254\.169\.254/);
  assert.match(ISOLATION_PY, /,3\)/, 'a 3 second limit like curl -m3');
  const hosts = { 'vm-p': { pub: '203.0.113.10', priv: '10.0.0.5' }, 'vm-i': { pub: '203.0.113.11', priv: '10.0.1.7' } };
  const out = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const GOOD = { bridge_imds: 'timeout', bridge_vmp443: 'timeout', bridge_vmp9444: 'refused', bridge_self22: 'timeout', bridge_internet443: 'open', hostnet_user_imds: 'timeout', hostnet_user_vmp443: 'timeout', hostnet_user_vmp9444: 'open', hostnet_root_imds: 'open', hostnet_root_vmp443: 'timeout' };
  const run = async (probe) => {
    const calls = [];
    const ssh = async (a) => {
      const c = a.command ?? '';
      calls.push(c);
      if (a.user === 'root') return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
      if (a.options?.includes('PubkeyAuthentication=no')) return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
      if (c.startsWith('set -o pipefail')) return { code: 0, stdout: 'os=24.04\narch=x86_64\nmarker=ok\ncloudinit=status:_done\nkeepalive=inactive\nsshd=authenticationmethods:publickey,kbdinteractiveauthentication:no,passwordauthentication:no,permitrootlogin:no,\nsecrets=700:root\ndocker=Docker_version_27\n', stderr: '' };
      if (c.includes('download.docker.com')) return { code: 0, stdout: out(probe), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const checks = await verifyHosts({ hosts, rules: rules(), tcpProbe: async () => 'timeout', ssh, identity: 'k', localHashes: localBaselineHashes(), checkMetadata: false, checkIsolation: true });
    return { checks, calls };
  };
  const good = await run(GOOD);
  const iso = good.checks.filter((c) => /bridge container|host-network container|host itself/.test(c.name));
  assert.equal(iso.length, 9);
  assert.deepEqual(iso.filter((c) => !c.ok).map((c) => c.name), []);
  assert.ok(good.checks.some((c) => c.name.includes('a ROOT host-network container CAN reach instance metadata') && c.warn), 'a reachable root host-network probe is reported as a warning, not hidden');
  assert.ok(good.calls.filter((c) => c.includes('docker run')).length >= 1);
  assert.ok(!good.checks.some((c) => c.name.startsWith('vm-p') && /bridge container/.test(c.name)), 'probes run on the labs host only');
  const failing = (over) => run({ ...GOOD, ...over }).then((r) => r.checks.filter((c) => !c.ok && /bridge container|host-network|host itself/.test(c.name)).map((c) => c.name));
  assert.equal((await failing({ bridge_imds: 'open' })).length, 1);
  assert.equal((await failing({ bridge_vmp443: 'open' })).length, 1);
  assert.equal((await failing({ hostnet_user_vmp443: 'open' })).length, 1);
  assert.equal((await failing({ bridge_vmp9444: 'timeout' })).length, 1);
  assert.equal((await failing({ hostnet_user_imds: 'open' })).length, 1);
  assert.equal((await failing({ bridge_internet443: 'timeout' })).length, 1);
  assert.deepEqual(BASELINE_FILES.filter((f) => f.remote.includes('egress')).map((f) => f.local), ['infra/hosts/vulnmart-egress.sh', 'infra/hosts/vulnmart-egress.service']);
});