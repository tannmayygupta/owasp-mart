// The lab harness (story L-06): one full STUB instance plus the fake ingest, started from infra/compose/harness.yaml, then checked for
// conformance with the instance contract (IF-6) and the event contract (IF-4). Entry: `node scripts/dev.mjs harness` (and `harness down`).
// Fresh throwaway flags, seed and event key are made at every run. They reach the containers only on standard input and are never
// written to a file, a log or a doc. Node built-ins only.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfig, checkInspect, formatResults, DOCKERFILE, HARNESS_FILE } from './check-instance-conformance.mjs';
import { freshValues, injectionDocument, sidecarStartDocument } from '../contracts/mocks/stub-instance/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'vulnmart-harness';
export const SERVICES = ['volume-keeper', 'ingest', 'injector', 'shop', 'gate', 'sidecar', 'edge'];
export const containerName = (svc) => `${PROJECT}-${svc}`;
export const DEFAULT_EDGE_PORT = 18090;
export const HEALTH_TIMEOUT_MS = 90000;
const INJECTOR_EXIT = { 10: 'bad document', 11: 'snapshot patch failed', 12: 'placement write failed', 13: 'flags file or marker write failed' };

export function defaultRunner(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL', ...opts });
  if (r.error?.code === 'ETIMEDOUT') return { status: 124, stdout: '', stderr: `${cmd} timed out and was killed.` };
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

export function httpRequest(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 8000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Replace every secret value in a text, so a failure message can never carry one.
export function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>');
  return out;
}

// HARNESS_PRODUCT_SIDECAR=1 runs the product sidecar image (services/sidecar, built as vulnmart-sidecar:local) in place of the stub sidecar.
const PRODUCT_SIDECAR_FILE = path.join(ROOT, 'infra', 'compose', 'harness.sidecar.yaml');
const composeFiles = () => (process.env.HARNESS_PRODUCT_SIDECAR === '1' ? ['-f', HARNESS_FILE, '-f', PRODUCT_SIDECAR_FILE] : ['-f', HARNESS_FILE]);
const composeArgs = (args) => ['compose', ...composeFiles(), '-p', PROJECT, ...args];

export function harnessDown({ runner = defaultRunner, log = console.log, err = console.error } = {}) {
  const r = runner('docker', composeArgs(['down', '--volumes', '--remove-orphans', '--timeout', '2']), { env: { ...process.env, HARNESS_EDGE_PORT: String(DEFAULT_EDGE_PORT) } });
  if (r.status !== 0) { err(`harness down failed.\n${r.stderr}`); return 1; }
  log('Harness stopped: containers, networks and volumes removed.');
  return 0;
}

// The leftovers of a harness project, for the "nothing remains" check. Returns { containers, networks, volumes } (names).
export function leftovers(runner = defaultRunner) {
  const lines = (r) => r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const f = ['--filter', `label=com.docker.compose.project=${PROJECT}`];
  return {
    containers: lines(runner('docker', ['ps', '-a', ...f, '--format', '{{.Names}}'])),
    networks: lines(runner('docker', ['network', 'ls', ...f, '--format', '{{.Name}}'])),
    volumes: lines(runner('docker', ['volume', 'ls', ...f, '--format', '{{.Name}}'])),
  };
}

// ---- live checks ----
// ctx: { runner, port, values, get(pathname, opts) -> { status, text } }. Returns [{ rule, ok, detail }].
export async function liveChecks(ctx) {
  const { runner, values: v } = ctx;
  const secrets = [v.seed, v.event_key, ...v.flags.map((f) => f.flag)];
  const results = [];
  const add = (rule, ok, detail = '') => results.push({ rule, ok, detail: ok ? '' : detail });
  const exec = (svc, ...cmd) => runner('docker', ['exec', containerName(svc), ...cmd]);
  const leaks = (text) => secrets.some((s) => String(text).includes(s));
  const answers = []; // every answer except the planted-flag route (which exists to return a flag)
  const get = async (p, o) => { const r = await ctx.get(p, o); if (!p.startsWith('/_stub/planted-flag')) answers.push(r.text); return r; };

  const h = await get('/healthz');
  add('live-healthz', h.status === 200, `GET /healthz answered ${h.status}`);
  const rd = await get('/readyz');
  add('live-readyz-after-marker', rd.status === 200, `GET /readyz answered ${rd.status}`);
  const ver = await get('/version');
  let verBody = {};
  try { verBody = JSON.parse(ver.text); } catch { /* checked below */ }
  add('live-version', ver.status === 200 && typeof verBody.build_id === 'string' && verBody.build_id.length > 0 && !leaks(ver.text), 'GET /version must answer a build id and no secret');

  const key = 'C03';
  const planted = await get(`/_stub/planted-flag?key=${key}`);
  const file = exec('shop', 'cat', '/run/vm/flags.json');
  let fileFlag; let fileInstance;
  try { const d = JSON.parse(file.stdout); fileFlag = d.flags.find((f) => f.challenge_key === key)?.flag; fileInstance = d.instance_id; } catch { /* checked below */ }
  let served; try { served = JSON.parse(planted.text).flag; } catch { /* checked below */ }
  add('live-planted-flag', planted.status === 200 && !!fileFlag && served === fileFlag && fileFlag === v.flags.find((f) => f.challenge_key === key).flag && fileInstance === v.instance_id,
    'the planted flag served by the stub must equal the flag in /run/vm/flags.json and the one planted this run');

  const stat = exec('shop', 'stat', '-c', '%a', '/run/vm/flags.json', '/run/vm/injected');
  add('live-flags-file-and-marker-modes', stat.status === 0 && stat.stdout.trim().split(/\s+/).join(',') === '400,444', 'flags.json must be mode 0400 and the marker mode 0444');

  const emit = async (kind) => { const r = await get('/_stub/emit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) }); try { return JSON.parse(r.text).sidecar_status; } catch { return -1; } };
  const eventsAtIngest = () => { const r = exec('ingest', 'wget', '-q', '-O', '-', 'http://127.0.0.1:8081/_fake/events'); try { return JSON.parse(r.stdout); } catch { return null; } };
  const sent = await emit('valid');
  let stored = null;
  for (let i = 0; i < 40; i++) { stored = eventsAtIngest(); if (stored?.length) break; await sleep(250); }
  // The product sidecar also reports its own observations (flag sightings, requests), so with it only the shop event is counted.
  const product = process.env.HARNESS_PRODUCT_SIDECAR === '1';
  const shopEvents = (list) => (Array.isArray(list) ? list.filter((e) => e.type === 'shop.catalog_query_error') : []);
  const oneShop = product ? shopEvents(stored).length === 1 && shopEvents(stored)[0].instance_id === v.instance_id && shopEvents(stored)[0].epoch === v.epoch && shopEvents(stored)[0].seq === 1 : Array.isArray(stored) && stored.length === 1 && stored[0].instance_id === v.instance_id && stored[0].epoch === v.epoch && stored[0].seq === 1 && stored[0].type === 'shop.catalog_query_error';
  add('live-event-stored-and-verified', sent === 202 && oneShop,
    `one event must reach the fake ingest with (instance_id, epoch, seq=1); sidecar answered ${sent}, ingest holds ${stored ? stored.length : 'unknown'}`);

  const rows = { 'too-big': 413, 'wrong-type': 415, 'bad-json': 400, 'forbidden-source': 422, get: 405 };
  const bad = [];
  for (const [kind, want] of Object.entries(rows)) { const got = await emit(kind); if (got !== want) bad.push(`${kind}: want ${want}, got ${got}`); }
  await sleep(500);
  const after = eventsAtIngest();
  // with the product sidecar the events it makes itself (source sidecar) are fine; nothing from the shop, the mock or the import lane besides the one valid event
  const foreign = (list) => (Array.isArray(list) ? list.filter((e) => e.source !== 'sidecar') : []);
  if (!after || (product ? shopEvents(after).length !== 1 || foreign(after).length !== 1 : after.length !== 1)) bad.push(`nothing else may be forwarded (ingest holds ${after ? after.length : 'unknown'})`);
  add('live-event-error-answers', bad.length === 0, bad.join('; '));

  // no secret in any log, answer, file or container setting
  const logs = SERVICES.map((s) => runner('docker', ['logs', containerName(s)]));
  add('live-no-secret-in-logs', !logs.some((r) => leaks(r.stdout + r.stderr)), 'a flag, seed or key was found in a container log');
  add('live-no-secret-in-answers', !answers.some(leaks), 'a flag, seed or key was found in an answer other than the planted-flag route');
  const files = [exec('shop', 'cat', '/data/shop.db'), exec('shop', 'cat', '/run/vm/snapshot.db')];
  add('live-no-secret-in-files', files.every((r) => r.status === 0) && !files.some((r) => leaks(r.stdout)), 'the shop database or the snapshot holds a flag, seed or key');
  const inspectRaw = runner('docker', ['inspect', ...SERVICES.map(containerName)]);
  let containers = [];
  try { containers = JSON.parse(inspectRaw.stdout); } catch { /* checked below */ }
  add('live-no-secret-in-container-settings', containers.length === SERVICES.length && !leaks(inspectRaw.stdout), 'a flag, seed or key was found in a container setting (docker inspect)');
  const inst = containers.filter((c) => c.Config?.Labels?.['vm.kind'] === 'inst' || c.Config?.Labels?.['vm.kind'] === 'harness');
  results.push(...checkInspect(inst));
  return results;
}

// ---- the run ----
// options: keep (leave the stack up), breakInjector ('bad-document': feed the injector a bad document, a test aid), plus injectable
// runner, spawner, get, sleep, resolveConfig, log, err for unit tests.
export async function runHarness({
  keep = false,
  breakInjector,
  runner = defaultRunner,
  spawner = (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
  sleepFn = sleep,
  portPicker = freePort,
  resolveConfig,
  log = console.log,
  err = console.error,
  values = freshValues(),
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
  live = liveChecks,
} = {}) {
  const secrets = [values.seed, values.event_key, ...values.flags.map((f) => f.flag)];
  const clients = [];
  let refused = false;
  let step = 'start';
  const fail = (msg) => { err(scrub(`FAIL step ${step}: ${msg}`, secrets)); return 1; };
  const dockerOut = (r) => scrub((r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-8).join('\n'), secrets);

  const body = async () => {
    step = 'existing-instance';
    const left = leftovers(runner);
    if (left.containers.length || left.networks.length || left.volumes.length) {
      refused = true; // nothing of the existing harness is touched, not even by the teardown below
      return fail(`a harness instance already exists (${left.containers.length} container(s), ${left.networks.length} network(s), ${left.volumes.length} volume(s)). Remove it first with: node scripts/dev.mjs harness down`);
    }

    step = 'ports';
    const port = await portPicker();
    const env = { ...process.env, HARNESS_EDGE_PORT: String(port) };
    const compose = (args) => runner('docker', composeArgs(args), { env });

    step = 'build';
    let r = compose(['build', 'shop']);
    if (r.status !== 0) return fail(`could not build the stub image.\n${dockerOut(r)}`);
    log('step build: ok');

    step = 'conformance-config';
    const config = resolveConfig ? resolveConfig(env) : JSON.parse((() => { const x = compose(['config', '--format', 'json']); if (x.status !== 0) throw new Error(dockerOut(x)); return x.stdout; })());
    const dockerfile = (() => { try { return readFileSync(DOCKERFILE, 'utf8'); } catch { return ''; } })();
    const stat = formatResults(checkConfig(config, { dockerfile }));
    if (!stat.ok) { for (const l of stat.lines) err(scrub(l, secrets)); return fail('the resolved compose config breaks the instance runtime profile'); }
    for (const l of stat.lines.slice(0, -1)) log(l);
    log(`step conformance-config: ok (${stat.lines.at(-1)})`);

    step = 'create';
    r = compose(['create', '--no-build']);
    if (r.status !== 0) return fail(`could not create the containers.\n${dockerOut(r)}`);
    log('step create: ok');

    const start = (svc) => runner('docker', ['start', containerName(svc)]);
    const feed = (svc, doc) => {
      const child = spawner('docker', ['start', '-a', '-i', containerName(svc)]);
      let out = '';
      child.stdout?.on('data', (c) => (out += c));
      child.stderr?.on('data', (c) => (out += c));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(doc));
      clients.push(child);
      const f = { child, exit: null, done: null };
      f.done = new Promise((resolve) => {
        child.on('close', (code) => { f.exit = code ?? 1; resolve({ code: f.exit, out }); });
        child.on('error', () => { f.exit = 127; resolve({ code: 127, out }); });
      });
      return f;
    };
    const state = (svc, fmt) => runner('docker', ['inspect', '-f', fmt, containerName(svc)]).stdout.trim();
    // Waits until the container is healthy. Returns null, or the reason it will never be: an exited or dead container, a start-document
    // feeder that ended with a non-zero code (that code is named), or the timeout.
    const healthy = async (svc, feeder) => {
      const end = Date.now() + healthTimeoutMs;
      while (Date.now() < end) {
        if (state(svc, '{{.State.Health.Status}}') === 'healthy') return null;
        if (feeder && feeder.exit !== null && feeder.exit !== 0) return `its start-document feeder exited with code ${feeder.exit}`;
        const st = state(svc, '{{.State.Status}}');
        if (st === 'exited' || st === 'dead') return `the container is ${st} (exit code ${state(svc, '{{.State.ExitCode}}') || 'unknown'})`;
        await sleepFn(500);
      }
      return 'it did not become healthy in time';
    };

    step = 'start volume-keeper';
    r = start('volume-keeper');
    if (r.status !== 0) return fail(dockerOut(r));
    log('step start volume-keeper: ok');

    step = 'start ingest';
    const ingestFeed = feed('ingest', sidecarStartDocument(values));
    const why = await healthy('ingest', ingestFeed);
    if (why) return fail(`the fake ingest is not healthy: ${why}`);
    log('step start ingest: ok');

    step = 'injector';
    const injDoc = breakInjector === 'bad-document' ? { schema_version: '0.1' } : injectionDocument(values);
    const inj = await feed('injector', injDoc).done;
    if (inj.code !== 0) return fail(`the injector exited ${inj.code}${INJECTOR_EXIT[inj.code] ? ` (${INJECTOR_EXIT[inj.code]})` : ''}; the other containers are not started`);
    log('step injector: exit 0, marker written');

    step = 'start instance';
    for (const svc of ['shop', 'gate']) { r = start(svc); if (r.status !== 0) return fail(`${svc}: ${dockerOut(r)}`); }
    const sideFeed = feed('sidecar', sidecarStartDocument(values));
    r = start('edge');
    if (r.status !== 0) return fail(`edge: ${dockerOut(r)}`);
    for (const svc of ['shop', 'gate', 'sidecar', 'edge']) {
      const w = await healthy(svc, svc === 'sidecar' ? sideFeed : undefined);
      if (w) return fail(`${svc} is not healthy: ${w}`);
    }
    log('step start instance: shop, gate, sidecar and edge healthy');
    for (const c of [ingestFeed.child, sideFeed.child]) { try { c.kill(); } catch { /* already gone */ } }

    step = 'live-conformance';
    const results = await live({ runner, values, port, get: (p, o = {}) => httpRequest(port, { pathname: p, ...o }) });
    const liveReport = formatResults(results);
    for (const l of liveReport.lines) (l.startsWith('FAIL') ? err : log)(scrub(l, secrets));
    if (!liveReport.ok) return fail('the running stack does not conform');
    if (keep) log(`Harness left running. Player port: http://127.0.0.1:${port}/  (stop it with: node scripts/dev.mjs harness down)`);
    log('harness: PASS');
    return 0;
  };

  let code = 1;
  try { code = await body(); } catch (e) { code = fail(e.message); } finally {
    for (const c of clients) { try { c.kill(); } catch { /* already gone */ } }
    // A run that passed is torn down too unless --keep; a failed run is always torn down (nothing may remain).
    if (!refused && (!keep || code !== 0)) {
      const down = harnessDown({ runner, log: () => {}, err });
      if (down !== 0 && code === 0) { err('FAIL step teardown: the harness could not be removed, so something may remain (run: node scripts/dev.mjs harness down)'); code = 1; }
    }
  }
  return code;
}
