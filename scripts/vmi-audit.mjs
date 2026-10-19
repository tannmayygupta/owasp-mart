// Read-only isolation audit of a Docker host (story 8.5, L-29 lean). Turns the output of fixed, read-only commands into
// PASS / FAIL / SKIP lines. It changes nothing and never talks to the network.
//
//   node scripts/vmi-audit.mjs --from <folder> [--instances N] [--out <file>]   audit saved outputs (the VM runbook makes them)
//   node scripts/vmi-audit.mjs --local [--instances N] [--out <file>]           run the read-only docker commands on this machine
//
// Input files of --from (names fixed; see docs/runbooks/vmi-hardening.md for the commands that make them):
//   docker-info.json (docker info --format '{{json .}}'), daemon.json, iptables-docker-user.txt (iptables -S DOCKER-USER),
//   iptables-input.txt (iptables -S INPUT), iptables-vulnmart-labs.txt (iptables -S VULNMART-LABS), inspect.json (docker inspect of every running container), ss.txt (ss -ltnH),
//   imds.json (optional: the HttpTokens values from aws ec2 describe-instances).
// Parsers fail closed: empty or unreadable text is FAIL ("unreadable"), never PASS. A missing required file is FAIL.
// The pure parsers are exported and tested in scripts/vmi-audit.test.mjs on fixtures in scripts/fixtures/vmi-audit/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { formatTable, redact } from './demo.mjs';

export const FILES = {
  info: 'docker-info.json',
  daemon: 'daemon.json',
  dockerUser: 'iptables-docker-user.txt',
  labsChain: 'iptables-vulnmart-labs.txt',
  input: 'iptables-input.txt',
  inspect: 'inspect.json',
  ss: 'ss.txt',
  imds: 'imds.json',
};
export const DEFAULT_INSTANCES = 50;
export const PUBLIC_PORTS = [22, 80, 443];
// Ports that may listen on a private (VPC) address but never on every address: the orchestrator's mutual-TLS listener (review finding D3).
export const PRIVATE_ONLY_PORTS = [9443];
export const BIND_ALLOW = ['/etc/vulnmart', '/opt/vulnmart', '/srv/vulnmart'];
export const SOCKET_PATHS = ['/var/run/docker.sock', '/run/docker.sock'];
export const SENSITIVE_BINDS = ['/', '/etc', '/proc', '/sys', '/root', '/home', '/var/lib/docker', '/var/run', '/run', '/boot', '/dev'];

const row = (status, name, detail) => ({ status, name, detail });
const unreadable = (name, why) => row('FAIL', name, `unreadable: ${why}`);

function parseJson(text) {
  if (text == null || !String(text).trim()) return { error: 'empty' };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'not valid JSON' };
  }
}

// ---------- CIDR helpers (IPv4) ----------
export function parseCidr(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  const len = Number(m[5]);
  if (o.some((n) => n > 255) || len > 32) return null;
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { start: (ip & mask) >>> 0, len };
}

export function cidrContains(outer, inner) {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (!a || !b || a.len > b.len) return false;
  const mask = a.len === 0 ? 0 : (0xffffffff << (32 - a.len)) >>> 0;
  return ((b.start & mask) >>> 0) === a.start;
}

// ---------- parsers ----------
// docker info --format '{{json .}}'
export function auditDockerInfo(text) {
  const name = 'docker-info';
  const p = parseJson(text);
  if (p.error) return [unreadable(name, p.error)];
  const o = p.value;
  if (!o || typeof o !== 'object' || !Array.isArray(o.SecurityOptions)) return [unreadable(name, 'no SecurityOptions field')];
  const opts = o.SecurityOptions.map(String);
  const has = (k) => opts.some((s) => s.includes(k));
  const rootless = has('name=rootless');
  const userns = has('name=userns');
  const detail = `security options: ${opts.map((s) => s.replace(/^name=/, '')).join(', ') || 'none'}; rootless ${rootless ? 'yes' : 'no'}; userns ${userns ? 'yes' : 'no'} (checked, not extended); storage ${o.Driver ?? 'unknown'}`;
  return [row(has('name=seccomp') && !has('unconfined') ? 'PASS' : 'FAIL', 'docker-seccomp', has('name=seccomp') ? detail : `default seccomp profile not reported; ${detail}`)];
}

// daemon.json: address pools wide enough for N instance networks; live-restore.
export function auditDaemon(text, instances = DEFAULT_INSTANCES) {
  const p = parseJson(text);
  if (p.error) return [unreadable('daemon-pools', p.error), unreadable('daemon-live-restore', p.error)];
  const d = p.value;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [unreadable('daemon-pools', 'not an object'), unreadable('daemon-live-restore', 'not an object')];
  const rows = [];
  const pools = Array.isArray(d['default-address-pools']) ? d['default-address-pools'] : [];
  let nets = 0;
  let bad = false;
  for (const pl of pools) {
    const c = parseCidr(pl?.base);
    const size = Number(pl?.size);
    if (!c || !Number.isInteger(size) || size < c.len || size > 32) {
      bad = true;
      continue;
    }
    nets += 2 ** (size - c.len);
  }
  if (!pools.length) rows.push(row('FAIL', 'daemon-pools', `no default-address-pools set: Docker's built-in pool is used; ${instances} instance networks are not guaranteed`));
  else if (bad) rows.push(unreadable('daemon-pools', 'a pool has a bad base or size'));
  else rows.push(row(nets >= instances ? 'PASS' : 'FAIL', 'daemon-pools', `pools allow ${nets} networks, target ${instances}`));
  rows.push(row(d['live-restore'] === true ? 'PASS' : 'FAIL', 'daemon-live-restore', `live-restore is ${d['live-restore'] === true ? 'true' : 'not true'}; no-new-privileges default ${d['no-new-privileges'] === true ? 'on' : 'off (set per container, see container-hardening)'}`));
  return rows;
}

function parseRules(text, chain) {
  const rules = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith(`-A ${chain} `)) rules.push(line.trim());
  }
  return rules;
}

const subnetOf = (rule) => /(?:^|\s)-s (\d+\.\d+\.\d+\.\d+\/\d+)/.exec(rule)?.[1] ?? null;

// iptables -S DOCKER-USER and iptables -S INPUT: the host rule of story 4.1 must be first in both chains, for every pool.
export function auditIptables({ dockerUser, input, poolBases = [] }) {
  const out = [];
  const empty = (t) => t == null || !String(t).trim();
  if (empty(dockerUser)) out.push(unreadable('host-rule-docker-user', 'empty'));
  else {
    const rules = parseRules(dockerUser, 'DOCKER-USER');
    const first = rules[0];
    const good = first && /-j VULNMART-LABS\b/.test(first) && subnetOf(first);
    const subs = rules.filter((r) => /-j VULNMART-LABS\b/.test(r)).map(subnetOf).filter(Boolean);
    const miss = poolBases.filter((b) => !subs.some((s) => cidrContains(s, b)));
    if (!rules.length) out.push(row('FAIL', 'host-rule-docker-user', 'no rule in DOCKER-USER (the jump to VULNMART-LABS is missing)'));
    else if (!good) out.push(row('FAIL', 'host-rule-docker-user', 'the first DOCKER-USER rule is not the jump to VULNMART-LABS for a lab subnet'));
    else if (miss.length) out.push(row('FAIL', 'host-rule-docker-user', `no jump covers pool ${miss.join(', ')}`));
    else out.push(row('PASS', 'host-rule-docker-user', `first rule jumps lab subnet ${subs.join(', ')} to VULNMART-LABS`));
  }
  if (empty(input)) out.push(unreadable('host-rule-input', 'empty'));
  else {
    const rules = parseRules(input, 'INPUT');
    const isDrop = (r) => subnetOf(r) && /--ctstate NEW\b/.test(r) && /-j DROP\b/.test(r);
    const drops = rules.filter(isDrop);
    let lead = 0;
    while (lead < rules.length && isDrop(rules[lead])) lead++;
    const subs = drops.map(subnetOf);
    const miss = poolBases.filter((b) => !subs.some((s) => cidrContains(s, b)));
    if (!rules.length) out.push(row('FAIL', 'host-rule-input', 'no rule in INPUT (the host rule of story 4.1 is missing)'));
    else if (!drops.length) out.push(row('FAIL', 'host-rule-input', 'no INPUT rule drops new connections from a lab subnet'));
    else if (lead !== drops.length) out.push(row('FAIL', 'host-rule-input', 'a lab-subnet DROP rule exists but is not first in INPUT'));
    else if (miss.length) out.push(row('FAIL', 'host-rule-input', `no INPUT drop covers pool ${miss.join(', ')}`));
    else out.push(row('PASS', 'host-rule-input', `first INPUT rule(s) drop new connections from ${subs.join(', ')}`));
  }
  return out;
}

// iptables -S VULNMART-LABS: the chain the jump in DOCKER-USER leads to. The jump alone proves nothing (an empty or flushed chain lets everything
// through), so the content is checked: it must keep the metadata and VPC drops, end in a DROP for everything else, and hold no blanket ACCEPT
// or RETURN (review finding D1). A conntrack RETURN for replies and ACCEPTs that name a protocol or a destination are what the egress script writes.
export function auditLabsChain(text) {
  const name = 'host-rule-labs-chain';
  if (text == null || !String(text).trim()) return [unreadable(name, 'empty')];
  const rules = parseRules(text, 'VULNMART-LABS');
  if (!rules.length) return [row('FAIL', name, 'the chain VULNMART-LABS has no rule: the jump leads nowhere (it lets everything through)')];
  const problems = [];
  if (!/^-A VULNMART-LABS -j DROP$/.test(rules[rules.length - 1])) problems.push('the last rule is not a DROP for everything else');
  if (!rules.some((r) => /-d 169\.254\.0\.0\/16 -j DROP$/.test(r))) problems.push('no DROP for the metadata and link-local range 169.254.0.0/16');
  const vpcDrop = rules.some((r) => {
    const m = /-d (\d+\.\d+\.\d+\.\d+\/\d+) -j DROP$/.exec(r);
    return m && /^(10\.|192\.168\.)/.test(m[1]) && parseCidr(m[1])?.len <= 16; // the VPC (10.x here); the 172.16.0.0/12 drops are the container subnets, checked below
  });
  if (!vpcDrop) problems.push('no DROP for the private network range of the VPC');
  // audit blocker B4: no tcp/443 ACCEPT for every destination, and the container subnets must be dropped from each other (an ACCEPT in DOCKER-USER skips Docker's isolation)
  if (rules.some((r) => /-p tcp( -m tcp)? --dport 443 -j ACCEPT$/.test(r) && !/ -d /.test(r))) problems.push('an ACCEPT for tcp 443 to every destination: a container could reach any HTTPS address and other networks');
  if (!rules.some((r) => /-d 172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\/\d+ -j DROP$/.test(r))) problems.push('no DROP between the container subnets (172.16.0.0/12): networks of different instances are not kept apart on the host');
  for (const r of rules) {
    if (/-j (ACCEPT|RETURN)$/.test(r) && !/(-p |-d |--ctstate)/.test(r)) problems.push(`a blanket ${/ACCEPT/.test(r) ? 'ACCEPT' : 'RETURN'} rule: ${r.replace('-A VULNMART-LABS ', '')}`);
  }
  return [problems.length ? row('FAIL', name, problems.join('; ')) : row('PASS', name, `${rules.length} rules; metadata and VPC dropped, everything else ends in a DROP`)];
}

const cname = (c) => String(c?.Name ?? c?.Id ?? 'unknown').replace(/^\//, '');
const isInstance = (c) => {
  const labels = c?.Config?.Labels ?? {};
  return Object.keys(labels).some((k) => k === 'vm.instance' || k === 'vm.kind' && String(labels[k]).startsWith('inst')) || /^vm-i-/.test(cname(c));
};
const isProxy = (c) => /^(vulnmart-)?docker-proxy$/.test(cname(c)); // the exact name: a container only named like it gets no exemption (finding D2)

// docker inspect of every running container (JSON array).
export function auditInspect(text) {
  const name = 'container-hardening';
  const p = parseJson(text);
  if (p.error) return [unreadable(name, p.error)];
  if (!Array.isArray(p.value)) return [unreadable(name, 'not an array')];
  const findings = [];
  for (const c of p.value) {
    if (!c || typeof c !== 'object' || !c.HostConfig) return [unreadable(name, 'a container entry has no HostConfig')];
    const n = cname(c);
    const hc = c.HostConfig;
    if (hc.Privileged === true) findings.push(`${n}: privileged`);
    if (hc.NetworkMode === 'host') findings.push(`${n}: host network`);
    if (hc.PidMode === 'host') findings.push(`${n}: host PID namespace`);
    // what a container may also be given besides `privileged` (review finding D2)
    if (hc.IpcMode === 'host') findings.push(`${n}: host IPC namespace`);
    if (hc.UsernsMode === 'host') findings.push(`${n}: host user namespace`);
    // the one addition that is by design: the two Caddy containers bind 443 (NET_BIND_SERVICE); every other container may add nothing
    const bindsPorts = /^vulnmart-(edge-)?caddy$/.test(n);
    const extra = (hc.CapAdd ?? []).filter((x) => !(bindsPorts && String(x).replace(/^CAP_/i, '').toUpperCase() === 'NET_BIND_SERVICE'));
    if (extra.length) findings.push(`${n}: adds capabilities (${extra.join(', ')})`);
    if ((hc.Devices ?? []).length) findings.push(`${n}: maps host devices`);
    if ((hc.SecurityOpt ?? []).some((s) => /unconfined/.test(String(s)))) findings.push(`${n}: runs unconfined (seccomp or AppArmor off)`);
    for (const m of c.Mounts ?? []) {
      const src = String(m.Source ?? '');
      const isSock = SOCKET_PATHS.includes(src) || String(m.Destination ?? '').endsWith('docker.sock');
      if (isSock) {
        if (!(isProxy(c) && m.RW === false)) findings.push(`${n}: mounts the Docker socket${isProxy(c) ? ' read-write' : ''}`);
        continue;
      }
      if (m.Type === 'bind' && m.RW !== false && !BIND_ALLOW.some((a) => src === a || src.startsWith(`${a}/`))) findings.push(`${n}: writable bind mount of ${src || 'unknown'} outside the allow-list`);
      const trimmed = src.replace(/\/+$/, '') || '/';
      // the path itself or anything below it (a read-only bind of /root/.ssh is as bad as one of /root), except under the allow-list
      const sensitive = SENSITIVE_BINDS.some((s) => trimmed === s || (s !== '/' && trimmed.startsWith(`${s}/`)));
      if (m.Type === 'bind' && sensitive && !BIND_ALLOW.some((a) => trimmed === a || trimmed.startsWith(`${a}/`))) findings.push(`${n}: bind mount of the host path ${src}`);
    }
    // The socket proxy lets the orchestrator attach containers to instance networks and does not filter which one (review finding D11, accepted
    // risk); this is the compensating check: only the edge gate may sit on an instance network besides the instance's own containers.
    const nets = Object.keys(c.NetworkSettings?.Networks ?? {});
    if (!isInstance(c) && !/^(vulnmart-)?edge-gate$/.test(n) && nets.some((x) => /^vm-i-/.test(x))) findings.push(`${n}: attached to an instance network (${nets.filter((x) => /^vm-i-/.test(x)).join(', ')})`);
    if (isInstance(c)) {
      if (!(hc.CapDrop ?? []).map((s) => String(s).toUpperCase()).includes('ALL')) findings.push(`${n}: instance container does not drop ALL capabilities`);
      if (!(hc.SecurityOpt ?? []).some((s) => /^no-new-privileges(:true)?$/.test(s))) findings.push(`${n}: instance container lacks no-new-privileges`);
    }
  }
  return [row(findings.length ? 'FAIL' : 'PASS', name, findings.length ? findings.join('; ') : `${p.value.length} container(s): none privileged, no host network, socket only read-only in docker-proxy, no unlisted writable binds, instances drop ALL and set no-new-privileges`)];
}

// S-8 (story L-29): when the lab is meant to run its instances in a sandbox runtime (`--expect-runtime runsc`), every instance container must have asked the
// daemon for it. A container without it would run on the host kernel directly: this is the check that no instance quietly does.
export function auditRuntime(text, expected) {
  const name = 'instance-runtime';
  const p = parseJson(text);
  if (p.error) return [unreadable(name, p.error)];
  if (!Array.isArray(p.value)) return [unreadable(name, 'not an array')];
  const instances = p.value.filter((c) => c && c.HostConfig && isInstance(c));
  const wrong = instances.filter((c) => (c.HostConfig.Runtime || 'runc') !== expected).map((c) => `${cname(c)} (${c.HostConfig.Runtime || 'runc'})`);
  if (wrong.length) return [row('FAIL', name, `not running under ${expected}: ${wrong.join(', ')}`)];
  return [row('PASS', name, instances.length ? `${instances.length} instance container(s), every one under ${expected}` : `no instance container is running (nothing to check); the expected runtime is ${expected}`)];
}

// ss -ltnH : every listener is loopback or one of the public ports.
export function parseListeners(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    const m = /^(.*):(\d+)$/.exec(local ?? '');
    if (!m || cols[0] !== 'LISTEN') return null;
    out.push({ addr: m[1].replace(/%.*$/, ''), port: Number(m[2]) });
  }
  return out;
}

export function auditListeners(text, publicPorts = PUBLIC_PORTS) {
  const name = 'listening-ports';
  if (text == null || !String(text).trim()) return [unreadable(name, 'empty')];
  const l = parseListeners(text);
  if (!l) return [unreadable(name, 'a line is not an ss -ltnH listener line')];
  const loop = (a) => /^127\./.test(a) || a === '[::1]' || a === '::1';
  const wide = l.filter((x) => !loop(x.addr));
  const privateAddr = (a) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a);
  // a port of PRIVATE_ONLY_PORTS is fine on a private address and a failure on every address or a public one (finding D3)
  const bad = wide.filter((x) => !publicPorts.includes(x.port) && !(PRIVATE_ONLY_PORTS.includes(x.port) && privateAddr(x.addr)));
  if (bad.length) return [row('FAIL', name, `non-loopback listener(s) on port ${[...new Set(bad.map((b) => b.port))].sort((a, b) => a - b).join(', ')} (allowed: ${publicPorts.join(', ')}; ${PRIVATE_ONLY_PORTS.join(', ')} only on a private address)`)];
  return [row('PASS', name, `${l.length} listener(s); public ports: ${[...new Set(wide.map((w) => w.port))].sort((a, b) => a - b).join(', ') || 'none'}; the rest are loopback`)];
}

// aws ec2 describe-instances --query 'Reservations[].Instances[].MetadataOptions.HttpTokens' (JSON array of strings)
export function auditImds(text) {
  const name = 'imds-v2-required';
  const p = parseJson(text);
  if (p.error) return [unreadable(name, p.error)];
  const v = Array.isArray(p.value) ? p.value.flat(Infinity) : [p.value];
  if (!v.length || v.some((x) => typeof x !== 'string')) return [unreadable(name, 'expected a list of HttpTokens values')];
  const optional = v.filter((x) => x !== 'required').length;
  return [row(optional ? 'FAIL' : 'PASS', name, optional ? `${optional} of ${v.length} instance(s) have HttpTokens other than required` : `${v.length} instance(s): HttpTokens required`)];
}

// ---------- assembly ----------
export function poolBasesOf(daemonText) {
  const p = parseJson(daemonText);
  const pools = p.value?.['default-address-pools'];
  return Array.isArray(pools) ? pools.map((x) => x?.base).filter((b) => parseCidr(b)) : [];
}

export function auditAll(inputs, { instances = DEFAULT_INSTANCES, skip = {}, expectRuntime = null } = {}) {
  const rows = [];
  const need = (key, names, fn) => {
    if (skip[key]) return rows.push(...names.map((n) => row('SKIP', n, skip[key])));
    if (inputs[key] === undefined || inputs[key] === null) return rows.push(...names.map((n) => row('FAIL', n, `input file ${FILES[key]} is missing`)));
    return rows.push(...fn(inputs[key]));
  };
  need('info', ['docker-seccomp'], auditDockerInfo);
  need('daemon', ['daemon-pools', 'daemon-live-restore'], (t) => auditDaemon(t, instances));
  const bases = skip.daemon ? [] : poolBasesOf(inputs.daemon);
  for (const [key, name] of [['dockerUser', 'host-rule-docker-user'], ['input', 'host-rule-input']]) {
    if (skip[key]) rows.push(row('SKIP', name, skip[key]));
    else if (inputs[key] == null) rows.push(row('FAIL', name, `input file ${FILES[key]} is missing`));
  }
  if (!skip.dockerUser && !skip.input && inputs.dockerUser != null && inputs.input != null) rows.push(...auditIptables({ dockerUser: inputs.dockerUser, input: inputs.input, poolBases: bases }));
  else if (!skip.dockerUser && inputs.dockerUser != null) rows.push(...auditIptables({ dockerUser: inputs.dockerUser, input: '', poolBases: bases }).slice(0, 1));
  else if (!skip.input && inputs.input != null) rows.push(...auditIptables({ dockerUser: '', input: inputs.input, poolBases: bases }).slice(1));
  need('labsChain', ['host-rule-labs-chain'], auditLabsChain);
  need('inspect', ['container-hardening'], auditInspect);
  if (expectRuntime && inputs.inspect != null && !skip.inspect) rows.push(...auditRuntime(inputs.inspect, expectRuntime));
  need('ss', ['listening-ports'], auditListeners);
  if (skip.imds) rows.push(row('SKIP', 'imds-v2-required', skip.imds));
  else if (inputs.imds == null) rows.push(row('SKIP', 'imds-v2-required', `${FILES.imds} not provided (paste the aws output into it)`));
  else rows.push(...auditImds(inputs.imds));
  return rows;
}

export function parseArgs(argv) {
  const o = { mode: null, from: null, instances: DEFAULT_INSTANCES, out: null, expectRuntime: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') o.mode = 'local';
    else if (a === '--from') {
      o.mode = 'from';
      o.from = argv[++i];
      if (!o.from) return { error: '--from needs a folder' };
    } else if (a === '--instances') {
      o.instances = Number(argv[++i]);
      if (!Number.isInteger(o.instances) || o.instances < 1) return { error: '--instances needs a positive integer' };
    } else if (a === '--expect-runtime') {
      o.expectRuntime = argv[++i];
      if (!['runc', 'runsc'].includes(o.expectRuntime)) return { error: '--expect-runtime is runc or runsc' };
    } else if (a === '--out') {
      o.out = argv[++i];
      if (!o.out) return { error: '--out needs a file' };
    } else return { error: `Unknown option "${a}"` };
  }
  if (!o.mode) return { error: 'Usage: node scripts/vmi-audit.mjs --from <folder> | --local [--instances N] [--out <file>]' };
  return o;
}

// Addresses, account ids, instance ids and key names must not reach saved evidence.
export function redactEvidence(text) {
  return redact(text).replace(/\b\d{12}\b/g, '<account>').replace(/\bi-[0-9a-f]{8,17}\b/g, '<instance-id>').replace(/\bAKIA[0-9A-Z]{16}\b/g, '<key>');
}

export const exitCodeOf = (rows) => (rows.some((r) => r.status === 'FAIL') ? 1 : 0);

// ---------- IO ----------
function readFrom(dir) {
  const inputs = {};
  for (const [k, f] of Object.entries(FILES)) {
    const p = path.join(dir, f);
    inputs[k] = existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  return inputs;
}

// Fixed read-only commands only. Nothing here writes, starts, stops or configures anything.
function dockerRead(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

function readLocal() {
  const inputs = { info: dockerRead(['info', '--format', '{{json .}}']) ?? '' };
  const ids = (dockerRead(['ps', '-q']) ?? '').split(/\s+/).filter(Boolean);
  inputs.inspect = ids.length ? (dockerRead(['inspect', ...ids]) ?? '') : '[]';
  const dj = path.join(os.homedir(), '.docker', 'daemon.json');
  inputs.daemon = existsSync(dj) ? readFileSync(dj, 'utf8') : null;
  return inputs;
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) {
    console.error(o.error);
    return 2;
  }
  let rows;
  if (o.mode === 'from') {
    if (!existsSync(o.from)) {
      console.error(`Folder not found: ${o.from}`);
      return 2;
    }
    rows = auditAll(readFrom(o.from), { instances: o.instances, expectRuntime: o.expectRuntime });
  } else {
    const inputs = readLocal();
    const skip = { dockerUser: 'Docker Desktop host has no iptables here (run on the VM)', labsChain: 'Docker Desktop host has no iptables here (run on the VM)', input: 'Docker Desktop host has no iptables here (run on the VM)', ss: 'ss is not available here (run on the VM)', imds: 'AWS metadata check is a VM step' };
    if (inputs.daemon === null) skip.daemon = "Docker Desktop keeps the daemon settings in its own settings, no daemon.json found in the user's .docker folder";
    rows = auditAll(inputs, { instances: o.instances, skip, expectRuntime: o.expectRuntime });
  }
  const table = formatTable(rows);
  const text = redactEvidence(table);
  console.log(text);
  console.log(`\n${rows.filter((r) => r.status === 'PASS').length} PASS, ${rows.filter((r) => r.status === 'FAIL').length} FAIL, ${rows.filter((r) => r.status === 'SKIP').length} SKIP (${o.mode === 'local' ? 'local mode, read-only' : 'saved outputs'}; no live host result unless you ran the bundle on the host)`);
  if (o.out) writeFileSync(o.out, `${text}\n`);
  return exitCodeOf(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
