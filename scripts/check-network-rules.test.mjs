// Policy test for the firewall rule data, plus static checks of the Terraform and host files (no credentials, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
  assert.deepEqual(checkTerraformReadsRules(read('infra', 'terraform', 'aws', 'network.tf')), []);
  assert.ok(checkTerraformReadsRules('from_port = 8080\n').length > 0);
  assert.ok(checkTerraformReadsRules('min = 8080\n').length > 0);
});

test('both VMs get the same cloud-init and the same shape from one resource', () => {
  const tf = read('infra', 'terraform', 'oci', 'compute.tf');
  assert.equal((tf.match(/resource "oci_core_instance"/g) ?? []).length, 1);
  assert.match(tf, /for_each\s*=\s*toset\(local\.vm_names\)/);
  assert.match(tf, /VM\.Standard\.A1\.Flex/);
  assert.match(tf, /Canonical Ubuntu/);
  assert.match(tf, /operating_system_version\s*=\s*"24\.04"/);
  assert.equal((tf.match(/^\s*user_data\s*=\s*local\.user_data$/gm) ?? []).length, 1);
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
  assert.match(c, /runcmd:\n\s+- \[\/usr\/local\/sbin\/vulnmart-baseline\.sh, "\$\{private_cidr\}", "\$\{keepalive_enabled\}"\]/);
  for (const needle of ['00-vulnmart.conf', 'vulnmart-firewall.sh', 'vulnmart-install-docker.sh', 'vulnmart-keepalive.service', '/etc/docker/daemon.json', 'unattended-upgrades', 'timesyncd', 'ssh_authorized_keys']) assert.ok(c.includes(needle), needle);
  const b = read('infra', 'hosts', 'vulnmart-baseline.sh');
  assert.match(b, /^set -eu$/m);
  assert.match(b, /baseline-ok/);
  assert.match(b, /baseline-failed/);
  assert.match(b, /step=\$STEP/);
  const steps = [...b.matchAll(/^STEP=([a-z-]+);[ \t]+.*$/gm)].map((m) => m[1]);
  assert.deepEqual(steps, ['lock-root', 'sshd-config-test', 'restart-ssh', 'firewall', 'docker', 'secrets-dir', 'time-sync', 'keepalive', 'unattended-upgrades']);
  assert.match(b, /passwd -l root/);
  assert.match(b, /install -d -m 0700 -o root -g root \/opt\/vulnmart \/opt\/vulnmart\/secrets/);
  assert.match(b, /install -d -m 0755 \/run\/sshd && sshd -t/, "sshd -t needs /run/sshd, which is missing before the first ssh start on Ubuntu 24.04");
  assert.match(b, /systemd-timesyncd\.service[\s\S]*chrony\.service[\s\S]*no time sync service/, "time-sync must handle chrony (AWS Ubuntu image) as well as systemd-timesyncd and fail when neither exists");
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
// ---- AWS (story 2.6) ----
const aws = (...p) => read('infra', 'terraform', 'aws', ...p);
const ELIGIBLE = ['t3.micro', 't3.small', 't4g.micro', 't4g.small', 'c7i-flex.large', 'm7i-flex.large'];

test('aws: the provider is pinned, the lock file covers several platforms and the region is Sydney only', () => {
  assert.match(aws('versions.tf'), /version\s*=\s*"~> 6\.68"/);
  assert.match(aws('versions.tf'), /required_version/);
  const lock = aws('.terraform.lock.hcl');
  assert.match(lock, /registry\.terraform\.io\/hashicorp\/aws/);
  assert.ok((lock.match(/"h1:/g) ?? []).length >= 5, 'hashes for several platforms');
  assert.match(aws('variables.tf'), /default\s*=\s*"ap-southeast-2"/);
  assert.match(aws('variables.tf'), /var\.region == "ap-southeast-2"/);
});

test('aws: credentials are not variables, ssh and email inputs have no default, ssh cannot be opened to the world', () => {
  const v = aws('variables.tf');
  assert.ok(!/access_key|secret_key|account_id/i.test(v + aws('versions.tf')), 'no credential variable');
  for (const name of ['ssh_source_cidrs', 'ssh_public_keys', 'budget_email']) {
    const block = v.split(`variable "${name}"`)[1].split(/^variable /m)[0];
    assert.ok(!/^\s*default\s*=/m.test(block), `${name} has no default`);
  }
  assert.match(v, /!contains\(var\.ssh_source_cidrs, "0\.0\.0\.0\/0"\)/);
  assert.match(v, />= 16/);
  assert.match(v, /distinct\(var\.ssh_source_cidrs\)/);
});

test('aws: the eligible instance type list in the variable check matches the Free Plan list, and the defaults are on it', () => {
  const v = aws('variables.tf');
  const listed = v.match(/contains\(\[([^\]]*)\], t\)/)[1].match(/"([^"]+)"/g).map((s) => s.replaceAll('"', ''));
  assert.deepEqual(listed, ELIGIBLE);
  const def = v.split('variable "instance_types"')[1].split(/^variable /m)[0];
  for (const t of [...def.matchAll(/=\s*"([a-z0-9.-]+)"/g)].map((m) => m[1]).filter((x) => x.includes('.'))) assert.ok(ELIGIBLE.includes(t), t);
});

test('aws: one instance resource for both hosts, IMDSv2 required with hop limit 1, no instance profile, no NAT gateway', () => {
  const tf = aws('compute.tf');
  assert.equal((tf.match(/resource "aws_instance"/g) ?? []).length, 1);
  assert.match(tf, /for_each\s*=\s*toset\(local\.vm_names\)/);
  assert.match(tf, /http_tokens\s*=\s*"required"/);
  assert.match(tf, /http_put_response_hop_limit\s*=\s*1\b/);
  assert.ok(!/iam_instance_profile/.test(tf), 'hosts carry no instance profile');
  assert.equal((tf.match(/^\s*user_data\s*=\s*local\.user_data$/gm) ?? []).length, 1);
  assert.match(tf, /\/aws\/service\/canonical\/ubuntu\/server\/24\.04\/stable\/current\//);
  assert.match(tf, /ignore_changes = \[ami, user_data, key_name\]/);
  assert.match(tf, /resource "aws_eip" "vm"/);
  assert.ok(!/aws_nat_gateway/.test(aws('network.tf') + tf), 'a NAT gateway costs about USD 0.045 per hour');
});

test('aws: the budget alerts exist and e-mail the owner; outputs are sensitive', () => {
  const b = aws('budget.tf');
  assert.match(b, /resource "aws_budgets_budget" "zero_spend"/);
  assert.match(b, /resource "aws_budgets_budget" "monthly_use"/);
  assert.match(b, /time_unit\s*=\s*"MONTHLY"/);
  assert.ok(!/ANNUALLY/.test(b), 'no annual budget');
  assert.match(b, /for_each\s*=\s*\[50, 80, 100\]/);
  assert.match(b, /subscriber_email_addresses = \[var\.budget_email\]/);
  const o = aws('outputs.tf');
  assert.equal((o.match(/sensitive\s*=\s*true/g) ?? []).length, 4);
});

test('aws: the git-ignore keeps variable files, state, plans and the address file out', () => {
  const g = aws('.gitignore');
  for (const p of ['*.tfvars', '*.tfstate', 'hosts.local.json', 'tfplan*', '.terraform/']) assert.ok(g.includes(p), p);
  assert.ok(g.includes('!terraform.tfvars.example'));
});

test('aws: the IAM policy for the Terraform user is valid, region-limited, and grants no wildcard service or IAM', () => {
  const pol = JSON.parse(aws('iam-policy.json'));
  const all = pol.Statement.flatMap((s) => [].concat(s.Action));
  assert.ok(all.length > 20);
  assert.ok(!all.some((a) => a === '*' || /^[a-z0-9]+:\*$/i.test(a)), 'no service-wide wildcard');
  assert.ok(!all.some((a) => a.startsWith('iam:') || a.startsWith('organizations:') || a.startsWith('controltower:')), 'no IAM, Organizations or Control Tower');
  for (const a of ['ec2:RunInstances', 'ec2:AllocateAddress', 'ec2:ModifySecurityGroupRules', 'budgets:ModifyBudget', 'ssm:GetParameter']) assert.ok(all.includes(a), a);
  const mut = pol.Statement.find((s) => s.Sid.startsWith('ManageVulnMartEc2'));
  assert.equal(mut.Condition.StringEquals['aws:RequestedRegion'], 'ap-southeast-2');
  assert.ok(!/\d{12}/.test(aws('iam-policy.json')), 'no account id');
});

test('aws: the example variable file has placeholders only', () => {
  const ex = aws('terraform.tfvars.example');
  assert.match(ex, /PASTE-YOUR-ADDRESS/);
  assert.match(ex, /AAAA\.\.\./);
  assert.ok(!/AKIA|aws_secret|access_key/i.test(ex));
});

test('aws: the Terraform native tests use a mocked provider and check wiring, IMDSv2 and instance types', () => {
  const t = aws('tests', 'network.tftest.hcl');
  assert.match(t, /mock_provider "aws"/);
  for (const n of ['private_rules_sit_on_the_to_side', 'hosts_use_imdsv2', 'ineligible_instance_type_is_refused', 'public_ingress_is_22_80_443_only']) assert.ok(t.includes(n), n);
});

test('the rule file lives in one place that both Terraform folders read', () => {
  assert.match(read('infra', 'terraform', 'oci', 'network.tf'), /network-rules\.json/);
  assert.match(aws('network.tf'), /\.\.\/\.\.\/network-rules\.json/);
  assert.ok(!existsSync(path.join(ROOT, 'infra', 'terraform', 'oci', 'network-rules.json')));
  assert.ok(!existsSync(path.join(ROOT, 'infra', 'terraform', 'aws', 'network-rules.json')));
});

test('baseline: the keep-alive step follows a flag and is off by default', () => {
  const b = read('infra', 'hosts', 'vulnmart-baseline.sh');
  assert.match(b, /KEEPALIVE="\$\{2:-no\}"/);
  assert.match(b, /\[ "\$KEEPALIVE" = yes \]/);
});

// ---- review fixes, batch 1 ----
const POLICY = () => JSON.parse(aws('iam-policy.json'));
const policyActions = () => POLICY().Statement.flatMap((s) => [].concat(s.Action));

// What each resource and data source of the configuration needs from IAM (the provider's calls, to be confirmed by the first plan).
const NEEDS = {
  aws_vpc: ['ec2:CreateVpc', 'ec2:DeleteVpc', 'ec2:ModifyVpcAttribute', 'ec2:DescribeVpcs', 'ec2:CreateTags'],
  aws_internet_gateway: ['ec2:CreateInternetGateway', 'ec2:DeleteInternetGateway', 'ec2:AttachInternetGateway', 'ec2:DetachInternetGateway'],
  aws_subnet: ['ec2:CreateSubnet', 'ec2:DeleteSubnet', 'ec2:ModifySubnetAttribute'],
  aws_route_table: ['ec2:CreateRouteTable', 'ec2:DeleteRouteTable', 'ec2:CreateRoute', 'ec2:DeleteRoute', 'ec2:ReplaceRoute'],
  aws_route_table_association: ['ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable'],
  aws_default_security_group: ['ec2:RevokeSecurityGroupIngress', 'ec2:RevokeSecurityGroupEgress'],
  aws_security_group: ['ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup'],
  aws_vpc_security_group_ingress_rule: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress', 'ec2:ModifySecurityGroupRules', 'ec2:UpdateSecurityGroupRuleDescriptionsIngress'],
  aws_vpc_security_group_egress_rule: ['ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress', 'ec2:UpdateSecurityGroupRuleDescriptionsEgress'],
  aws_key_pair: ['ec2:ImportKeyPair', 'ec2:DeleteKeyPair', 'ec2:CreateTags'],
  aws_instance: ['ec2:RunInstances', 'ec2:TerminateInstances', 'ec2:ModifyInstanceAttribute', 'ec2:ModifyInstanceMetadataOptions', 'ec2:CreateTags'],
  aws_ec2_instance_state: ['ec2:StartInstances', 'ec2:StopInstances'],
  aws_eip: ['ec2:AllocateAddress', 'ec2:ReleaseAddress', 'ec2:AssociateAddress', 'ec2:DisassociateAddress', 'ec2:CreateTags', 'ec2:DeleteTags'],
  aws_budgets_budget: ['budgets:ViewBudget', 'budgets:ModifyBudget', 'budgets:TagResource', 'budgets:UntagResource', 'budgets:ListTagsForResource'],
  aws_ssm_parameter: ['ssm:GetParameter'],
};

test('aws: every resource type of the configuration has its actions in the IAM policy, and every resource type used is in the table', () => {
  const tf = ['network.tf', 'compute.tf', 'budget.tf'].map((n) => aws(n)).join('\n');
  const types = new Set([...tf.matchAll(/^(?:resource|data) "(aws_[a-z0-9_]+)"/gm)].map((m) => m[1]));
  const have = new Set(policyActions());
  for (const type of types) {
    assert.ok(NEEDS[type], `resource type ${type} is not in the IAM needs table: add it and its actions to the table and to iam-policy.json`);
    for (const action of NEEDS[type]) assert.ok(have.has(action) || (action.startsWith('ec2:Describe') && have.has('ec2:Describe*')), `${type} needs ${action}`);
  }
  assert.ok(have.has('ec2:Describe*'), 'refresh calls the describe actions');
  const tagged = /default_tags/.test(aws('versions.tf'));
  if (tagged) for (const a of ['budgets:TagResource', 'budgets:UntagResource', 'budgets:ListTagsForResource', 'ec2:CreateTags', 'ec2:DeleteTags']) assert.ok(have.has(a), `default_tags need ${a}`);
});

test('aws: RunInstances is limited to the eligible instance types by an ec2:InstanceType condition that equals the variable list', () => {
  const pol = POLICY();
  const v = aws('variables.tf');
  const eligible = v.match(/contains\(\[([^\]]*)\], t\)/)[1].match(/"([^"]+)"/g).map((s) => s.replaceAll('"', ''));
  const runs = pol.Statement.filter((s) => [].concat(s.Action).includes('ec2:RunInstances'));
  const typed = runs.filter((s) => s.Condition?.StringEquals?.['ec2:InstanceType']);
  assert.equal(typed.length, 1, 'one RunInstances statement carries the instance type condition');
  assert.deepEqual(typed[0].Condition.StringEquals['ec2:InstanceType'], eligible);
  assert.match(typed[0].Resource, /:instance\/\*$/);
  assert.equal(typed[0].Condition.StringEquals['aws:RequestedRegion'], 'ap-southeast-2');
  for (const s of runs) assert.equal(s.Condition.StringEquals['aws:RequestedRegion'], 'ap-southeast-2');
  assert.ok(!pol.Statement.some((s) => !runs.includes(s) && [].concat(s.Action).includes('ec2:RunInstances')));
});

test('rule file: 80 and 443 use the web token, a literal 0.0.0.0/0 there fails, the web token on another port fails, duplicate names fail', () => {
  const r = rules();
  for (const p of [80, 443]) assert.deepEqual(r.public_ingress.find((x) => x.port === p).sources, ['$public_web_cidrs']);
  const open = rules();
  open.public_ingress.find((x) => x.port === 80).sources = ['0.0.0.0/0'];
  assert.ok(checkRules(open).some((p) => p.includes('port 80 sources must be exactly')));
  const wrong = rules();
  wrong.public_ingress.push({ name: 'x', protocol: 'tcp', port: 22, sources: ['$ssh_source_cidrs', '$public_web_cidrs'] });
  assert.ok(checkRules(wrong).some((p) => p.includes('web source token is only for ports 80 and 443')));
  const dup = rules();
  dup.icmp_ingress.push({ name: 'ssh', type: 3, code: 4 });
  assert.ok(checkRules(dup).some((p) => p.includes('duplicate name')));
});

test('terraform static check: 0.0.0.0/0 and ::/0 are allowed only in egress, ICMP and default-route blocks', () => {
  const head = 'x = jsondecode(file("${path.module}/../../network-rules.json"))\n';
  const ingress = `${head}resource "aws_vpc_security_group_ingress_rule" "public" {\n  cidr_ipv4 = "0.0.0.0/0"\n}\n`;
  assert.ok(checkTerraformReadsRules(ingress).some((p) => p.includes('literal 0.0.0.0/0')));
  const v6 = `${head}resource "aws_vpc_security_group_ingress_rule" "public" {\n  cidr_ipv6 = "::/0"\n}\n`;
  assert.ok(checkTerraformReadsRules(v6).some((p) => p.includes('literal ::/0')));
  const egress = `${head}resource "aws_vpc_security_group_egress_rule" "all" {\n  cidr_ipv4 = "0.0.0.0/0"\n}\nresource "aws_vpc_security_group_ingress_rule" "icmp" {\n  cidr_ipv4 = "0.0.0.0/0"\n}\nresource "aws_route_table" "main" {\n  route {\n    cidr_block = "0.0.0.0/0"\n  }\n}\n`;
  assert.deepEqual(checkTerraformReadsRules(egress), []);
  assert.deepEqual(checkTerraformReadsRules(read('infra', 'terraform', 'oci', 'network.tf')), []);
});

test('aws variables: an IPv4 source is required, CIDRs must be canonical, public_web_cidrs defaults to the SSH list, credit and budget limits, key pair prefix', () => {
  const v = aws('variables.tf');
  assert.match(v, /anytrue\(\[for c in var\.ssh_source_cidrs : !strcontains\(c, ":"\)\]\)/);
  assert.match(v, /cidrsubnet\(c, 0, 0\) == c/);
  const web = v.split('variable "public_web_cidrs"')[1].split(/^variable /m)[0];
  assert.match(web, /default\s*=\s*null/);
  assert.match(aws('network.tf'), /var\.public_web_cidrs == null \? var\.ssh_source_cidrs : var\.public_web_cidrs/);
  assert.match(v, /variable "credit_total_usd"[\s\S]*?default\s*=\s*120/);
  assert.match(v, /var\.credit_total_usd > 0/);
  assert.match(v, /variable "monthly_budget_usd"[\s\S]*?default\s*=\s*60/);
  assert.match(v, /AWS Free Tier EC2 page/);
  assert.match(v, /edit this list/);
  const c = aws('compute.tf');
  assert.match(c, /key_name_prefix\s*=\s*"vulnmart-"/);
  assert.match(c, /sort\(var\.ssh_public_keys\)\[0\]/);
  assert.match(c, /local\.user_data_bytes <= 16384/);
  assert.match(c, /textencodebase64\(/);
  assert.match(c, /resource "aws_ec2_instance_state" "vm_i"/);
  assert.match(v, /variable "vm_i_running"[\s\S]*?default\s*=\s*true/);
  assert.match(aws('network.tf'), /"\$\{r\.name\}-\$\{r\.port\}-\$\{r\.source\}"/);
});

test('oci option: compute.tf still passes keepalive "yes" and its own NTP address, and tokens expand through variables', () => {
  const c = read('infra', 'terraform', 'oci', 'compute.tf');
  assert.match(c, /keepalive_enabled\s*=\s*"yes"/);
  assert.match(c, /ntp_server\s*=\s*"169\.254\.169\.254"/);
  assert.match(c, /ssh_keys_json\s*=\s*jsonencode\(\[\]\)/);
  assert.match(read('infra', 'terraform', 'oci', 'network.tf'), /\$public_web_cidrs/);
});
test('aws: every resource carries the Project=vulnmart tag (default tags and root volume tags) so leftovers can be found by tag', () => {
  assert.match(aws('versions.tf'), /default_tags[\s\S]*Project\s*=\s*"vulnmart"/);
  assert.match(aws('compute.tf'), /volume_tags\s*=\s*\{\s*Project\s*=\s*"vulnmart"\s*\}/);
  assert.match(read('docs', 'runbooks', 'aws-account-and-vms.md'), /tag:Project,Values=vulnmart/);
});
