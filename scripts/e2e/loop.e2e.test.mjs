// Local end-to-end loop on Docker Desktop (story 8.3, LX-1): ONE candidate through the real pieces, in ten steps.
//   lab runtime (apps/api, uvicorn) -> real orchestrator (Docker backend) -> stub instance (shop, sidecar, injector) on its own network,
//   the edge gate attached to it by the orchestrator, stock Caddy in front (self-signed certificate) -> a signed event over the edge relay
//   back into the lab runtime's ingest handler -> milestone -> flag submit -> score -> deadline: freeze, then destroy.
// Needs Docker, uv and openssl (the whole file is skipped with a message otherwise). Not a CI gate (CI Linux has `ci:linux`).
// Run: node --test --test-concurrency=1 scripts/e2e/loop.e2e.test.mjs        (LOOP_CLEAN=1 first removes leftovers of an interrupted run)
// Everything is throwaway: random keys and tokens in a temporary folder and in memory, loopback only, every object this test starts is
// labelled vm.kind=loop-test and vm.run=<id>. The instance objects the ORCHESTRATOR makes carry the template labels (vm.instance=<id>);
// the test removes exactly the ids it created. No flag value, key or token is printed or written: logs go through redactAll.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { newJti, signTicket } from '../../apps/edge/src/tickets.mjs';
import { relaxSchema } from '../demo.mjs';
import {
  ROOT, STUB_TAG, docker, findLeftovers, freePort, hostOf, imageId, isInstanceId, killTree, labelFilter, leftoverText, loopManifest, loopTemplate,
  newRunId, orchCall, pollUntil, readLog, redactAll, run, runLabels, sleep, startLogged, startOrchestrator, tailRedacted, toolOk, waitListening,
} from './loop-support.mjs';

const COMPOSE_DIR = path.join(ROOT, 'infra', 'compose');
const compose = yaml.load(fs.readFileSync(path.join(COMPOSE_DIR, 'compose.yaml'), 'utf8'));
const EDGE_IMAGE = compose.services['edge-gate'].image;
const CADDY_IMAGE = compose.services['edge-caddy'].image;
// The lab runtime builds hostnames as <id>.instances.example.invalid and the gate refuses any other hostname, so the zone is that suffix.
const ZONE = 'instances.example.invalid';
const RUN = newRunId();
const LABEL = runLabels(RUN);
const NET_PUB = `${RUN}-pub`;
const NET_CORE = `${RUN}-core`;
const GATE = `${RUN}-edge-gate`;
const CADDY = `${RUN}-edge-caddy`;
const FWD = `${RUN}-admin-fwd`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-loop-e2e-'));
const EVIDENCE = path.join(ROOT, 'docs', 'assets', 'story-8-3-loop-and-load', 'loop-output.txt');
const CHALLENGE = 'C03'; // the stub's "valid" event is shop.catalog_query_error: M1 of C03 (milestone_rules.json)

// ------------------------------------------------------------------ preflight (step 1 decides the skip)
const dockerUp = toolOk('docker', ['info', '--format', '{{.ServerVersion}}']);
const SKIP = !dockerUp ? 'Docker is not running: start Docker Desktop, then run the loop test again.'
  : !toolOk('uv', ['--version']) ? 'uv is not installed: the test starts the lab runtime and the orchestrator with it (docs/bmad/INSTALL.md).'
    : !toolOk('openssl', ['version']) ? 'openssl is not installed: the test needs it to make a throwaway self-signed certificate.' : false;
if (SKIP) console.log(`SKIP loop.e2e: ${SKIP}`);

// ------------------------------------------------------------------ state of the rig
const S = {
  key: randomBytes(32).toString('hex'), // platform signing key of the orchestrator (the runtime reads the same file)
  gateKey: randomBytes(32), adminSecret: randomBytes(16).toString('hex'), demoToken: randomBytes(16).toString('hex'),
  ports: {}, children: [], ids: new Set(), rows: [], clockOffsetS: 0,
};
const secrets = () => [S.key, S.gateKey.toString('hex'), S.adminSecret, S.demoToken, S.flag, S.owner].filter(Boolean);
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
const sidecarOf = (id) => `vm-${id.toLowerCase()}-e1-sidecar`;
const shopOf = (id) => `vm-${id.toLowerCase()}-e1-shop`;
const subst = (text, vars) => String(text).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k, d) => vars[k] ?? d ?? '');

/** One step: records PASS or FAIL in the rows (for the evidence file) and rethrows, so the failure names the step. */
function step(n, name, fn) {
  test(`step ${n}: ${name}`, { skip: SKIP, timeout: 360000 }, async (t) => {
    const note = (m) => { S.note = redactAll(m, secrets()); t.diagnostic(S.note); };
    S.note = '';
    try {
      await fn(note);
      S.rows.push({ n, name, status: 'PASS', detail: S.note });
    } catch (e) {
      S.rows.push({ n, name, status: 'FAIL', detail: redactAll(String(e?.message ?? e), secrets()).slice(0, 400) });
      throw e;
    }
  });
}

function composeFlags(svc, { vars = {}, mounts = {} } = {}) {
  const a = [];
  if (svc.user) a.push('--user', String(svc.user));
  if (svc.read_only) a.push('--read-only');
  for (const c of svc.cap_drop ?? []) a.push('--cap-drop', c);
  for (const c of svc.cap_add ?? []) a.push('--cap-add', c);
  for (const s of svc.security_opt ?? []) a.push('--security-opt', s);
  for (const t of svc.tmpfs ?? []) a.push('--tmpfs', t);
  if (svc.mem_limit) a.push('--memory', String(svc.mem_limit));
  if (svc.pids_limit) a.push('--pids-limit', String(svc.pids_limit));
  for (const [k, v] of Object.entries(svc.environment ?? {})) a.push('-e', `${k}=${subst(v, vars)}`);
  for (const v of svc.volumes ?? []) {
    const m = /^(.*?):(\/[^:]*)(?::(\w+))?$/.exec(subst(v, vars));
    assert.ok(m, `cannot read the compose volume ${v}`);
    const host = m[1].startsWith('.') ? path.resolve(COMPOSE_DIR, m[1]) : mounts[m[2]];
    assert.ok(host, `the compose file mounts ${m[2]} and this test does not know it`);
    a.push('-v', `${host}:${m[2]}${m[3] ? `:${m[3]}` : ''}`);
  }
  return a;
}
const dk = async (args, opts) => {
  const r = await docker(args, opts);
  assert.equal(r.status, 0, `docker ${args.slice(0, 3).join(' ')} failed: ${redactAll(r.stderr.trim().slice(0, 300), secrets())}`);
  return r.stdout.trim();
};

const web = (host, p = '/', { cookie, method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port: S.ports.tls, path: p, method, agent, servername: `x.${ZONE}`, timeout: 15000, headers: { host, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
  });
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', reject);
  r.end(body);
});

const demo = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${S.ports.runtime}/internal/v1/lab-demo${p}`, {
    method, headers: { 'content-type': 'application/json', 'x-lab-demo-token': S.demoToken }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(200000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
};

async function cleanupAll() {
  const left = { containers: '', networks: '', volumes: '' };
  const ids = [...S.ids];
  for (const c of S.children) killTree(c);
  for (const iid of ids) {
    const f = ['--filter', `label=vm.instance=${iid}`];
    const cs = (await docker(['ps', '-aq', ...f])).stdout.split('\n').filter(Boolean);
    if (cs.length) await docker(['rm', '-f', '-v', ...cs]);
  }
  const mine = labelFilter(RUN);
  const cs = (await docker(['ps', '-aq', ...mine])).stdout.split('\n').filter(Boolean);
  if (cs.length) await docker(['rm', '-f', '-v', ...cs]);
  for (const iid of ids) {
    for (const n of (await docker(['network', 'ls', '-q', '--filter', `label=vm.instance=${iid}`])).stdout.split('\n').filter(Boolean)) await docker(['network', 'rm', n]);
    for (const v of (await docker(['volume', 'ls', '-q', '--filter', `label=vm.instance=${iid}`])).stdout.split('\n').filter(Boolean)) await docker(['volume', 'rm', '-f', v]);
  }
  for (const n of (await docker(['network', 'ls', '-q', ...mine])).stdout.split('\n').filter(Boolean)) await docker(['network', 'rm', n]);
  const all = labelFilter(null);
  left.containers = (await docker(['ps', '-aq', ...all])).stdout;
  left.networks = (await docker(['network', 'ls', '-q', ...all])).stdout;
  left.volumes = (await docker(['volume', 'ls', '-q', ...all])).stdout;
  for (const iid of ids) {
    const f = ['--filter', `label=vm.instance=${iid}`];
    left.containers += `\n${(await docker(['ps', '-aq', ...f])).stdout}`;
    left.networks += `\n${(await docker(['network', 'ls', '-q', ...f])).stdout}`;
    left.volumes += `\n${(await docker(['volume', 'ls', '-q', ...f])).stdout}`;
  }
  return findLeftovers(left);
}

after(async () => {
  let left = { total: -1, containers: [], networks: [], volumes: [] };
  try { left = await cleanupAll(); } catch (e) { console.log(`cleanup error: ${redactAll(e.message, secrets())}`); }
  fs.rmSync(TMP, { recursive: true, force: true });
  if (SKIP) return;
  const rows = S.rows;
  const text = redactAll([
    'VulnMart local end-to-end loop (node --test --test-concurrency=1 scripts/e2e/loop.e2e.test.mjs)',
    `Date: ${new Date().toLocaleDateString('en-CA')}`, `Run id: ${RUN}`, 'Machine: laptop with Docker Desktop (numbers are laptop numbers)', '',
    ...rows.map((r) => `${r.status} step ${r.n} ${r.name}${r.detail ? `: ${r.detail}` : ''}`), '',
    `Cleanup check: ${leftoverText(left)}; temp folder present ${fs.existsSync(TMP)}`,
    `Result: ${rows.length === 10 && rows.every((r) => r.status === 'PASS') ? 'all 10 steps PASS' : `${rows.filter((r) => r.status === 'PASS').length} of 10 steps PASS`}`, '',
  ].join('\n'), secrets());
  try { fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true }); fs.writeFileSync(EVIDENCE, text, 'utf8'); } catch { /* the console line below still shows it */ }
  console.log(text);
  assert.equal(left.total, 0, `the test left something behind: ${leftoverText(left)}`);
});

// ------------------------------------------------------------------ the ten steps
step(1, 'preflight: Docker, uv, openssl, no leftovers, nothing else of the lab on the machine', async (note) => {
  const old = findLeftovers({
    containers: (await docker(['ps', '-aq', ...labelFilter(null)])).stdout, networks: (await docker(['network', 'ls', '-q', ...labelFilter(null)])).stdout,
    volumes: (await docker(['volume', 'ls', '-q', ...labelFilter(null)])).stdout,
  });
  if (old.total) {
    if (process.env.LOOP_CLEAN === '1') {
      // only objects labelled vm.kind=loop-test are removed
      if (old.containers.length) await docker(['rm', '-f', '-v', ...old.containers]);
      for (const n of old.networks) await docker(['network', 'rm', n]);
      for (const v of old.volumes) await docker(['volume', 'rm', '-f', v]);
    } else assert.fail(`leftovers of an earlier run labelled vm.kind=loop-test (${leftoverText(old)}): run again with LOOP_CLEAN=1 to remove only those`);
  }
  const inst = (await docker(['ps', '-aq', '--filter', 'label=vm.instance'])).stdout.split('\n').filter(Boolean);
  assert.equal(inst.length, 0, 'containers labelled vm.instance exist already (not made by this test): remove them first');
  const b1 = await run('docker', ['build', '-q', '-f', 'contracts/mocks/stub-instance/Dockerfile', '-t', STUB_TAG, ROOT], { cwd: ROOT });
  assert.equal(b1.status, 0, b1.stderr.slice(-300));
  const b2 = await run('docker', ['build', '-q', '-f', 'apps/edge/Dockerfile', '-t', EDGE_IMAGE, ROOT], { cwd: ROOT });
  assert.equal(b2.status, 0, b2.stderr.slice(-300));
  for (const k of ['runtime', 'orch', 'admin']) S.ports[k] = await freePort();
  note('docker, uv and openssl present; no leftovers; stub and edge images built; three loopback ports reserved (Caddy gets a free host port from Docker on 127.0.0.1)');
});

step(2, 'start the lab runtime (uvicorn, VULNMART_LAB_RUNTIME=1, demo routes with a random token)', async (note) => {
  const keyFile = path.join(TMP, 'platform.key');
  fs.writeFileSync(keyFile, S.key, 'utf8');
  const child = startLogged('uv', ['run', '--locked', '--package', 'vulnmart-api', 'uvicorn', 'vulnmart.kernel.entrypoints.ingest:app', '--host', '127.0.0.1', '--port', String(S.ports.runtime)], {
    env: { VULNMART_LAB_RUNTIME: '1', VULNMART_LAB_DEMO: '1', VULNMART_LAB_DEMO_TOKEN: S.demoToken, VULNMART_ORCH_URL: `http://127.0.0.1:${S.ports.orch}`, VULNMART_ORCH_KEY_FILE: keyFile },
    logFile: path.join(TMP, 'runtime.log'),
  });
  S.children.push(child); S.runtimeLog = child.logFile;
  assert.ok(await waitListening(child, S.ports.runtime, 180000), `the runtime did not listen: ${tailRedacted(readLog(child.logFile), 6, secrets())}`);
  const noToken = await fetch(`http://127.0.0.1:${S.ports.runtime}/internal/v1/lab-demo/attempts/none`);
  assert.equal(noToken.status, 401, 'a demo route without the token answers 401');
  const withToken = await demo('GET', '/attempts/none');
  assert.ok([404].includes(withToken.status), `an unknown attempt with the token answers 404, got ${withToken.status}`);
  note('runtime listening on loopback; demo route without the token 401, with the token 404 for an unknown attempt');
});

step(3, 'start the real orchestrator (Docker backend, three-component template, stub image, edge flags)', async (note) => {
  const stubId = imageId(STUB_TAG);
  assert.ok(stubId, 'the stub image is not built');
  fs.mkdirSync(path.join(TMP, 'templates'));
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'examples', 'valid', 'instance-template', 'shop-template.json'), 'utf8'));
  fs.writeFileSync(path.join(TMP, 'templates', 'shop-v0.json'), JSON.stringify(loopTemplate(template)), 'utf8');
  fs.writeFileSync(path.join(TMP, 'template.schema.json'), JSON.stringify(relaxSchema(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'instance-template.schema.json'), 'utf8')))), 'utf8');
  const adminFile = path.join(TMP, 'gate_admin_secret');
  fs.writeFileSync(adminFile, `${S.adminSecret}\n`, 'utf8');
  const child = startOrchestrator({
    dir: TMP, manifest: loopManifest({ stubId, relayUrl: `http://${GATE}:8081/internal/v1/events` }), port: S.ports.orch, key: S.key, healthTimeoutS: 60,
    extraArgs: ['--edge-container', GATE, '--gate-url', `http://127.0.0.1:${S.ports.admin}`, '--gate-admin-key-file', adminFile],
  });
  S.children.push(child); S.orchLog = child.logFile;
  assert.ok(await waitListening(child, S.ports.orch, 240000), `the orchestrator did not listen: ${tailRedacted(readLog(child.logFile), 6, secrets())}`);
  note('real Python service, Docker backend, stub image in shop, sidecar and injector roles, --edge-container and --gate-url on loopback');
});

step(4, 'start Caddy and the edge gate with the compose run flags; the relay points at the lab runtime', async (note) => {
  const certDir = path.join(TMP, 'certs'); const secDir = path.join(TMP, 'secrets');
  fs.mkdirSync(certDir, { mode: 0o755 }); fs.mkdirSync(secDir, { mode: 0o755 });
  const g = await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'privkey.pem'), '-out', path.join(certDir, 'fullchain.pem'), '-days', '1', '-subj', `/CN=*.${ZONE}`, '-addext', `subjectAltName=DNS:*.${ZONE}`]);
  assert.equal(g.status, 0, g.stderr.slice(-200));
  fs.writeFileSync(path.join(secDir, 'gate_key_current'), `${S.gateKey.toString('hex')}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(secDir, 'gate_key_previous'), '', { mode: 0o644 });
  fs.writeFileSync(path.join(secDir, 'ingest_ca.pem'), '', { mode: 0o644 }); // the compose file mounts the CA of an https ingest; this test uses http and the edge reads an empty file as none
  fs.writeFileSync(path.join(secDir, 'gate_admin_secret'), `${S.adminSecret}\n`, { mode: 0o644 });
  await dk(['network', 'create', ...LABEL, NET_PUB]);
  await dk(['network', 'create', ...LABEL, NET_CORE]); // an ordinary network here (compose has the same): the admin forwarder below needs a published port
  const vars = { VULNMART_LABS_ZONE: ZONE, VULNMART_EDGE_INGEST_URL: `http://host.docker.internal:${S.ports.runtime}` };
  const gateSvc = compose.services['edge-gate'];
  await dk(['create', '--name', GATE, '--network', NET_PUB, ...gateSvc.networks['edge-public'].aliases.flatMap((a) => ['--network-alias', a]), '--add-host', 'host.docker.internal:host-gateway', ...LABEL,
    ...composeFlags(gateSvc, { vars, mounts: { '/run/secrets/gate_key_current': path.join(secDir, 'gate_key_current'), '/run/secrets/gate_key_previous': path.join(secDir, 'gate_key_previous'), '/run/secrets/gate_admin_secret': path.join(secDir, 'gate_admin_secret'), '/run/secrets/ingest_ca': path.join(secDir, 'ingest_ca.pem') } }), EDGE_IMAGE]);
  await dk(['network', 'connect', ...gateSvc.networks['labs-core'].aliases.flatMap((a) => ['--alias', a]), NET_CORE, GATE]);
  await dk(['start', GATE]);
  await pollUntil(async () => /edge-gate: player/.test((await docker(['logs', GATE])).stdout), { timeoutMs: 30000, label: 'the gate to start' });
  // The admin listener lives only on the core network. The orchestrator runs on the host, so this test publishes a forwarder on 127.0.0.1 (test only; compose is unchanged).
  await dk(['run', '-d', '--name', FWD, '--network', NET_CORE, '-p', `127.0.0.1:${S.ports.admin}:9090`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '32', ...LABEL,
    '--entrypoint', 'node', STUB_TAG, '-e', "const n=require('net');n.createServer(c=>{const u=n.connect(9090,'edge-gate-admin');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());}).listen(9090,'0.0.0.0')"]);
  const caddySvc = compose.services['edge-caddy'];
  await dk(['run', '-d', '--name', CADDY, '--network', NET_PUB, '-p', '127.0.0.1::443', ...LABEL, ...composeFlags(caddySvc, { vars, mounts: { '/certs': certDir } }), CADDY_IMAGE]);
  S.ports.tls = Number((await dk(['port', CADDY, '443/tcp'])).split('\n')[0].split(':').pop());
  S.clockOffsetS = Number(await dk(['exec', GATE, 'date', '+%s'])) - Math.floor(Date.now() / 1000);
  await pollUntil(async () => (await web('localhost')).status === 404, { timeoutMs: 30000, label: 'Caddy to answer' });
  note('gate and Caddy running with the compose flags; Caddy published on 127.0.0.1 only; unknown host gets the fixed 404; admin forwarder on 127.0.0.1');
});

step(5, 'POST /attempts through the demo route: the orchestrator creates the instance, state running', async (note) => {
  const started = await demo('POST', '/attempts', { user_id: 'u-1001' });
  assert.equal(started.status, 200, `start failed: ${redactAll(started.text, secrets()).slice(0, 200)}; runtime log: ${tailRedacted(readLog(S.runtimeLog), 4, secrets())}; orchestrator log: ${tailRedacted(readLog(S.orchLog), 4, secrets())}`);
  S.attempt = started.json.attempt_id; S.iid = started.json.instance_id;
  assert.ok(isInstanceId(S.iid), 'instance id shape');
  S.ids.add(S.iid);
  const st = await pollUntil(async () => { const r = await demo('GET', `/attempts/${S.attempt}`); return r.json?.state === 'running' ? r.json : null; }, { timeoutMs: 60000, label: 'the attempt to be running' });
  assert.equal(st.access, 'open');
  const o = await orchCall(`http://127.0.0.1:${S.ports.orch}`, S.key, 'GET', `/v1/instances/${S.iid}`);
  assert.equal(o.status, 200);
  assert.equal(o.json.state, 'ready');
  assert.equal(o.json.access, 'open');
  S.accessEpoch = o.json.access_epoch;
  S.owner = (await dk(['inspect', '--format', '{{ index .Config.Labels "vm.owner" }}', shopOf(S.iid)]));
  assert.match(S.owner, /^[0-9a-f]{64}$/);
  note(`attempt ${S.attempt}: running; instance ${S.iid} ready and open in the orchestrator (access epoch ${S.accessEpoch}); containers ${shopOf(S.iid)} and ${sidecarOf(S.iid)}`);
});

const ticketCookie = async () => {
  const t = signTicket({ current: S.gateKey }, { inst: S.iid, own: S.owner, ae: S.accessEpoch, exp: Math.floor(Date.now() / 1000) + S.clockOffsetS + 30, jti: newJti() });
  S.spent = [...(S.spent ?? []), t];
  const res = await web(hostOf(S.iid, ZONE), `/_vm/enter?t=${t}`);
  return { res, cookie: [].concat(res.headers['set-cookie'] ?? [])[0]?.split(';')[0] };
};

step(6, 'mint a gate ticket, open the instance host name through Caddy (self-signed certificate), reach the stub shop', async (note) => {
  const { res, cookie } = await ticketCookie();
  assert.equal(res.status, 302, `enter answered ${res.status}`);
  assert.ok(cookie?.startsWith('__Host-vm_gate='), 'the gate set its cookie');
  S.cookie = cookie; S.spent.push(cookie.split('=')[1]);
  const noCookie = await web(hostOf(S.iid, ZONE), '/version');
  assert.equal(noCookie.status, 403, 'without the cookie the shop is not reached');
  const page = await pollUntil(async () => { const r = await web(hostOf(S.iid, ZONE), '/version', { cookie: S.cookie }); return r.status === 200 ? r : null; }, { timeoutMs: 40000, label: 'the stub shop behind the gate' });
  assert.match(page.text, /build_id/);
  note('ticket accepted (302 and cookie); no cookie is refused 403; /version of the stub shop answered 200 through Caddy, the gate and the sidecar');
});

step(7, 'the stub exploit path: signed event over the edge relay, milestone credited in the score', async (note) => {
  const before = (await demo('GET', `/attempts/${S.attempt}/score`)).json;
  assert.equal(before.per_challenge.find((c) => c.challenge_key === CHALLENGE)?.milestone ?? 'none', 'none');
  const emit = await web(hostOf(S.iid, ZONE), '/_stub/emit', { cookie: S.cookie, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'valid' }) });
  assert.equal(emit.status, 200, emit.text.slice(0, 120));
  assert.equal(JSON.parse(emit.text).sidecar_status, 202, 'the sidecar accepted the event');
  try {
    S.afterM1 = await pollUntil(async () => {
      const sc = (await demo('GET', `/attempts/${S.attempt}/score`)).json;
      const row = sc.per_challenge.find((c) => c.challenge_key === CHALLENGE);
      return row && row.milestone !== 'none' ? { sc, row } : null;
    }, { timeoutMs: 30000, intervalMs: 700, label: `the ${CHALLENGE} milestone to be credited` });
  } catch (e) {
    const side = (await docker(['logs', sidecarOf(S.iid)]));
    const gate = (await docker(['logs', GATE]));
    assert.fail(`${e.message}. Hops: sidecar log: ${tailRedacted(side.stdout + side.stderr, 4, secrets())}; gate log: ${tailRedacted(gate.stdout + gate.stderr, 4, secrets())}; runtime log: ${tailRedacted(readLog(S.runtimeLog), 4, secrets())}`);
  }
  assert.equal(S.afterM1.row.milestone, 'M1');
  note(`stub /_stub/emit then the sidecar answered 202; ${CHALLENGE} credited ${S.afterM1.row.milestone} for ${S.afterM1.row.points} points; score ${S.afterM1.sc.score}`);
});

step(8, 'read the planted flag from the shop container file, submit it: M3 and the score of the hand calculation', async (note) => {
  const r = await docker(['exec', shopOf(S.iid), 'cat', '/run/vm/flags.json']);
  assert.equal(r.status, 0, 'the flags file is readable in the shop container');
  S.flag = JSON.parse(r.stdout).flags.find((f) => f.challenge_key === CHALLENGE)?.flag;
  assert.ok(S.flag, 'the flags file holds the challenge');
  const wrong = await demo('POST', `/attempts/${S.attempt}/flags`, { challenge_key: CHALLENGE, text: 'VM{not-the-flag-at-all}' });
  assert.equal(wrong.status, 200);
  assert.notEqual(wrong.json.credit, 'credited', 'a wrong flag is not credited');
  const ok = await demo('POST', `/attempts/${S.attempt}/flags`, { challenge_key: CHALLENGE, text: S.flag });
  assert.equal(ok.status, 200, ok.text.slice(0, 150));
  // The stub instance reports no recorded activity, and since audit blocker B6 (D-94, FR-ACH-02) a correct flag pasted without enough recorded activity is
  // HELD for a named reviewer, not counted. That is the designed outcome here; the credited M3 and its hand number (94) are proved by the in-process loop (story 8.2).
  assert.equal(ok.json.result, 'correct');
  assert.equal(ok.json.credit, 'held', `result ${ok.json.result}`);
  const again = await demo('POST', `/attempts/${S.attempt}/flags`, { challenge_key: CHALLENGE, text: S.flag });
  assert.equal(again.json.credit, 'held', 'pasting the held flag again changes nothing');
  const sc = (await demo('GET', `/attempts/${S.attempt}/score`)).json;
  const row = sc.per_challenge.find((c) => c.challenge_key === CHALLENGE);
  assert.equal(row.milestone, S.afterM1.row.milestone, 'a held capture does not raise the milestone');
  assert.equal(sc.score, S.afterM1.sc.score, 'a held capture does not change the score');
  S.flag = undefined; // not kept longer than needed
  note(`wrong flag not credited; right flag HELD for review (no recorded activity, D-94), twice the same; ${CHALLENGE} stays ${row.milestone}, score ${sc.score} unchanged`);
});

step(9, 'deadline: auto-submit and freeze (the gate shows its paused page), then the destroy tick leaves no instance', async (note) => {
  assert.equal((await demo('POST', '/advance', { seconds: 7200 })).status, 200);
  let st;
  for (let i = 0; i < 3; i++) {
    assert.equal((await demo('POST', '/tick')).status, 200);
    st = (await demo('GET', `/attempts/${S.attempt}`)).json;
    if (st.state === 'submitted') break;
    await demo('POST', '/advance', { seconds: 300 });
  }
  assert.equal(st.state, 'submitted', `state after the deadline: ${st.state}`);
  assert.equal(st.access, 'frozen');
  const frozen = await pollUntil(async () => { const r = await web(hostOf(S.iid, ZONE), '/version', { cookie: S.cookie }); return r.status === 423 ? r : null; }, { timeoutMs: 15000, label: 'the gate to show the frozen page' });
  assert.match(frozen.text, /This lab is paused/);
  assert.ok(!/build_id/.test(frozen.text), 'the shop is not reached while frozen');
  assert.equal((await demo('POST', '/advance', { seconds: 960 })).status, 200); // the 15 minute freeze
  assert.equal((await demo('POST', '/tick')).status, 200);
  const end = (await demo('GET', `/attempts/${S.attempt}`)).json;
  assert.equal(end.destroyed, true);
  // the destroy runs in the orchestrator after the call returns (state stopping, then destroyed): bounded wait
  const o = await pollUntil(async () => {
    const r = await orchCall(`http://127.0.0.1:${S.ports.orch}`, S.key, 'GET', `/v1/instances/${S.iid}`);
    return r.status === 404 || r.json?.state === 'destroyed' ? r : null;
  }, { timeoutMs: 60000, label: 'the orchestrator to finish the destroy' });
  const left = (await docker(['ps', '-aq', '--filter', `label=vm.instance=${S.iid}`])).stdout.trim();
  assert.equal(left, '', 'no instance container is left');
  const gone = await pollUntil(async () => { const r = await web(hostOf(S.iid, ZONE), '/version', { cookie: S.cookie }); return r.status === 410 ? r : null; }, { timeoutMs: 15000, label: 'the gate to show the ended page' });
  assert.match(gone.text, /This lab has ended/);
  note(`after the deadline: attempt ${st.state}, access ${st.access}, gate 423 paused page; after the destroy tick: destroyed ${end.destroyed}, attempt ${end.state}, orchestrator ${o.status}, no instance container, gate 410`);
});

step(10, 'cleanup: everything labelled with the run id is removed and a check proves none is left', async (note) => {
  const logs = await Promise.all([GATE, CADDY].map(async (n) => { const r = await docker(['logs', n]); return r.stdout + r.stderr; }));
  for (const s of S.spent ?? []) for (const l of logs) assert.ok(!l.includes(s), 'a ticket or cookie value is in a log');
  const left = await cleanupAll();
  assert.equal(left.total, 0, leftoverText(left));
  note(`cleanup check: ${leftoverText(left)}; no ticket or cookie value in the Caddy or gate log`);
});
