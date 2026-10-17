// `node scripts/dev.mjs demo [--keep] [--stub-only] [--no-web]` (story 17): one command that shows sprints 1 and 2 running
// on this machine. Node built-ins only. The logic is here; the pure parts (arguments, table, redaction, manifest, step lines)
// are exported and tested in scripts/demo.test.mjs. The real run is checked by hand (docs/runbooks/local-demo.md).
//
// Safety: the Compose project is named `vulnmart-demo`; only containers, networks and volumes of that project or labelled
// `vm.instance` are ever removed, and only after a check that none existed before the run. Keys and manifests are random
// temporary files, removed afterwards. Nothing is pushed, signed with a real key or sent outside 127.0.0.1.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPOSE_FILE, MSG_DOCKER_DOWN, doctor, dockerRunning, portFree, run } from './dev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'vulnmart-demo';
export const STUB_TAG = 'vulnmart-stub-instance:local';
export const SHOP_TAG = 'vulnmart-shop:local';
export const PLATFORM_CONTAINERS = ['postgres', 'valkey', 'mailpit', 'migrate', 'api', 'worker', 'web'].map((s) => `vulnmart-${s}`);
export const EVIDENCE_FILE = path.join(ROOT, 'docs', 'assets', 'local-demo', 'demo-output.txt');
const TEMPLATE_FILE = path.join(ROOT, 'contracts', 'instance', 'examples', 'valid', 'instance-template', 'shop-template.json');
const TEMPLATE_SCHEMA = path.join(ROOT, 'contracts', 'instance', 'instance-template.schema.json');
const DEV_ORIGIN_SECRET = process.env.VULNMART_DEV_ORIGIN_SECRET || 'vulnmart-dev-origin-secret-not-a-secret';

export const DEMO_USAGE = 'node scripts/dev.mjs demo [--keep] [--stub-only] [--no-web] | demo down';

// ---------- pure parts ----------
export function parseDemoArgs(rest) {
  if (rest.length === 1 && rest[0] === 'down') return { down: true };
  const known = { '--keep': 'keep', '--stub-only': 'stubOnly', '--no-web': 'noWeb' };
  const out = { keep: false, stubOnly: false, noWeb: false };
  for (const a of rest) {
    if (!(a in known)) return { error: `Unknown option "${a}". Usage: ${DEMO_USAGE}` };
    out[known[a]] = true;
  }
  return out;
}

export function platformProfiles({ noWeb }) {
  return noWeb ? ['platform'] : ['platform', 'web'];
}

export function platformPorts({ noWeb }) {
  return noWeb ? [8000, 8025] : [3000, 8000, 8025];
}

// Words that must never reach the screen or the evidence file: addresses, long hex values (keys, digests), flags, home paths.
export function redact(text) {
  return String(text)
    .replace(/VM\{[^}]*\}/g, '<flag>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hex>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<addr>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '<home>')
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, '<home>');
}

export const STATUSES = ['PASS', 'FAIL', 'SKIP'];

export function formatLine({ status, name, detail }) {
  return `${status} ${name}: ${detail}`;
}

export function formatTable(rows) {
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  const head = `${'STATUS'.padEnd(6)}  ${'STEP'.padEnd(w)}  DETAIL`;
  const sep = `${'-'.repeat(6)}  ${'-'.repeat(w)}  ${'-'.repeat(40)}`;
  return [head, sep, ...rows.map((r) => `${r.status.padEnd(6)}  ${r.name.padEnd(w)}  ${r.detail}`)].join('\n');
}

export function exitCode(rows) {
  return rows.some((r) => r.status === 'FAIL') ? 1 : 0;
}

// Lines printed by scripts/demo_client.py: `STEP {"name":..,"ok":..,"detail":..}`. Anything else is ignored.
export function parseStepLines(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith('STEP ')) continue;
    try {
      const o = JSON.parse(line.slice(5));
      if (typeof o.name === 'string' && typeof o.ok === 'boolean') rows.push({ status: o.ok ? 'PASS' : 'FAIL', name: o.name, detail: String(o.detail ?? '') });
    } catch {
      /* not a step line */
    }
  }
  return rows;
}

// Lines `IID i-...` printed by scripts/demo_client.py for every instance id it makes: the demo cleans up only these.
export function parseInstanceIds(stdout) {
  const ids = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^IID (i-[A-Z2-7]{16})$/.exec(line.trim());
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

// Only these doctor lines matter for the demo (pnpm is not needed to run it).
export function evaluateDoctor(lines, needed = ['Node', 'uv', 'Docker', 'Compose', 'Docker engine']) {
  const rows = lines.map((l) => {
    const m = /^(PASS|FAIL)\s+(.+?)\s{2,}(.*)$/.exec(l.trim());
    return m ? { ok: m[1] === 'PASS', label: m[2].trim(), text: m[3].trim() } : null;
  }).filter(Boolean);
  const wanted = rows.filter((r) => needed.includes(r.label));
  const missing = needed.filter((n) => !wanted.some((r) => r.label === n));
  const failed = wanted.filter((r) => !r.ok).map((r) => r.label);
  return { ok: !missing.length && !failed.length, failed: [...failed, ...missing], text: wanted.map((r) => `${r.label} ${/v?\d[\w.]*/.exec(r.text)?.[0] ?? r.text.split(' ')[0]}`).join(', ') };
}

// The reduced template: the shop template with only the two components the stub (and the real shop) can run.
export function reduceTemplate(template) {
  const t = structuredClone(template);
  t.components = t.components.filter((c) => c.role === 'injector' || c.role === 'shop');
  return t;
}

// The template schema with the "six components" rule lowered to the two the demo runs (shop and injector). A temporary copy only;
// contracts/instance/instance-template.schema.json is never changed.
export function relaxSchema(schema) {
  const s = structuredClone(schema);
  const comps = s.properties.components;
  delete comps.minItems;
  comps.allOf = comps.allOf.filter((r) => ['shop', 'injector'].includes(r.contains?.properties?.role?.const));
  return s;
}

// The image manifest file of the orchestrator (images pinned by id). `shopId` is the real shop image or the stub id.
export function buildManifest({ stubId, shopId, realShop }) {
  const manifest = {
    images: { shop: shopId, injector: stubId, 'volume-keeper': stubId },
    entrypoints: { 'volume-keeper': ['node', '-e', 'setInterval(()=>{},1<<30)'] },
    commands: { injector: ['inject'] },
  };
  // the distroless shop image has no wget: its own check (the one of its HEALTHCHECK) runs with its node
  if (realShop) manifest.healthchecks = { shop: ['CMD', '/nodejs/bin/node', '-e', "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] };
  if (!realShop) manifest.commands.shop = ['shop']; // the stub picks its role from the first argument; the real shop uses its own CMD
  return manifest;
}

export function leftoverNames(psOutput, wanted = PLATFORM_CONTAINERS) {
  return String(psOutput).split(/\r?\n/).map((s) => s.trim()).filter((n) => wanted.includes(n));
}

export function evidenceText({ date, args, mode, rows, note, image }) {
  const opts = [args.keep && '--keep', args.stubOnly && '--stub-only', args.noWeb && '--no-web'].filter(Boolean).join(' ') || '(none)';
  return redact([
    'VulnMart local demo output (node scripts/dev.mjs demo)',
    `Date: ${date}`,
    `Options: ${opts}`,
    `Shop role: ${mode}`,
    ...(image ? [`Image in the shop role: ${image}`] : []),
    ...(note ? [`Note: ${note}`] : []),
    '',
    formatTable(rows),
    '',
    `Result: ${exitCode(rows) !== 0 ? 'at least one step FAIL' : rows.some((r) => r.status === 'SKIP') ? 'no step FAIL; some steps SKIP (see the table)' : 'every step PASS'}`,
    '',
  ].join('\n'));
}

// ---------- impure parts ----------
const compose = (args, profiles = ['platform', 'web'], opts = {}) =>
  run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...profiles.flatMap((p) => ['--profile', p]), ...args], { timeout: 1200000, ...opts });
const liveChildren = new Set();
let exitHookSet = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dockerLines = (args) => run('docker', args, { timeout: 60000 }).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000), redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function waitHealthy(url, tries = 60) {
  let last = 'no answer';
  for (let i = 0; i < tries; i++) {
    try {
      const r = await getText(url);
      if (r.status === 200) return r;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.message;
    }
    await sleep(1500);
  }
  throw new Error(`no 200 after ${tries} tries (${last})`);
}

// `uv run` starts the Python service as its child: kill the whole tree (Windows: taskkill /T /F; POSIX: the process group, see spawn).
export function killTree(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

function imageId(tag) {
  const r = run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { timeout: 60000 });
  const id = r.stdout.trim();
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

function startOrchestrator({ dir, manifest, port, key, healthTimeoutS, log }) {
  const manifestFile = path.join(dir, 'images.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
  const out = fs.openSync(path.join(dir, `orchestrator-${port}.log`), 'a');
  const args = [
    'run', '--locked', '--package', 'vulnmart-orchestrator', 'python', '-m', 'vulnmart_orchestrator',
    '--host', '127.0.0.1', '--port', String(port), '--backend', 'docker', '--host-kind', 'laptop',
    '--templates-dir', path.join(dir, 'templates'), '--template-schema', path.join(dir, 'template.schema.json'), '--images-manifest', manifestFile,
    '--health-timeout-s', String(healthTimeoutS), '--injector-timeout-s', '30', '--rate-per-s', '0',
    '--allow-local-images', // the manifest holds the ids of images built on this machine (no registry)
  ];
  // the key goes in the environment, never on the command line; detached on POSIX so that the process group can be killed
  const child = spawn('uv', args, { cwd: ROOT, env: { ...process.env, VM_ORCH_PLATFORM_KEY: key }, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' });
  liveChildren.add(child);
  if (!exitHookSet) { exitHookSet = true; process.on('exit', () => { for (const c of liveChildren) killTree(c); }); } // never leave the service behind, whatever ends the demo
  child.logFile = path.join(dir, `orchestrator-${port}.log`);
  log(`orchestrator process started (pid ${child.pid})`);
  return child;
}

async function waitListening(child, port, timeoutMs = 240000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    if (await canConnect(port)) return true;
    await sleep(500);
  }
  return false;
}

function tailFile(file, lines = 12) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function runClient({ port, keyFile, mode, probe }) {
  const args = ['run', '--locked', '--package', 'vulnmart-api', 'python', path.join('scripts', 'demo_client.py'),
    '--url', `http://127.0.0.1:${port}`, '--key-file', keyFile, '--mode', mode, ...(probe ? ['--probe', '--wait-s', '90'] : [])];
  const r = spawnSync('uv', args, { cwd: ROOT, encoding: 'utf8', timeout: 900000, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// `demo down`: remove the demo project and its volumes (after a --keep run). Touches only the project vulnmart-demo.
export function demoDown({ log = console.log, err = console.error } = {}) {
  if (!dockerRunning()) { err(MSG_DOCKER_DOWN); return 1; }
  const r = compose(['down', '-v', '--remove-orphans', '--timeout', '2']);
  if (r.status !== 0) { err(r.stderr); return 1; }
  log(`Project ${PROJECT} stopped and removed with its volumes.`);
  return 0;
}

export async function demo(argv = []) {
  const args = parseDemoArgs(argv);
  if (args.error) { console.error(args.error); return 1; }
  if (args.down) return demoDown();

  const rows = [];
  const record = (status, name, detail) => {
    const row = { status, name, detail: redact(detail) };
    rows.push(row);
    console.log(formatLine(row));
    return status !== 'FAIL';
  };
  const t0 = Date.now();
  const log = (m) => console.log(`  ... ${redact(m)}`);
  let tmp = null;
  let orch = null;
  let stackStarted = false;
  let mode = 'not reached';
  let note = '';
  let ranWork = false;
  let imageUsed = '';
  const madeIds = new Set(); // instance ids the client reported: the only ones the cleanup removes

  try {
    // 1. Preflight
    const lines = [];
    doctor({ log: (l) => lines.push(l) });
    const d = evaluateDoctor(lines);
    if (!record(d.ok ? 'PASS' : 'FAIL', 'preflight-tools', d.ok ? d.text : `missing or wrong: ${d.failed.join(', ')}`)) return finish();
    if (!dockerRunning()) { record('FAIL', 'preflight-docker', MSG_DOCKER_DOWN); return finish(); }
    const clash = leftoverNames(dockerLines(['ps', '-a', '--format', '{{.Names}}']).join('\n'));
    const labelled = dockerLines(['ps', '-a', '-q', '--filter', 'label=vm.instance']).length
      + dockerLines(['network', 'ls', '-q', '--filter', 'label=vm.instance']).length
      + dockerLines(['volume', 'ls', '-q', '--filter', 'label=vm.instance']).length;
    const busy = [];
    for (const p of platformPorts(args)) if (!(await portFree(p))) busy.push(p);
    const problems = [
      clash.length && `containers already exist (${clash.join(', ')}): run "node scripts/dev.mjs down" (or "node scripts/dev.mjs demo down" after a --keep run) first`,
      labelled && `${labelled} object(s) labelled vm.instance already exist: remove them first`,
      busy.length && `port(s) ${busy.join(', ')} in use on 127.0.0.1`,
    ].filter(Boolean);
    if (!record(problems.length ? 'FAIL' : 'PASS', 'preflight-clean-machine', problems.length ? problems.join('; ') : 'no vulnmart containers, no vm.instance objects, ports free')) return finish();

    // 2. Platform stack
    stackStarted = true;
    const up = compose(['up', '-d', '--wait', '--quiet-pull'], platformProfiles(args));
    if (!record(up.status === 0 ? 'PASS' : 'FAIL', 'platform-stack-up', up.status === 0 ? `services of profiles ${platformProfiles(args).join(' + ')} healthy` : `compose up failed: ${up.stderr.split(/\r?\n/).slice(-3).join(' ')}`)) return finish();

    try {
      const h = await waitHealthy('http://127.0.0.1:8000/healthz');
      const ready = await getText('http://127.0.0.1:8000/readyz');
      record(ready.status === 200 ? 'PASS' : 'FAIL', 'api-health', `/healthz ${h.status}, /readyz ${ready.status} ${ready.body.replace(/\s+/g, '')}`);
    } catch (e) {
      record('FAIL', 'api-health', e.message);
    }
    try {
      const direct = await getText('http://127.0.0.1:8000/api/v1/health');
      record(direct.status === 403 ? 'PASS' : 'FAIL', 'api-refuses-without-origin-secret', `direct /api/v1/health without the proxy header answered ${direct.status} (expected 403)`);
    } catch (e) {
      record('FAIL', 'api-refuses-without-origin-secret', e.message);
    }
    if (args.noWeb) {
      record('SKIP', 'web-proxy-health', '--no-web');
      record('SKIP', 'origin-secret-hidden', '--no-web');
    } else {
      try {
        const r = await waitHealthy('http://127.0.0.1:3000/api/v1/health');
        record(r.status === 200 && JSON.parse(r.body).status === 'ok' ? 'PASS' : 'FAIL', 'web-proxy-health', `/api/v1/health through the dashboards origin: HTTP ${r.status}, status ${JSON.parse(r.body).status}`);
        const page = await getText('http://127.0.0.1:3000/');
        const seen = [...r.headers.keys(), ...page.headers.keys()].some((k) => k.toLowerCase() === 'x-origin-secret');
        const inBody = r.body.includes(DEV_ORIGIN_SECRET) || page.body.includes(DEV_ORIGIN_SECRET);
        record(page.status === 200 && !seen && !inBody ? 'PASS' : 'FAIL', 'origin-secret-hidden',
          `page HTTP ${page.status}; the secret header is not in any response header (${!seen}) nor in any body (${!inBody})`);
      } catch (e) {
        record('FAIL', 'web-proxy-health', e.message);
      }
    }

    // 3. Lab side: images, orchestrator
    const stubBuild = run('docker', ['build', '-q', '-f', 'contracts/mocks/stub-instance/Dockerfile', '-t', STUB_TAG, '.'], { cwd: ROOT, timeout: 900000 });
    const stubId = stubBuild.status === 0 ? imageId(STUB_TAG) : null;
    if (!record(stubId ? 'PASS' : 'FAIL', 'stub-image-build', stubId ? `${STUB_TAG} built` : `docker build failed: ${stubBuild.stderr.split(/\r?\n/).slice(-3).join(' ')}`)) return finish();

    let shopId = null;
    if (args.stubOnly) record('SKIP', 'shop-image-build', '--stub-only');
    else {
      const b = run('docker', ['build', '-q', '-f', 'apps/shop/Dockerfile', '-t', SHOP_TAG, 'apps/shop'], { cwd: ROOT, timeout: 900000 });
      shopId = b.status === 0 ? imageId(SHOP_TAG) : null;
      if (shopId) record('PASS', 'shop-image-build', `${SHOP_TAG} built from apps/shop`);
      else record('SKIP', 'shop-image-build', `could not build apps/shop (${b.stderr.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? 'unknown'}); the stub image is used instead`);
    }

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnmart-demo-'));
    fs.mkdirSync(path.join(tmp, 'templates'));
    fs.writeFileSync(path.join(tmp, 'templates', 'shop-v0.json'), JSON.stringify(reduceTemplate(JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')))), 'utf8');
    fs.writeFileSync(path.join(tmp, 'template.schema.json'), JSON.stringify(relaxSchema(JSON.parse(fs.readFileSync(TEMPLATE_SCHEMA, 'utf8')))), 'utf8');
    const key = randomBytes(32).toString('hex');
    const keyFile = path.join(tmp, 'platform.key');
    fs.writeFileSync(keyFile, key, 'utf8');

    let useReal = false;
    if (shopId) {
      // Probe: does the real shop work in the shop role (readiness, snapshot, env)? If not, fall back to the stub.
      const port = await freePort();
      orch = startOrchestrator({ dir: tmp, manifest: buildManifest({ stubId, shopId, realShop: true }), port, key, healthTimeoutS: 30, log });
      if (await waitListening(orch, port)) {
        const p = runClient({ port, keyFile, mode: 'shop', probe: true });
        for (const i of parseInstanceIds(p.stdout)) madeIds.add(i);
        const step = parseStepLines(p.stdout).find((r) => r.name === 'probe');
        useReal = step?.status === 'PASS';
        note = useReal ? 'the real apps/shop image works in the shop role' : `the real apps/shop image does not satisfy the shop role yet (${step?.detail ?? 'no answer'}); the stub image was used`;
      } else {
        note = `could not probe the real shop (orchestrator did not start); the stub image was used`;
      }
      killTree(orch);
      orch = null;
      // the real shop was tried: PASS only when it was accepted, otherwise SKIP (the stub is the fallback), never PASS
      record(useReal ? 'PASS' : 'SKIP', 'shop-role', note);
    } else {
      record('SKIP', 'shop-role', args.stubOnly ? 'stub image (--stub-only): the real shop was not tried' : 'stub image (apps/shop did not build): the real shop was not tried');
    }
    mode = useReal ? 'real shop image (apps/shop)' : 'stub instance image';
    imageUsed = useReal ? `${SHOP_TAG} (built from apps/shop)` : `${STUB_TAG} (stub instance, contracts/mocks/stub-instance)`;

    const port = await freePort();
    orch = startOrchestrator({ dir: tmp, manifest: buildManifest({ stubId, shopId: useReal ? shopId : stubId, realShop: useReal }), port, key, healthTimeoutS: 60, log });
    if (!(await waitListening(orch, port))) {
      record('FAIL', 'orchestrator-start', `the service did not listen: ${tailFile(orch.logFile).replace(/\s+/g, ' ').slice(-300)}`);
      return finish();
    }
    record('PASS', 'orchestrator-start', `real Python service, Docker backend, ${useReal ? 'real shop' : 'stub'} in the shop role, reduced two-component template`);

    // 4. Drive it with the platform's own client
    ranWork = true;
    const c = runClient({ port, keyFile, mode: useReal ? 'shop' : 'stub', probe: false });
    for (const i of parseInstanceIds(c.stdout)) madeIds.add(i);
    const clientRows = parseStepLines(c.stdout);
    if (!clientRows.length) record('FAIL', 'client', `no step lines from the client (exit ${c.status}): ${redact(c.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' '))}`);
    for (const r of clientRows) record(r.status, `client:${r.name}`, r.detail);
  } catch (e) {
    record('FAIL', 'demo', `${e?.message ?? e}`);
  }
  return finish();

  // 5. Clean up (unless --keep), then evidence
  async function finish() {
    killTree(orch);
    if (args.keep) {
      record('SKIP', 'cleanup', `--keep: the platform stack${tmp ? ' and the temporary files' : ''} were left up; remove with "node scripts/dev.mjs demo down"`);
    } else {
      let detail = 'nothing started';
      let ok = true;
      if (stackStarted) {
        const d = compose(['down', '-v', '--remove-orphans', '--timeout', '2']);
        const left = leftoverNames(dockerLines(['ps', '-a', '--format', '{{.Names}}']).join('\n'));
        // only the instances this run made (ids from the client), never every object with a vm.instance label; the preflight made sure
        // none existed before. Anything else that is left is reported as a FAIL below, not removed.
        const vm = [];
        for (const iid of madeIds) {
          const f = `label=vm.instance=${iid}`;
          const found = dockerLines(['ps', '-a', '-q', '--filter', f]);
          vm.push(...found);
          for (const id of found) run('docker', ['rm', '-f', '-v', id], { timeout: 60000 });
          for (const n of dockerLines(['network', 'ls', '-q', '--filter', f])) run('docker', ['network', 'rm', n], { timeout: 60000 });
          for (const v of dockerLines(['volume', 'ls', '-q', '--filter', f])) run('docker', ['volume', 'rm', '-f', v], { timeout: 60000 });
        }
        const stillLabelled = dockerLines(['ps', '-a', '-q', '--filter', 'label=vm.instance']).length + dockerLines(['volume', 'ls', '-q', '--filter', 'label=vm.instance']).length + dockerLines(['network', 'ls', '-q', '--filter', 'label=vm.instance']).length;
        ok = d.status === 0 && !left.length && !stillLabelled;
        detail = ok ? `project ${PROJECT} removed with its volumes, orchestrator stopped, ${vm.length ? `${vm.length} stray instance container(s) removed` : 'no stray instance objects'}` : `compose down exit ${d.status}, ${left.length} container(s) and ${stillLabelled} vm.instance object(s) left`;
      }
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { ok = false; detail += '; temporary folder not removed'; } }
      record(ok ? 'PASS' : 'FAIL', 'cleanup', detail);
    }
    console.log('');
    console.log(formatTable(rows));
    const code = exitCode(rows);
    console.log(`\n${code === 0 ? 'DEMO PASSED' : 'DEMO FAILED'} in ${Math.round((Date.now() - t0) / 1000)} s`);
    if (ranWork || rows.length > 6) {
      try {
        fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
        fs.writeFileSync(EVIDENCE_FILE, evidenceText({ date: new Date().toLocaleDateString('en-CA'), args, mode, rows, note, image: imageUsed }), 'utf8');
        console.log('Evidence (redacted) written to docs/assets/local-demo/demo-output.txt');
      } catch (e) {
        console.error(`Could not write the evidence file: ${e.message}`);
      }
    }
    return code;
  }
}
