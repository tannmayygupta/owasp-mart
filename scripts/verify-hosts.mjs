// Live check of the two cloud hosts, run by the developer after `terraform apply` (runbook Part C).
// From outside: only 22, 80 and 443 respond. Over ssh: key login works, password and root login are refused,
// the host firewall has each placeholder rule (ACCEPT rules on a chain whose policy is ACCEPT: they filter nothing, the security groups are the perimeter), the baseline marker says ok, and every baseline file on each host has the same
// hash as the file in this repository (this also detects drift, because Terraform ignores later startup-file changes).
// It also proves that instance metadata (IMDSv2, hop limit 1) is reachable from the host but not from a container.
// On the labs host it then runs throwaway probe containers (bridge, host network non-root, host network root) to prove the isolation of ADR 0027 (D-43): metadata and vm-p:443 time out, vm-p:9444 stays reachable. Skip with --skip-isolation.
// Usage: node scripts/verify-hosts.mjs --identity <ssh-private-key-path> [--hosts <file>] [--user ubuntu]
//        [--evidence <file>] [--require-listener] [--keepalive] [--skip-metadata]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHosts, resolveHostsFile, redact, tcpProbe as realProbe, sshRun, parseKeyValues, printChecks, parseArgs } from './cloud-hosts.mjs';
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
  { local: 'infra/hosts/vulnmart-egress.sh', remote: '/usr/local/sbin/vulnmart-egress.sh' },
  { local: 'infra/hosts/vulnmart-egress.service', remote: '/etc/systemd/system/vulnmart-egress.service' },
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

/**
 * Probe program, run on the host and in a container. Prints two lines:
 *   imds=reachable | imds=blocked:<ExceptionClass>      (a PUT for an IMDSv2 token)
 *   control=reachable | control=failed:<ExceptionClass> (an HTTPS request to a public site the hosts already use)
 * A container is only "blocked" if its control request works, so a container without network is not mistaken for blocked.
 */
export const IMDS_PY = [
  'import urllib.request as u',
  'def go(r):',
  ' try:',
  '  u.urlopen(r,timeout=4)',
  '  return None',
  ' except Exception as e:',
  '  return type(e).__name__',
  'x=go(u.Request("http://169.254.169.254/latest/api/token",method="PUT",headers={"X-aws-ec2-metadata-token-ttl-seconds":"60"}))',
  'print("imds=reachable" if x is None else "imds=blocked:"+x)',
  'y=go(u.Request("https://download.docker.com/linux/ubuntu/gpg",method="HEAD"))',
  'print("control=reachable" if y is None else "control=failed:"+y)',
].join('\n');
// Pinned by digest (the index digest of python:3.12-alpine, read with docker inspect on 2026-10-11; re-pin on purpose).
export const IMDS_IMAGE = 'python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4';
export const pullCommand = () => `sudo -n docker pull ${IMDS_IMAGE}`;
export const metadataCommand = () =>
  // The host control runs as root: the host rule of story 1.15 (ADR 0027) drops metadata for every non-root process (that is what protects it from host-network containers).
  [`sudo -n python3 -c '${IMDS_PY}' | sed 's/^/host_/'`,`sudo -n docker run --rm ${IMDS_IMAGE} python3 -c '${IMDS_PY}' | sed 's/^/container_/'`].join('; ');

/** The command-line options as the verification takes them (exported so a test covers the wiring). */
export function verifyOptions(opts) {
  return { requireListener: !!opts['require-listener'], keepalive: !!opts.keepalive, checkMetadata: !opts['skip-metadata'], tempListener: !opts['no-temp-listener'] };
}
// AWS drops (does not refuse) a connection to a closed port, so "reachable" cannot be shown before a web server exists. The check starts a bare TCP
// listener on the web ports for a short time (it accepts and closes, it serves nothing), probes, and stops it again. A port that already has a listener is left alone.
const LISTENER_CODE = 'import socket,sys;s=socket.socket();s.setsockopt(1,2,1);s.bind(("0.0.0.0",int(sys.argv[1])));s.listen(5);exec("while 1: s.accept()[0].close()")';
export function tempListenerStart(ports) {
  return `${ports.map((p) => `{ ss -tln | grep -q ':${p} ' || sudo -n systemd-run --collect --quiet --unit=vulnmart-verify-${p} --property=RuntimeMaxSec=120 /usr/bin/python3 -c '${LISTENER_CODE}' ${p}; }`).join(' && ')} && sleep 1`;
}
export function tempListenerStop(ports) {
  return `sudo -n systemctl stop ${ports.map((p) => `vulnmart-verify-${p}`).join(' ')} 2>/dev/null; true`;
}const subnetOf = (rules) => rules.subnet_cidr;
const publicPorts = (rules) => rules.public_ingress.map((r) => r.port);
/** Private ports addressed to this host (rules from the other VM), checked with the subnet source. */
const privatePortsFor = (rules, vm) => rules.private_ingress.filter((r) => r.to === vm).map((r) => r.port);

/** The one remote command: prints key=value lines and `sha` lines. Needs a shell with pipefail (the login shell, bash). */
export function remoteBaseline(rules, vm) {
  const fw = [];
  for (const p of publicPorts(rules)) fw.push(`if sudo -n iptables -C INPUT -p tcp --dport ${p} -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then echo fw_${p}=yes; else echo fw_${p}=no; fi`);
  for (const p of privatePortsFor(rules, vm)) fw.push(`if sudo -n iptables -C INPUT -p tcp -s ${subnetOf(rules)} --dport ${p} -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || sudo -n iptables -C INPUT -p tcp -s ${rules.vcn_cidr} --dport ${p} -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then echo fw_${p}=yes; else echo fw_${p}=no; fi`);
  const files = BASELINE_FILES.map((f) => f.remote).join(' ');
  return [
    'set -o pipefail',
    'echo arch=$(uname -m)',
    '. /etc/os-release; echo os=$VERSION_ID',
    "echo sshd=$(sudo -n sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication|authenticationmethods) ' | sort | tr ' ' ':' | tr '\\n' ',')",
    "echo secrets=$(sudo -n stat -c '%a:%U' /opt/vulnmart/secrets)",
    "echo docker=$(sudo -n docker --version | cut -d, -f1 | tr ' ' '_')",
    'echo keepalive=$(systemctl is-active vulnmart-keepalive || true)',
    'echo reboot=$(if [ -f /var/run/reboot-required ]; then echo required; else echo no; fi)',
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

// ---- Labs host isolation (D-43, ADR 0027). Run by the developer after the apply; Claude never runs it. ----
// Throwaway probe containers on the labs host: one on a bridge network, one with host networking and a non-root user, one with host networking as root.
// A probe is a TCP connect with a 3 second limit (the same test as `curl -m3`: the image has no curl). Each prints key=state, state in open | refused | timeout | error:<Class>.
export const ISOLATION_PY = [
  'import socket,sys',
  'def c(h,p):',
  ' try:',
  '  socket.create_connection((h,p),3).close()',
  '  return "open"',
  ' except socket.timeout:',
  '  return "timeout"',
  ' except ConnectionRefusedError:',
  '  return "refused"',
  ' except Exception as e:',
  '  return "error:"+type(e).__name__',
  'print("imds="+c("169.254.169.254",80))',
  'print("vmp443="+c(sys.argv[1],443))',
  'print("vmp9444="+c(sys.argv[1],int(sys.argv[2])))',
  'print("self22="+c(sys.argv[3],22))',
  'print("internet443="+c("download.docker.com",443))',
].join('\n');
export const isolationCommand = (vmpPrivate, ingestPort, selfPrivate) => {
  const args = `${vmpPrivate} ${ingestPort} ${selfPrivate}`;
  const run = (flags, prefix) => `sudo -n docker run --rm ${flags} ${IMDS_IMAGE} python3 -c '${ISOLATION_PY}' ${args} | sed 's/^/${prefix}_/'`;
  return [run('', 'bridge'), run('--network host --user 65534:65534', 'hostnet_user'), run('--network host', 'hostnet_root')].join('; ');
};
/** Checks from the probe output. The root host-network probe is information only: a root container with host networking can use the host's own network stack. */
export function isolationChecks(vm, kv, add) {
  const reach = (s) => s === 'open' || s === 'refused';
  add(`${vm} a bridge container has network access (control: https to a public site)`, kv.bridge_internet443 === 'open', kv.bridge_internet443 ?? 'no answer');
  add(`${vm} a bridge container cannot reach instance metadata (curl -m3 http://169.254.169.254 times out)`, kv.bridge_imds === 'timeout', kv.bridge_imds ?? 'no answer');
  add(`${vm} a bridge container cannot reach vm-p on 443`, kv.bridge_vmp443 === 'timeout', kv.bridge_vmp443 ?? 'no answer');
  add(`${vm} a bridge container cannot reach this host's own port 22 through its private address`, kv.bridge_self22 === 'timeout', kv.bridge_self22 ?? 'no answer');
  add(`${vm} a bridge container can reach vm-p on the ingest port (open, or refused while nothing listens yet)`, reach(kv.bridge_vmp9444), kv.bridge_vmp9444 ?? 'no answer');
  add(`${vm} a non-root host-network container cannot reach instance metadata`, kv.hostnet_user_imds === 'timeout', kv.hostnet_user_imds ?? 'no answer');
  add(`${vm} a host-network container cannot reach vm-p on 443 (the network ACL of the labs subnet)`, kv.hostnet_user_vmp443 === 'timeout' && kv.hostnet_root_vmp443 === 'timeout', `${kv.hostnet_user_vmp443 ?? 'no answer'} / ${kv.hostnet_root_vmp443 ?? 'no answer'}`);
  add(`${vm} the host itself can still reach vm-p on the ingest port (from a host-network container)`, reach(kv.hostnet_user_vmp9444), kv.hostnet_user_vmp9444 ?? 'no answer');
  const rootImds = kv.hostnet_root_imds;
  add(`${vm} information: a ROOT host-network container ${reach(rootImds) ? 'CAN' : 'cannot'} reach instance metadata`, true, `${rootImds ?? 'no answer'}; known residual risk (ADR 0027): compose files must not use host networking or privileged mode (scripts/check-lab-compose-rules.mjs)`, reach(rootImds));
}
export async function verifyHosts({ hosts, tcpProbe, ssh, identity, user = 'ubuntu', rules, requireListener = false, keepalive = false, checkMetadata = true, checkIsolation = false, tempListener = false, closedPorts = CLOSED_PORTS, localHashes = localBaselineHashes() }) {
  const checks = [];
  const add = (name, ok, detail = '', warn = false) => checks.push({ name, ok, detail, warn });
  const open = publicPorts(rules);

  for (const [vm, a] of Object.entries(hosts)) {
    // 1. SSH first: key login, the baseline and the host firewall.
    const login = await ssh({ host: a.pub, user, identity, command: remoteBaseline(rules, vm) });
    add(`${vm} key login works`, login.code === 0, login.code === 0 ? '' : `exit ${login.code}: ${login.stderr.trim().split('\n').pop()}`);
    const kv = login.code === 0 ? parseKeyValues(login.stdout) : {};
    if (login.code === 0) {
      add(`${vm} Ubuntu 24.04 (x86_64 or aarch64)`, kv.os === '24.04' && ['x86_64', 'aarch64'].includes(kv.arch), `os=${kv.os} arch=${kv.arch}`);
      const sshd = kv.sshd ?? '';
      add(`${vm} sshd refuses passwords`, sshd.includes('passwordauthentication:no'), sshd);
      add(`${vm} sshd refuses root login`, sshd.includes('permitrootlogin:no'), '');
      add(`${vm} sshd allows only public keys`, sshd.includes('authenticationmethods:publickey') && sshd.includes('kbdinteractiveauthentication:no'), '');
      add(`${vm} secrets folder is 700 and owned by root`, kv.secrets === '700:root', kv.secrets);
      add(`${vm} Docker installed`, /^Docker_version/.test(kv.docker ?? ''), kv.docker);
      // Off means the unit is not running: inactive, failed or unknown. Missing data is a failure, not a pass.
      add(keepalive ? `${vm} keep-alive service active` : `${vm} keep-alive service off (as configured)`, keepalive ? kv.keepalive === 'active' : ['inactive', 'failed', 'unknown'].includes(kv.keepalive), kv.keepalive ?? 'no answer');
      if (kv.reboot === 'required') add(`${vm} a reboot is pending`, true, 'WARNING: updates were installed that need a reboot and no automatic reboot is configured: reboot this host once in a quiet moment (the stop and start rehearsal covers it), then run verify-hosts again', true);
      // cloud-init keeps an 'error' status after a failed first run even when the baseline was repaired and rerun by hand: accept that only with an ok marker, and say so.
      const ci = kv.cloudinit ?? '';
      const ciRepaired = /error/.test(ci) && kv.marker === 'ok';
      add(`${vm} cloud-init finished`, /done/.test(ci) || ciRepaired, ciRepaired ? 'cloud-init recorded an error from an earlier run; the baseline marker is ok (repaired and rerun by hand)' : ci, ciRepaired);
      add(`${vm} baseline marker says ok`, kv.marker === 'ok', kv.marker);
      for (const p of [...open, ...privatePortsFor(rules, vm)]) add(`${vm} host firewall placeholder rule for port ${p} present`, kv[`fw_${p}`] === 'yes', kv[`fw_${p}`] ?? 'no answer');
      const remote = parseShas(login.stdout);
      for (const f of BASELINE_FILES) {
        const got = remote[f.remote];
        add(`${vm} ${f.remote} matches the repository file`, !!got && got !== 'MISSING' && got === localHashes[f.remote], got === 'MISSING' || !got ? 'missing on the host' : got === localHashes[f.remote] ? '' : 'differs (drift)');
      }
    }
    if (login.code === 0 && checkMetadata) {
      // The probe image is pulled in its own step, so a failed pull is reported as such and not as a metadata result.
      const pull = await ssh({ host: a.pub, user, identity, command: pullCommand(), timeoutMs: 240000 });
      add(`${vm} metadata probe image pulled (pinned by digest)`, pull.code === 0, pull.code === 0 ? '' : `image pull failed (exit ${pull.code}): ${pull.stderr.trim().split('\n').pop()}`);
      if (pull.code === 0) {
        const m = await ssh({ host: a.pub, user, identity, command: metadataCommand(), timeoutMs: 120000 });
        const mk = parseKeyValues(m.stdout);
        add(`${vm} instance metadata is reachable from the host (control)`, mk.host_imds === 'reachable', mk.host_imds ?? `no answer (exit ${m.code})`);
        add(`${vm} a container has network access (control)`, mk.container_control === 'reachable', mk.container_control ?? `no answer (exit ${m.code})`);
        add(`${vm} a container cannot read instance metadata (IMDSv2, hop limit 1)`, mk.container_control === 'reachable' && (mk.container_imds ?? '').startsWith('blocked'), mk.container_imds ?? `no answer (exit ${m.code})`);
      }
    }
    if (login.code === 0 && checkIsolation && vm === 'vm-i') {
      const ingestPort = rules.private_ingress.find((r) => r.from === 'vm-i').port;
      const iso = await ssh({ host: a.pub, user, identity, command: isolationCommand(hosts['vm-p'].priv, ingestPort, a.priv), timeoutMs: 240000 });
      isolationChecks(vm, parseKeyValues(iso.stdout), add);
    }
    // 2. Public ports, from outside. With the temporary listener the web ports must really answer.
    const webPorts = open.filter((p) => p !== 22);
    let listening = false;
    if (tempListener && login.code === 0 && webPorts.length) {
      const st = await ssh({ host: a.pub, user, identity, command: tempListenerStart(webPorts), timeoutMs: 60000 });
      listening = st.code === 0;
      add(`${vm} temporary listener on ${webPorts.join(' and ')} started (serves nothing, stopped after the probes)`, listening, listening ? '' : `exit ${st.code}: ${(st.stderr || '').trim().split('\n').pop()}`);
    }
    const probes = await Promise.all([...open, ...closedPorts.filter((p) => !open.includes(p))].map(async (p) => [p, await tcpProbe(a.pub, p)]));
    for (const [port, state] of probes) {
      if (open.includes(port)) {
        // 22 must accept. 80 and 443 accept once Caddy runs; "refused" proves the path only while the host rule exists.
        const hostRule = kv[`fw_${port}`] === 'yes';
        const ok = port === 22 ? state === 'open' : (requireListener || listening) ? state === 'open' : state === 'open' || (state === 'refused' && hostRule);
        add(`${vm} port ${port} reachable from outside`, ok, state === 'refused' ? (hostRule ? 'refused by the host: no listener yet, path is open' : 'refused and no host firewall rule seen') : state);
      } else {
        add(`${vm} port ${port} closed from outside`, state !== 'open', state);
      }
    }
    if (listening) await ssh({ host: a.pub, user, identity, command: tempListenerStop(webPorts), timeoutMs: 60000 });
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
    opts = parseArgs(process.argv.slice(2), { values: ['identity', 'hosts', 'provider', 'user', 'evidence'] });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!opts.identity) {
    console.error('usage: node scripts/verify-hosts.mjs --identity <ssh-private-key-path> [--hosts file | --provider aws|oci] [--user ubuntu] [--evidence file] [--require-listener] [--no-temp-listener] [--keepalive] [--skip-metadata] [--skip-isolation]');
    process.exit(2);
  }
  const hosts = loadHosts(resolveHostsFile(opts));
  const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  const checks = await verifyHosts({ hosts, tcpProbe: realProbe, ssh: sshRun, identity: opts.identity, user: opts.user ?? 'ubuntu', rules, ...verifyOptions(opts), checkIsolation: !opts['skip-isolation'] });
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
