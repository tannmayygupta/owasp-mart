// Lint for the lab and harness compose files (D-43, ADR 0027): a lab container must not ask for rights that let it bypass the host filters.
// Fails on privileged: true, network_mode: host, pid: host, ipc: host, a mount of the Docker socket, userns_mode: host, an unconfined seccomp or apparmor
// profile, or a dangerous capability in cap_add (SYS_ADMIN, NET_ADMIN, SYS_PTRACE, SYS_MODULE, SYS_RAWIO, DAC_READ_SEARCH, ALL). There is ONE exception
// (story 4.2, ADR 0010, D-58): the service `docker-proxy` may mount the Docker socket, only as /var/run/docker.sock:/var/run/docker.sock:ro, with no other
// volume or bind and ports on 127.0.0.1 only. Any other exception needs a change to this script with a decision record. A root or privileged container can bypass host firewall rules (ADR 0027);
// the VPC security groups and network ACLs are the real boundary, so these rights are refused up front.
// Two passes: a line scan for the old rules (comments are stripped first, so a comment that says "no privileged" does not fail), and a real YAML parse (js-yaml,\n// anchors and merge keys resolved) for the Docker socket, binds, ports and the pinned docker-proxy service.
// Usage: node scripts/check-lab-compose-rules.mjs [file or folder ...]   (default: every compose or harness file in the repository)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.venv', 'dist', 'build']);
const FILE_NAME = /^(docker-)?compose[^/]*\.ya?ml$|^docker-[^/]*\.ya?ml$|^harness[^/]*\.ya?ml$|^[^/]*\.compose\.ya?ml$/i;
export const SOCKET_PROXY_SERVICE = 'docker-proxy';
export const SOCKET_PROXY_IMAGE = 'tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459';
export const SOCKET_PROXY_COMMAND = ['haproxy', '-f', '/usr/local/etc/haproxy/docker-proxy-rules.cfg'];
export const DANGEROUS_CAPS = ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_RAWIO', 'DAC_READ_SEARCH', 'ALL'];

const stripComment = (line) => line.replace(/(^|\s)#.*$/, '');
const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

const SOCK = '/var/run/docker.sock';
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Source and mode of one volume entry (short or long form); `bind` is true when the source is a host path. */
function volumeInfo(v) {
  if (typeof v === 'string') {
    const parts = v.split(':');
    const source = parts.length > 1 ? parts[0] : '';
    const mode = parts.length > 2 ? parts.slice(2).join(':') : '';
    return { source, target: parts.length > 1 ? parts[1] : parts[0], readOnly: mode.split(',').includes('ro'), bind: /^[/.~]/.test(source), raw: v };
  }
  if (v && typeof v === 'object') {
    const source = String(v.source ?? '');
    return { source, target: String(v.target ?? ''), readOnly: v.read_only === true, bind: v.type === 'bind' || /^[/.~]/.test(source), raw: JSON.stringify(v) };
  }
  return { source: '', target: '', readOnly: false, bind: false, raw: String(v) };
}

/** True when binding `source` would give the container the Docker socket (the socket itself, a parent folder of it, or a Docker run folder). */
function exposesSocket(source) {
  if (!source) return false;
  const s = path.posix.normalize(source.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1');
  return s === '/' || s === '/var' || s === '/var/run' || s === '/run' || /^\/(var\/)?run\/docker(\.sock|\/|$)/.test(s) || /docker\.sock$/.test(s);
}

function publishesOnLoopbackOnly(port) {
  if (typeof port === 'string') return /^127\.0\.0\.1:/.test(port.trim());
  if (port && typeof port === 'object') return port.host_ip === '127.0.0.1' && port.published !== undefined;
  return false; // a bare number publishes on every interface
}

/** Checks on the parsed document: the one Docker socket exception (service docker-proxy) and the shapes a line scan cannot see. */
function checkParsed(text, name, lineProblems) {
  const problems = [];
  const fail = (msg) => problems.push(`${name}: ${msg}`);
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    return [`${name}: cannot parse the YAML (${String(e.reason || e.message).slice(0, 120)}), so the socket rules cannot be checked`];
  }
  if (!doc || typeof doc !== 'object') return problems;
  if (doc.include !== undefined) fail('include is not allowed (a compose file may not pull in another one unchecked)');
  const has = (kind) => lineProblems.some((p) => p.includes(kind));
  for (const [svc, def] of Object.entries(doc.services && typeof doc.services === 'object' ? doc.services : {})) {
    if (!def || typeof def !== 'object') continue;
    const where = `service ${svc}`;
    if (def.privileged === true || /^(true|yes|on)$/i.test(String(def.privileged)) ) { if (!has('privileged: true')) fail(`${where}: privileged is not allowed`); }
    if (String(def.network_mode) === 'host' && !has('network_mode: host')) fail(`${where}: network_mode: host is not allowed`);
    if (String(def.pid) === 'host' && !has('pid: host')) fail(`${where}: pid: host is not allowed`);
    if (String(def.ipc) === 'host' && !has('ipc: host')) fail(`${where}: ipc: host is not allowed`);
    if (def.extends !== undefined) fail(`${where}: extends is not allowed`);
    for (const from of asList(def.volumes_from)) {
      if (String(from).split(':')[0] === SOCKET_PROXY_SERVICE) fail(`${where}: volumes_from ${SOCKET_PROXY_SERVICE} would hand over the Docker socket`);
    }
    for (const d of asList(def.devices)) {
      const src = typeof d === 'string' ? d.split(':')[0] : String(d?.source ?? '');
      if (exposesSocket(src) || /docker/.test(src)) fail(`${where}: a device entry that exposes the Docker socket is not allowed`);
    }
    const vols = asList(def.volumes).map(volumeInfo);
    if (svc !== SOCKET_PROXY_SERVICE) {
      for (const v of vols) {
        if (v.bind && exposesSocket(v.source)) fail(`a Docker socket mount is not allowed (${where}; ${v.raw}; only the service ${SOCKET_PROXY_SERVICE} may mount it, read-only)`);
      }
      continue;
    }
    // ---- the one exception: docker-proxy
    const only = vols.length === 1 && vols[0].source === SOCK && vols[0].target === SOCK && vols[0].readOnly;
    if (!only) fail(`a Docker socket mount is not allowed in ${SOCKET_PROXY_SERVICE} unless it has exactly one volume, ${SOCK}:${SOCK}:ro`);
    for (const port of asList(def.ports)) {
      if (!publishesOnLoopbackOnly(port)) fail(`${where}: ports may be published on 127.0.0.1 only (host_ip in the long form), not ${JSON.stringify(port)}`);
    }
    if (def.image !== SOCKET_PROXY_IMAGE) fail(`${where}: the image must be exactly ${SOCKET_PROXY_IMAGE} (pinned by digest)`);
    if (JSON.stringify(def.command) !== JSON.stringify(SOCKET_PROXY_COMMAND)) fail(`${where}: the command must be exactly ${JSON.stringify(SOCKET_PROXY_COMMAND)}`);
    if (def.user !== undefined) fail(`${where}: user must not be set (the image default)`);
    if (def.privileged !== undefined && def.privileged !== false) fail(`${where}: privileged is not allowed`);
    if (def.network_mode !== undefined || def.pid !== undefined || def.ipc !== undefined) fail(`${where}: network_mode, pid and ipc must not be set`);
    if (asList(def.cap_add).length) fail(`${where}: cap_add must be empty`);
    if (!asList(def.cap_drop).map(String).includes('ALL')) fail(`${where}: cap_drop must contain ALL`);
    if (def.read_only !== true) fail(`${where}: read_only must be true`);
  }
  return problems;
}
/** @returns {string[]} one message per violation, with the line number */
export function checkComposeText(text, name = 'compose file') {
  const problems = [];
  const lines = text.split(/\r?\n/).map(stripComment);
  const fail = (i, msg) => problems.push(`${name}:${i + 1}: ${msg}`);
  const isTrue = (v) => /^(true|yes|on|1)$/i.test(unquote(v));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(?:-\s*)?privileged:\s*(.*)$/.exec(line)) && isTrue(m[1])) fail(i, 'privileged: true is not allowed');
    if ((m = /^\s*(?:-\s*)?network_mode:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'network_mode: host is not allowed');
    if ((m = /^\s*(?:-\s*)?pid:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'pid: host is not allowed');
    if ((m = /^\s*(?:-\s*)?ipc:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'ipc: host is not allowed');
    if ((m = /^\s*(?:-\s*)?userns_mode:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'userns_mode: host is not allowed');
    if (/(seccomp|apparmor)\s*[:=]\s*unconfined/i.test(line)) fail(i, 'an unconfined seccomp or apparmor profile is not allowed');
    if ((m = /^(\s*)cap_add:\s*(.*)$/.exec(line))) {
      const items = [];
      if (m[2].trim().startsWith('[')) items.push(...m[2].replace(/[[\]]/g, '').split(',').map(unquote));
      else {
        const indent = m[1].length;
        for (let j = i + 1; j < lines.length; j++) {
          const mm = /^(\s*)-\s*(.*)$/.exec(lines[j]);
          if (lines[j].trim() === '') continue;
          if (!mm || mm[1].length < indent) break;
          items.push(unquote(mm[2]));
        }
      }
      for (const cap of items) {
        const c = cap.toUpperCase().replace(/^CAP_/, '');
        if (DANGEROUS_CAPS.includes(c)) fail(i, `cap_add ${c} is not allowed`);
      }
    }
  }
  problems.push(...checkParsed(text, name, problems));
  return problems;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (FILE_NAME.test(entry.name)) yield path.join(dir, entry.name);
  }
}

export function findComposeFiles(targets = [ROOT]) {
  const out = [];
  for (const t of targets) {
    const abs = path.resolve(t);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

export function checkFiles(files) {
  return files.flatMap((f) => checkComposeText(readFileSync(f, 'utf8'), path.relative(ROOT, f).split(path.sep).join('/')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = findComposeFiles(process.argv.length > 2 ? process.argv.slice(2) : [ROOT]);
  const problems = checkFiles(files);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`PASS lab compose rules: ${files.length} file(s) checked, none uses privileged, host network or pid, the Docker socket, or a dangerous capability`);
}