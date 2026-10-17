// Read-only isolation audit of a Docker host (story 8.5, L-29 lean). Turns the output of fixed, read-only commands into
// PASS / FAIL / SKIP lines. It changes nothing and never talks to the network.
//
//   node scripts/vmi-audit.mjs --from <folder> [--instances N] [--out <file>]   audit saved outputs (the VM runbook makes them)
//   node scripts/vmi-audit.mjs --local [--instances N] [--out <file>]           run the read-only docker commands on this machine
//
// Input files of --from (names fixed; see docs/runbooks/vmi-hardening.md for the commands that make them):
//   docker-info.json (docker info --format '{{json .}}'), daemon.json, iptables-docker-user.txt (iptables -S DOCKER-USER),
//   iptables-input.txt (iptables -S INPUT), inspect.json (docker inspect of every running container), ss.txt (ss -ltnH),
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
  input: 'iptables-input.txt',
  inspect: 'inspect.json',
  ss: 'ss.txt',
  imds: 'imds.json',
};
export const DEFAULT_INSTANCES = 50;
export const PUBLIC_PORTS = [22, 80, 443];
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

const cname = (c) => String(c?.Name ?? c?.Id ?? 'unknown').replace(/^\//, '');
const isInstance = (c) => {
  const labels = c?.Config?.Labels ?? {};
  return Object.keys(labels).some((k) => k === 'vm.instance' || k === 'vm.kind' && String(labels[k]).startsWith('inst')) || /^vm-i-/.test(cname(c));
};
const isProxy = (c) => /docker-proxy/.test(cname(c));

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
    for (const m of c.Mounts ?? []) {
      const src = String(m.Source ?? '');
      const isSock = SOCKET_PATHS.includes(src) || String(m.Destination ?? '').endsWith('docker.sock');
      if (isSock) {
        if (!(isProxy(c) && m.RW === false)) findings.push(`${n}: mounts the Docker socket${isProxy(c) ? ' read-write' : ''}`);
        continue;
      }
      if (m.Type === 'bind' && m.RW !== false && !BIND_ALLOW.some((a) => src === a || src.startsWith(`${a}/`))) findings.push(`${n}: writable bind mount of ${src || 'unknown'} outside the allow-list`);
      if (m.Type === 'bind' && SENSITIVE_BINDS.includes(src.replace(/\/+$/, '') || '/')) findings.push(`${n}: bind mount of the host path ${src}`);
    }
    if (isInstance(c)) {
      if (!(hc.CapDrop ?? []).map((s) => String(s).toUpperCase()).includes('ALL')) findings.push(`${n}: instance container does not drop ALL capabilities`);
      if (!(hc.SecurityOpt ?? []).some((s) => /^no-new-privileges(:true)?$/.test(s))) findings.push(`${n}: instance container lacks no-new-privileges`);
    }
  }
  return [row(findings.length ? 'FAIL' : 'PASS', name, findings.length ? findings.join('; ') : `${p.value.length} container(s): none privileged, no host network, socket only read-only in docker-proxy, no unlisted writable binds, instances drop ALL and set no-new-privileges`)];
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
  const bad = wide.filter((x) => !publicPorts.includes(x.port));
  if (bad.length) return [row('FAIL', name, `non-loopback listener(s) on port ${[...new Set(bad.map((b) => b.port))].sort((a, b) => a - b).join(', ')} (allowed: ${publicPorts.join(', ')})`)];
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

export function auditAll(inputs, { instances = DEFAULT_INSTANCES, skip = {} } = {}) {
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
  need('inspect', ['container-hardening'], auditInspect);
  need('ss', ['listening-ports'], auditListeners);
  if (skip.imds) rows.push(row('SKIP', 'imds-v2-required', skip.imds));
  else if (inputs.imds == null) rows.push(row('SKIP', 'imds-v2-required', `${FILES.imds} not provided (paste the aws output into it)`));
  else rows.push(...auditImds(inputs.imds));
  return rows;
}

export function parseArgs(argv) {
  const o = { mode: null, from: null, instances: DEFAULT_INSTANCES, out: null };
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
    rows = auditAll(readFrom(o.from), { instances: o.instances });
  } else {
    const inputs = readLocal();
    const skip = { dockerUser: 'Docker Desktop host has no iptables here (run on the VM)', input: 'Docker Desktop host has no iptables here (run on the VM)', ss: 'ss is not available here (run on the VM)', imds: 'AWS metadata check is a VM step' };
    if (inputs.daemon === null) skip.daemon = "Docker Desktop keeps the daemon settings in its own settings, no daemon.json found in the user's .docker folder";
    rows = auditAll(inputs, { instances: o.instances, skip });
  }
  const table = formatTable(rows);
  const text = redactEvidence(table);
  console.log(text);
  console.log(`\n${rows.filter((r) => r.status === 'PASS').length} PASS, ${rows.filter((r) => r.status === 'FAIL').length} FAIL, ${rows.filter((r) => r.status === 'SKIP').length} SKIP (${o.mode === 'local' ? 'local mode, read-only' : 'saved outputs'}; no live host result unless you ran the bundle on the host)`);
  if (o.out) writeFileSync(o.out, `${text}\n`);
  return exitCodeOf(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
