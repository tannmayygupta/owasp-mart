// Live check of the two Oracle hosts, run by the developer after `terraform apply` (runbook Part C).
// From outside: only 22, 80 and 443 respond. Over ssh: key login works, password and root login are refused,
// the host firewall has each rule, the baseline marker says ok, and every baseline file on each host has the same
// hash as the file in this repository (this also detects drift, because Terraform ignores later startup-file changes).
// Usage: node scripts/verify-hosts.mjs --identity <ssh-private-key-path> [--hosts <file>] [--user ubuntu]
//        [--evidence <file>] [--require-listener]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHosts, redact, tcpProbe as realProbe, sshRun, parseKeyValues, printChecks, parseArgs } from './oracle-hosts.mjs';
import { RULES_FILE } from './check-network-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLOSED_PORTS = [21, 23, 25, 53, 111, 2375, 2376, 3000, 3306, 5432, 6379, 8080, 8443, 9000, 9443, 9444];

// Every repository file that cloud-init writes to a host (cloud-init.yaml.tftpl, same order of meaning).
export const BASELINE_FILES = [
  { local: 'infra/hosts/sshd-hardening.conf', remote: '/etc/ssh/sshd_config.d/00-vulnmart.conf' },
  { local: 'infra/hosts/vulnmart-firewall.sh', remote: '/usr/local/sbin/vulnmart-firewall.sh' },
  { local: 'infra/hosts/vulnmart-install-docker.sh', remote: '/usr/local/sbin/vulnmart-install-docker.sh' },
  { local: 'infra/hosts/vulnmart-baseline.sh', remote: '/usr/local/sbin/vulnmart-baseline.sh' },
  { local: 'infra/hosts/docker-daemon.json', remote: '/etc/docker/daemon.json' },
  { local: 'infra/hosts/vulnmart-keepalive.py', remote: '/usr/local/sbin/vulnmart-keepalive.py' },
  { local: 'infra/hosts/vulnmart-keepalive.service', remote: '/etc/systemd/system/vulnmart-keepalive.service' },
];

/** sha256 of each repository baseline file (line ends normalised to LF), keyed by remote path. */
export function localBaselineHashes(root = ROOT) {
  const out = {};
  for (const f of BASELINE_FILES) {
    const text = readFileSync(path.join(root, f.local), 'utf8').replace(/\r\n/g, '\n');
    out[f.remote] = createHash('sha256').update(text).digest('hex');
  }
  return out;
}

const subnetOf = (rules) => rules.subnet_cidr;
const publicPorts = (rules) => rules.public_ingress.map((r) => r.port);
/** Private ports addressed to this host (rules from the other VM), checked with the subnet source. */
const privatePortsFor = (rules, vm) => rules.private_ingress.filter((r) => r.to === vm).map((r) => r.port);

/** The one remote command: prints key=value lines and `sha` lines. Needs a shell with pipefail (the login shell, bash). */
export function remoteBaseline(rules, vm) {
  const fw = [];
  for (const p of publicPorts(rules)) fw.push(`if sudo -n iptables -C INPUT -p tcp --dport ${p} -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then echo fw_${p}=yes; else echo fw_${p}=no; fi`);
  for (const p of privatePortsFor(rules, vm)) fw.push(`if sudo -n iptables -C INPUT -p tcp -s ${subnetOf(rules)} --dport ${p} -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then echo fw_${p}=yes; else echo fw_${p}=no; fi`);
  const files = BASELINE_FILES.map((f) => f.remote).join(' ');
  return [
    'set -o pipefail',
    'echo arch=$(uname -m)',
    '. /etc/os-release; echo os=$VERSION_ID',
    "echo sshd=$(sudo -n sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication|authenticationmethods) ' | sort | tr ' ' ':' | tr '\\n' ',')",
    "echo secrets=$(sudo -n stat -c '%a:%U' /opt/vulnmart/secrets)",
    "echo docker=$(sudo -n docker --version | cut -d, -f1 | tr ' ' '_')",
    'echo keepalive=$(systemctl is-active vulnmart-keepalive)',
    "echo cloudinit=$(cloud-init status 2>/dev/null | head -1 | tr ' ' '_')",
    'if sudo -n test -f /var/lib/vulnmart/baseline-ok; then echo marker=ok; elif sudo -n test -f /var/lib/vulnmart/baseline-failed; then echo "marker=failed:$(sudo -n cat /var/lib/vulnmart/baseline-failed | tr \' \' _)"; else echo marker=missing; fi',
    ...fw,
    `for f in ${files}; do sudo -n sha256sum "$f" 2>/dev/null | sed 's/^/sha /' || echo "sha MISSING  $f"; done`,
  ].join('; ');
}

function parseShas(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^sha ([0-9a-f]{64}|MISSING)\s+(\S+)$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

export async function verifyHosts({ hosts, tcpProbe, ssh, identity, user = 'ubuntu', rules, requireListener = false, closedPorts = CLOSED_PORTS, localHashes = localBaselineHashes() }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const open = publicPorts(rules);

  for (const [vm, a] of Object.entries(hosts)) {
    // 1. SSH first: key login, the baseline and the host firewall.
    const login = await ssh({ host: a.pub, user, identity, command: remoteBaseline(rules, vm) });
    add(`${vm} key login works`, login.code === 0, login.code === 0 ? '' : `exit ${login.code}: ${login.stderr.trim().split('\n').pop()}`);
    const kv = login.code === 0 ? parseKeyValues(login.stdout) : {};
    if (login.code === 0) {
      add(`${vm} Ubuntu 24.04 on aarch64`, kv.os === '24.04' && kv.arch === 'aarch64', `os=${kv.os} arch=${kv.arch}`);
      const sshd = kv.sshd ?? '';
      add(`${vm} sshd refuses passwords`, sshd.includes('passwordauthentication:no'), sshd);
      add(`${vm} sshd refuses root login`, sshd.includes('permitrootlogin:no'), '');
      add(`${vm} sshd allows only public keys`, sshd.includes('authenticationmethods:publickey') && sshd.includes('kbdinteractiveauthentication:no'), '');
      add(`${vm} secrets folder is 700 and owned by root`, kv.secrets === '700:root', kv.secrets);
      add(`${vm} Docker installed`, /^Docker_version/.test(kv.docker ?? ''), kv.docker);
      add(`${vm} keep-alive service active`, kv.keepalive === 'active', kv.keepalive);
      add(`${vm} cloud-init finished`, /done/.test(kv.cloudinit ?? ''), kv.cloudinit);
      add(`${vm} baseline marker says ok`, kv.marker === 'ok', kv.marker);
      for (const p of [...open, ...privatePortsFor(rules, vm)]) add(`${vm} host firewall accepts port ${p}`, kv[`fw_${p}`] === 'yes', kv[`fw_${p}`] ?? 'no answer');
      const remote = parseShas(login.stdout);
      for (const f of BASELINE_FILES) {
        const got = remote[f.remote];
        add(`${vm} ${f.remote} matches the repository file`, !!got && got !== 'MISSING' && got === localHashes[f.remote], got === 'MISSING' || !got ? 'missing on the host' : got === localHashes[f.remote] ? '' : 'differs (drift)');
      }
    }
    // 2. Public ports, from outside.
    const probes = await Promise.all([...open, ...closedPorts.filter((p) => !open.includes(p))].map(async (p) => [p, await tcpProbe(a.pub, p)]));
    for (const [port, state] of probes) {
      if (open.includes(port)) {
        // 22 must accept. 80 and 443 accept once Caddy runs; "refused" proves the path only while the host rule exists.
        const hostRule = kv[`fw_${port}`] === 'yes';
        const ok = port === 22 ? state === 'open' : requireListener ? state === 'open' : state === 'open' || (state === 'refused' && hostRule);
        add(`${vm} port ${port} reachable from outside`, ok, state === 'refused' ? (hostRule ? 'refused by the host: no listener yet, path is open' : 'refused and no host firewall rule seen') : state);
      } else {
        add(`${vm} port ${port} closed from outside`, state !== 'open', state);
      }
    }
    // 3. Password and root login attempts must be refused (an answer of "Permission denied" with no password method offered).
    const pw = await ssh({ host: a.pub, user, options: ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=0'] });
    const offered = (pw.stderr.match(/Permission denied \(([^)]*)\)/) ?? [])[1] ?? '';
    add(`${vm} password login attempt refused`, pw.code !== 0 && /Permission denied/.test(pw.stderr) && !/password|keyboard-interactive/.test(offered), offered ? `offered: ${offered}` : pw.stderr.trim().split('\n').pop());
    const root = await ssh({ host: a.pub, user: 'root', identity });
    add(`${vm} root login attempt refused`, root.code !== 0 && /Permission denied/.test(root.stderr), root.stderr.trim().split('\n').pop());
  }
  return checks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), { values: ['identity', 'hosts', 'user', 'evidence'] });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!opts.identity) {
    console.error('usage: node scripts/verify-hosts.mjs --identity <ssh-private-key-path> [--hosts file] [--user ubuntu] [--evidence file] [--require-listener]');
    process.exit(2);
  }
  const hosts = loadHosts(opts.hosts);
  const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  const checks = await verifyHosts({ hosts, tcpProbe: realProbe, ssh: sshRun, identity: opts.identity, user: opts.user ?? 'ubuntu', rules, requireListener: !!opts['require-listener'] });
  const lines = [];
  const ok = printChecks(checks, (l) => {
    const r = redact(l, hosts);
    lines.push(r);
    console.log(r);
  });
  if (opts.evidence) {
    mkdirSync(path.dirname(path.resolve(opts.evidence)), { recursive: true });
    writeFileSync(opts.evidence, `verify-hosts ${new Date().toISOString()}\n${lines.join('\n')}\n`);
    console.log(`evidence saved to ${opts.evidence} (addresses redacted)`);
  }
  process.exit(ok ? 0 : 1);
}
