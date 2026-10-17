// Helpers of the local end-to-end loop (story 8.3): scripts/e2e/loop.e2e.test.mjs and scripts/load-check.mjs.
// The PURE helpers (labels, leftovers, bounded poll, redaction, signing, manifest, small parsers) are tested without Docker in
// loop-support.test.mjs. The IMPURE helpers (docker, processes, the orchestrator) are copied from the patterns of scripts/demo.mjs
// and scripts/e2e/edge.e2e.test.mjs, which are not changed. Node built-ins only (plus the exports of demo.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, killTree, redact } from '../demo.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KIND = 'loop-test';
export const STUB_TAG = 'vulnmart-stub-instance:local';

// ---------------------------------------------------------------- pure helpers
export const newRunId = () => `vmloop${randomBytes(3).toString('hex')}`;

/** The docker arguments that label an object as made by this run. */
export function runLabels(runId, kind = KIND) {
  if (!/^[a-z0-9]{4,32}$/.test(runId)) throw new Error('bad run id');
  return ['--label', `vm.kind=${kind}`, '--label', `vm.run=${runId}`];
}

/** Docker filter arguments (`--filter label=...`) for the run, or for the whole kind when no id is given. */
export function labelFilter(runId, kind = KIND) {
  return ['--filter', runId ? `label=vm.run=${runId}` : `label=vm.kind=${kind}`];
}

/** Lines of a `docker ... -q` listing without blanks and duplicates. */
export function lines(text) {
  return [...new Set(String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

/** What is left, from three `docker ... -q` outputs. `total` is 0 when nothing is left. */
export function findLeftovers({ containers = '', networks = '', volumes = '' } = {}) {
  const c = lines(containers); const n = lines(networks); const v = lines(volumes);
  return { containers: c, networks: n, volumes: v, total: c.length + n.length + v.length };
}

export function leftoverText(left) {
  return `containers ${left.containers.length}, networks ${left.networks.length}, volumes ${left.volumes.length}`;
}

/** Calls `fn` until it returns a truthy value; throws `waited for <label>` with the last note after `timeoutMs`. `sleep` and `now` can be replaced. */
export async function pollUntil(fn, { timeoutMs = 30000, intervalMs = 500, label = 'a condition', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const end = now() + timeoutMs;
  let last = 'no answer';
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = 'condition false';
    } catch (e) {
      last = String(e?.message ?? e).slice(0, 200);
    }
    if (now() >= end) throw new Error(`timeout after ${timeoutMs} ms waiting for ${label} (last: ${last})`);
    await sleep(intervalMs);
  }
}

/** Redaction for logs and evidence: the demo rules, plus every given secret string replaced as <secret>. */
export function redactAll(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('<secret>');
  return redact(out)
    .replace(/(x-lab-demo-token|x-vm-gate-admin|x-vm-signature)\s*[:=]\s*\S+/gi, '$1=<secret>')
    .replace(/_vm\/enter\?t=[^\s&"']+/g, '_vm/enter?t=<ticket>')
    .replace(/__Host-vm_gate=[^\s;"']+/g, '__Host-vm_gate=<cookie>');
}

/** The last `n` lines of a log, redacted (for a failure message that names the hop). */
export function tailRedacted(text, n = 8, secrets = []) {
  return redactAll(String(text).split(/\r?\n/).filter(Boolean).slice(-n).join(' | '), secrets);
}

/** The signing rule of orchestrator-api.md section 4 (the key is the text of the key file). */
export function orchSign(key, method, target, ts, nonce, body) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const s = ['v1', method.toUpperCase(), target, ts, nonce, bodyHash].join('\n');
  return `v1=${createHmac('sha256', key).update(s).digest('hex')}`;
}

/** The images manifest of the loop: the stub image in every role, and the sidecar command that points at the edge relay. */
export function loopManifest({ stubId, relayUrl }) {
  const m = buildManifest({ stubId, shopId: stubId, realShop: false });
  m.images.sidecar = stubId;
  m.commands.sidecar = ['sidecar', '--relay', relayUrl, '--upstream', 'http://shop:3000'];
  return m;
}

/** The loop template: injector, shop and sidecar of the shop template (the stub can run these three). */
export function loopTemplate(template) {
  const t = structuredClone(template);
  t.components = t.components.filter((c) => ['injector', 'shop', 'sidecar'].includes(c.role));
  return t;
}

/** `docker stats --format "{{.MemUsage}}"` text such as "12.5MiB / 256MiB" to MiB of the first number. */
export function parseMemMiB(text) {
  const m = /^\s*([\d.]+)\s*([KMG]i?B|B)\b/i.exec(String(text));
  if (!m) return null;
  const v = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'b') return v / 1048576;
  if (unit.startsWith('k')) return v / 1024;
  if (unit.startsWith('m')) return v;
  return v * 1024;
}

/** "i-" plus 16 Base32 characters. */
export const isInstanceId = (s) => /^i-[A-Z2-7]{16}$/.test(String(s));
export const hostOf = (id, zone) => `${String(id).toLowerCase()}.${zone}`;

// ---------------------------------------------------------------- impure helpers
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command and resolves { status, stdout, stderr } (never throws). */
export function run(cmd, args, { input, timeout = 240000, env, cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: String(e) }); });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

export const docker = (args, opts) => run('docker', args, opts);

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

export function portFreeOn(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

export function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

export function toolOk(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return r.status === 0;
}

export function imageId(tag) {
  const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const id = (r.stdout ?? '').trim();
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

/** Starts a child with output to a log file; returns it with `.logFile`. The key goes in the environment, never on a command line. */
export function startLogged(cmd, args, { env, logFile, cwd = ROOT } = {}) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' });
  child.logFile = logFile;
  return child;
}

export function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export async function waitListening(child, port, timeoutMs = 240000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    if (await canConnect(port)) return true;
    await sleep(500);
  }
  return false;
}

/** The real orchestrator (Docker backend, laptop host kind), as scripts/demo.mjs starts it. Extra args (the edge flags) go at the end. */
export function startOrchestrator({ dir, manifest, port, key, healthTimeoutS = 60, extraArgs = [] }) {
  const manifestFile = path.join(dir, 'images.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
  const args = [
    'run', '--locked', '--package', 'vulnmart-orchestrator', 'python', '-m', 'vulnmart_orchestrator',
    '--host', '127.0.0.1', '--port', String(port), '--backend', 'docker', '--host-kind', 'laptop',
    '--templates-dir', path.join(dir, 'templates'), '--template-schema', path.join(dir, 'template.schema.json'), '--images-manifest', manifestFile,
    '--health-timeout-s', String(healthTimeoutS), '--injector-timeout-s', '30', '--rate-per-s', '0', '--allow-local-images', ...extraArgs,
  ];
  return startLogged('uv', args, { env: { VM_ORCH_PLATFORM_KEY: key }, logFile: path.join(dir, `orchestrator-${port}.log`) });
}

/** One signed call to the orchestrator. Resolves { status, json }. */
export async function orchCall(base, key, method, target, bodyObj) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  const nonce = randomBytes(16).toString('hex');
  const res = await fetch(base + target, {
    method,
    headers: { 'content-type': 'application/json', 'x-vm-timestamp': ts, 'x-vm-nonce': nonce, 'x-vm-signature': orchSign(key, method, target, ts, nonce, body) },
    body: method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json };
}

export { killTree };
