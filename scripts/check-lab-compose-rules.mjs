// Lint for the lab and harness compose files (D-43, ADR 0027): a lab container must not ask for rights that let it bypass the host filters.
// Fails on privileged: true, network_mode: host, pid: host, ipc: host, a mount of the Docker socket, userns_mode: host, an unconfined seccomp or apparmor
// profile, or a dangerous capability in cap_add (SYS_ADMIN, NET_ADMIN, SYS_PTRACE, SYS_MODULE, SYS_RAWIO, DAC_READ_SEARCH, ALL). There is ONE exception
// (story 4.2, ADR 0010, D-58): the service `docker-proxy` may mount the Docker socket, only as /var/run/docker.sock:/var/run/docker.sock:ro, with no other
// volume or bind and ports on 127.0.0.1 only. Any other exception needs a change to this script with a decision record. A root or privileged container can bypass host firewall rules (ADR 0027);
// the VPC security groups and network ACLs are the real boundary, so these rights are refused up front.
// Ports of the lab profile (story edge-2): in a service with profile `lab` only `edge-caddy` may publish, only 443:443, and 8080, 8081 and 9090 are never published.
// The orchestrator container (edge story 6, H-343; service `orchestrator`, profile `lab`): never a socket mount (the general rule), Docker only through `--docker-host tcp://docker-proxy:2375`, mutual TLS flags present,
// no --insecure-no-tls, --allow-fake-backend or --allow-local-images, non-root, read_only, cap_drop ALL, no-new-privileges, on labs-core only, and a published port only as 9443 to 8443 on 127.0.0.1 or ${VULNMART_ORCH_BIND:-127.0.0.1}.
// Two passes: a line scan for the old rules (comments are stripped first, so a comment that says "no privileged" does not fail), and a real YAML parse (js-yaml,\n// anchors and merge keys resolved) for the Docker socket, binds, ports and the pinned docker-proxy service.
// Usage: node scripts/check-lab-compose-rules.mjs [file or folder ...]   (default: every compose or harness file in the repository)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.venv', 'dist', 'build']);
const FILE_NAME = /^(docker-)?compose[^/]*\.ya?ml$|^docker-[^/]*\.ya?ml$|^harness[^/]*\.ya?ml$|^[^/]*\.compose\.ya?ml$|^lab\.reports\.ya?ml$/i;
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

// Published ports of the lab profile (story edge-2, D-62, D-28): the edge is the only way in, so only the service `edge-caddy` may publish a port, only 443
// (host side 443 too); the gate ports 8080, 8081 and 9090 are never published by any lab service. docker-proxy keeps its own loopback rule below.
export const EDGE_PUBLISHER = 'edge-caddy';
export const EDGE_PORT = 443;
export const NEVER_PUBLISHED = [8080, 8081, 9090];
// The orchestrator container (edge story 6, H-343): the only lab service besides edge-caddy and docker-proxy that may publish a port.
export const ORCH_SERVICE = 'orchestrator';
export const ORCH_HOST_PORT = 9443;
export const ORCH_CONTAINER_PORT = 8443;
export const ORCH_BIND_VAR = '${VULNMART_ORCH_BIND:-127.0.0.1}';
export const ORCH_PORT_FORMS = [`127.0.0.1:${ORCH_HOST_PORT}:${ORCH_CONTAINER_PORT}`, `${ORCH_BIND_VAR}:${ORCH_HOST_PORT}:${ORCH_CONTAINER_PORT}`];
// Flags that must never appear in the orchestrator's command: no TLS bypass, no fake backend, no local image ids, and no Docker API except the socket proxy on labs-core.
export const ORCH_FORBIDDEN_FLAGS = ['--insecure-no-tls', '--allow-fake-backend', '--allow-local-images'];
export const ORCH_DOCKER_HOST = 'tcp://docker-proxy:2375';

/** Checks of the orchestrator service on top of the general rules: hardening, no TLS bypass, Docker only through the proxy. */
function checkOrchestrator(def, name) {
  const out = [];
  const fail = (msg) => out.push(`${name}: service ${ORCH_SERVICE}: ${msg}`);
  const cmd = asList(def.command).map(String);
  for (const flag of ORCH_FORBIDDEN_FLAGS) if (cmd.includes(flag)) fail(`the command must not contain ${flag}`);
  const flagValue = (flag) => { const i = cmd.indexOf(flag); return i >= 0 ? cmd[i + 1] : undefined; };
  if (flagValue('--backend') !== undefined && flagValue('--backend') !== 'docker') fail('--backend must be docker (or not set)');
  if (flagValue('--docker-host') !== ORCH_DOCKER_HOST) fail(`--docker-host must be ${ORCH_DOCKER_HOST} (the socket proxy over labs-core), never a socket or the host`);
  for (const f of ['--tls-cert', '--tls-key', '--tls-ca']) if (!flagValue(f)) fail(`the command must set ${f} (mutual TLS is required on the published listener)`);
  if (def.user === undefined || /^(0|root)(:|$)/.test(String(def.user))) fail('user must be set to a non-root user');
  if (def.read_only !== true) fail('read_only must be true');
  if (!asList(def.cap_drop).map(String).includes('ALL')) fail('cap_drop must contain ALL');
  if (asList(def.cap_add).length) fail('cap_add must be empty');
  if (!asList(def.security_opt).map(String).includes('no-new-privileges:true')) fail('security_opt must contain no-new-privileges:true');
  const nets = Array.isArray(def.networks) ? def.networks.map(String) : Object.keys(def.networks ?? {});
  if (nets.length !== 1 || nets[0] !== 'labs-core') fail('networks must be exactly labs-core');
  for (const s of asList(def.secrets)) {
    const target = typeof s === 'string' ? s : String(s?.target ?? s?.source ?? '');
    if (/\//.test(target)) fail(`a secret target is a file name under /run/secrets, not a path (${target})`);
  }
  for (const e of Object.entries(def.environment && typeof def.environment === 'object' && !Array.isArray(def.environment) ? def.environment : {})) {
    if (/DOCKER_HOST|DOCKER_SOCK/i.test(e[0])) fail(`environment ${e[0]} is not allowed (the Docker address is the --docker-host flag)`);
    if (/^VM_ORCH_(PLATFORM|REPORT)_KEY$/.test(e[0])) fail(`environment ${e[0]} would put a signing key into docker inspect: use a file secret and the _FILE variable`);
  }
  return out;
}

/** { host, container } of one ports entry (short or long form); a number or null when it cannot be read (a range, a variable, a missing value). */
export function portNumbers(port) {
  const num = (v) => (/^\d{1,5}$/.test(String(v ?? '').trim()) ? Number(v) : null);
  if (port && typeof port === 'object') return { host: num(port.published), container: num(port.target) };
  if (typeof port === 'number') return { host: null, container: port };
  const parts = String(port).trim().replace(/\/(tcp|udp|sctp)$/i, '').split(':');
  if (parts.length === 1) return { host: null, container: num(parts[0]) };
  return { host: num(parts[parts.length - 2]), container: num(parts[parts.length - 1]) };
}

function checkLabPorts(svc, def, name) {
  const profiles = asList(def.profiles).map(String);
  const ports = asList(def.ports);
  if (!profiles.includes('lab') || !ports.length) return [];
  const out = [];
  const fail = (msg) => out.push(`${name}: service ${svc}: ${msg}`);
  for (const p of ports) {
    const { host, container } = portNumbers(p);
    if (container === null) { fail(`the ports entry ${JSON.stringify(p)} cannot be read (a range or a variable is not allowed for a lab service)`); continue; }
    if (NEVER_PUBLISHED.includes(container) || (host !== null && NEVER_PUBLISHED.includes(host))) fail(`port ${NEVER_PUBLISHED.includes(container) ? container : host} (8080, 8081 and 9090) must never be published`);
    if (svc === SOCKET_PROXY_SERVICE) continue; // its own rule: loopback only
    if (svc === ORCH_SERVICE) {
      // the one other publisher: the orchestrator listener, 9443 on the host to 8443 in the container, bound to loopback or to the operator's private address variable
      const ok = typeof p === 'string'
        ? ORCH_PORT_FORMS.includes(p.trim())
        : p && typeof p === 'object' && Number(p.target) === ORCH_CONTAINER_PORT && Number(p.published) === ORCH_HOST_PORT && (p.host_ip === '127.0.0.1' || p.host_ip === ORCH_BIND_VAR);
      if (!ok) fail(`${ORCH_SERVICE} may publish only ${ORCH_PORT_FORMS.map((f) => JSON.stringify(f)).join(' or ')} (loopback by default, never 0.0.0.0, never a public address), got ${JSON.stringify(p)}`);
      continue;
    }
    if (svc !== EDGE_PUBLISHER) fail(`a lab service must not publish a port (only ${EDGE_PUBLISHER} publishes, and only ${EDGE_PORT})`);
    else if (container !== EDGE_PORT || host !== EDGE_PORT) fail(`${EDGE_PUBLISHER} may publish only ${EDGE_PORT}:${EDGE_PORT} (got ${JSON.stringify(p)})`);
  }
  return out;
}

// The override file `lab.reports.yaml` (edge story 7) may only add the report key and report CA secrets and the two variables that name them to the
// service `orchestrator`; it is never merged by the default `up`, so it must not be able to change anything else of that service.
export const OVERRIDE_FILE = /(^|\/)lab\.reports\.ya?ml$/;
export const OVERRIDE_ENV = { VM_ORCH_REPORT_KEY_FILE: '/run/secrets/report_key', SSL_CERT_FILE: '/run/secrets/report_ca' };
export const OVERRIDE_SECRETS = {
  'orch-report-key': { target: 'report_key', file: '${VULNMART_ORCH_DIR:-/opt/vulnmart/lab/orchestrator}/secrets/report_key' },
  'orch-report-ca': { target: 'report_ca', file: '${VULNMART_ORCH_DIR:-/opt/vulnmart/lab/orchestrator}/secrets/report_ca.pem' },
};

function checkOverride(doc, name) {
  const out = [];
  const fail = (msg) => out.push(`${name}: ${msg}`);
  for (const k of Object.keys(doc)) if (!['services', 'secrets'].includes(k)) fail(`an override file may have only services and secrets at the top, not ${k}`);
  const services = doc.services && typeof doc.services === 'object' ? doc.services : {};
  for (const [svc, def] of Object.entries(services)) {
    if (svc !== ORCH_SERVICE) { fail(`an override file may change only the service ${ORCH_SERVICE}, not ${svc}`); continue; }
    for (const k of Object.keys(def ?? {})) if (!['environment', 'secrets'].includes(k)) fail(`service ${svc}: an override may add only environment and secrets, not ${k}`);
    const env = def?.environment;
    const pairs = Array.isArray(env) ? env.map((e) => String(e).split(/=(.*)/s).slice(0, 2)) : Object.entries(env ?? {});
    for (const [k, v] of pairs) {
      if (!(k in OVERRIDE_ENV)) fail(`service ${svc}: environment ${k} is not allowed in an override (only ${Object.keys(OVERRIDE_ENV).join(', ')})`);
      else if (String(v) !== OVERRIDE_ENV[k]) fail(`service ${svc}: ${k} must be ${OVERRIDE_ENV[k]}`);
    }
    for (const s of Array.isArray(def?.secrets) ? def.secrets : []) {
      const source = typeof s === 'string' ? s : String(s?.source ?? '');
      const target = typeof s === 'string' ? s : String(s?.target ?? s?.source ?? '');
      if (!(source in OVERRIDE_SECRETS) || target !== OVERRIDE_SECRETS[source].target) fail(`service ${svc}: an override may add only the secrets ${Object.keys(OVERRIDE_SECRETS).join(' and ')} with their fixed target (got ${JSON.stringify(s)})`);
    }
  }
  const top = doc.secrets && typeof doc.secrets === 'object' ? doc.secrets : {};
  for (const [k, v] of Object.entries(top)) {
    if (!(k in OVERRIDE_SECRETS)) fail(`secrets: only ${Object.keys(OVERRIDE_SECRETS).join(' and ')} may be defined here, not ${k}`);
    else if (!v || typeof v !== 'object' || Object.keys(v).join() !== 'file' || String(v.file) !== OVERRIDE_SECRETS[k].file) fail(`secrets: ${k} must be {file: ${OVERRIDE_SECRETS[k].file}}`);
  }
  return out;
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
  if (OVERRIDE_FILE.test(name)) problems.push(...checkOverride(doc, name));
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
    problems.push(...checkLabPorts(svc, def, name));
    if (svc === ORCH_SERVICE && asList(def.profiles).map(String).includes('lab')) problems.push(...checkOrchestrator(def, name));
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