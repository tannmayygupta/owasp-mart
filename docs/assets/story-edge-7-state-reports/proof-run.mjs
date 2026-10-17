// Local proof of edge story 7 (H-147 point 1): the orchestrator CONTAINER pushes state reports over TLS to the platform receiver
// `POST /internal/v1/orch/state` (apps/api/src/vulnmart/lab/state_reports.py), through the real compose files (compose.yaml + lab.reports.yaml).
//   Run from the repository root: node docs/assets/story-edge-7-state-reports/proof-run.mjs
// Setup (Docker Desktop, throwaway): the receiver is the real ingest app (uvicorn, VULNMART_LAB_RUNTIME=1, report key file) run as a HOST process on
// 127.0.0.1 with TLS; the orchestrator container reaches it as https://host.docker.internal:<port>. Two throwaway CAs (one for the orchestrator listener,
// one that signed the receiver certificate and is given to the container as SSL_CERT_FILE). Everything secret lives in a temp folder, never in the repository.
// Mid-run the receiver is stopped and started again: the reports of the destroy are queued and retried by the pusher while it is down. The receiver keeps
// its history in memory only (D-96), so the history of the first receiver process and of the second one are read separately and must join without gap or
// duplicate. Test-only differences from production, in a temp override file: --allow-local-images, a relaxed template schema, labels, secrets via a volume.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { relaxSchema } from '../../../scripts/demo.mjs';
import { ROOT, canConnect, docker, imageId, loopManifest, loopTemplate, orchSign, pollUntil, redactAll, run, sleep, waitListening } from '../../../scripts/e2e/loop-support.mjs';

const OUT = path.join(ROOT, 'docs', 'assets', 'story-edge-7-state-reports', 'proof-output.txt');
const RUN = `vmrep${randomBytes(3).toString('hex')}`;
const KIND = 'state-report-proof';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-rep-'));
const ORCH_DIR = path.join(TMP, 'orch');
const EDGE_SEC = path.join(TMP, 'edge-secrets');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'compose', 'compose.yaml');
const REPORTS_FILE = path.join(ROOT, 'infra', 'compose', 'lab.reports.yaml');
const OVERRIDE = path.join(TMP, 'override.yaml');
const PROJECT = 'vulnmart';
const GATE = 'vulnmart-edge-gate';
const ORCH = 'vulnmart-orchestrator';
const ZONE = 'labs.invalid';
const RPORT = 18444;
const KEY = randomBytes(32).toString('hex');       // platform key (platform -> orchestrator)
const RKEY = randomBytes(32).toString('hex');      // report key (orchestrator -> platform)
const ADMIN = randomBytes(16).toString('hex');
const GATEKEY = randomBytes(32).toString('hex');
const DEMO = randomBytes(16).toString('hex');
const SECRETS = [KEY, RKEY, ADMIN, GATEKEY, DEMO];
const lines = [];
const rows = [];
const log = (s = '') => { const t = redactAll(s, SECRETS); lines.push(t); console.log(t); };
const composeEnv = { ...process.env, VULNMART_ORCH_DIR: ORCH_DIR, VULNMART_EDGE_SECRETS: EDGE_SEC, VULNMART_ORCH_REPORT_URL: `https://host.docker.internal:${RPORT}` };
const compose = (args, opts = {}) => run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '-f', REPORTS_FILE, '-f', OVERRIDE, '--profile', 'lab', ...args], { env: composeEnv, cwd: path.join(ROOT, 'infra', 'compose'), timeout: 1200000, ...opts });
const check = (name, ok, detail = '') => { rows.push(ok); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) throw new Error(`step failed: ${name}`); };
const dk = async (args) => { const r = await docker(args); if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${r.stderr.trim().slice(0, 300)}`); return r.stdout.trim(); };
const vmObjects = async () => ({
  containers: (await docker(['ps', '-a', '--filter', 'name=vm-', '--format', '{{.Names}}'])).stdout.trim(),
  networks: (await docker(['network', 'ls', '--filter', 'name=vm-', '--format', '{{.Name}}'])).stdout.trim(),
  volumes: (await docker(['volume', 'ls', '--filter', 'name=vm-', '--format', '{{.Name}}'])).stdout.trim(),
});

// ---- signed call to the orchestrator over mutual TLS
const otls = () => ({ ca: fs.readFileSync(path.join(TMP, 'ca.pem')), cert: fs.readFileSync(path.join(TMP, 'client.pem')), key: fs.readFileSync(path.join(TMP, 'client.key')) });
function call(method, target, bodyObj) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  const nonce = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: 9443, servername: 'localhost', path: target, method, timeout: 30000, ...otls(),
      headers: { 'content-type': 'application/json', 'x-vm-timestamp': ts, 'x-vm-nonce': nonce, 'x-vm-signature': orchSign(KEY, method, target, ts, nonce, body) },
    }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const text = Buffer.concat(c).toString('utf8'); let json; try { json = JSON.parse(text); } catch { /* none */ } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}

// ---- the receiver: the real ingest app as a host process with TLS
let pyExe = null;
let receiver = null;
let recvN = 0;
async function startReceiver() {
  recvN += 1;
  const logFile = path.join(TMP, `receiver-${recvN}.log`);
  const out = fs.openSync(logFile, 'a');
  receiver = spawn(pyExe, ['-m', 'uvicorn', 'vulnmart.kernel.entrypoints.ingest:app', '--host', '127.0.0.1', '--port', String(RPORT), '--ssl-certfile', path.join(TMP, 'rsrv.pem'), '--ssl-keyfile', path.join(TMP, 'rsrv.key')], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, VULNMART_LAB_RUNTIME: '1', VULNMART_LAB_DEMO: '1', VULNMART_LAB_DEMO_TOKEN: DEMO, VULNMART_ORCH_REPORT_KEY_FILE: path.join(TMP, 'report_key') },
  });
  receiver.logFile = logFile;
  return waitListening(receiver, RPORT, 120000);
}
async function stopReceiver() {
  if (!receiver) return;
  const pid = receiver.pid;
  await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  for (let i = 0; i < 40 && await canConnect(RPORT); i += 1) await sleep(250);
  receiver = null;
}
function rcall(method, target, { body = '', headers = {}, sign = true, token = false } = {}) {
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  const nonce = randomBytes(16).toString('hex');
  const h = { 'content-type': 'application/json', ...headers, ...(sign ? { 'x-vm-timestamp': ts, 'x-vm-nonce': nonce, 'x-vm-signature': orchSign(RKEY, method, target, ts, nonce, body) } : {}), ...(token ? { 'x-lab-demo-token': DEMO } : {}) };
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: RPORT, path: target, method, timeout: 15000, ca: fs.readFileSync(path.join(TMP, 'rca.pem')), headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const text = Buffer.concat(c).toString('utf8'); let json; try { json = JSON.parse(text); } catch { /* none */ } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}
const recorded = async (id) => { try { const r = await rcall('GET', `/internal/v1/lab-demo/instances/${id}`, { sign: false, token: true }); return r.status === 200 ? r.json : null; } catch { return null; } };
const nums = (h) => h.transitions.map((t) => t.transition);

async function teardown(id, preExisting) {
  log('--- teardown');
  await stopReceiver();
  if (id) {
    const cs = (await docker(['ps', '-aq', '--filter', `label=vm.instance=${id}`])).stdout.split('\n').filter(Boolean);
    if (cs.length) await docker(['rm', '-f', '-v', ...cs]);
    for (const n of (await docker(['network', 'ls', '-q', '--filter', `label=vm.instance=${id}`])).stdout.split('\n').filter(Boolean)) await docker(['network', 'rm', n]);
    for (const v of (await docker(['volume', 'ls', '-q', '--filter', `label=vm.instance=${id}`])).stdout.split('\n').filter(Boolean)) await docker(['volume', 'rm', '-f', v]);
  }
  const svcs = ['orchestrator', 'edge-gate', ...(preExisting ? [] : ['docker-proxy'])];
  const rm = await compose(['rm', '-sf', '-v', ...svcs]);
  log(`compose rm ${svcs.join(' ')}: exit ${rm.status}`);
  await docker(['volume', 'rm', '-f', `${PROJECT}_orch-state`, `${RUN}-secrets`]);
  await docker(['network', 'rm', 'vulnmart-edge-public']);
  if (!preExisting) await docker(['network', 'rm', 'vulnmart-labs-core']);
  const stray = (await docker(['ps', '-aq', '--filter', `label=vm.run=${RUN}`])).stdout.split('\n').filter(Boolean);
  if (stray.length) await docker(['rm', '-f', '-v', ...stray]);
  fs.rmSync(TMP, { recursive: true, force: true });
}

let iid = null;
let pre = null;
let proxyPre = false;
try {
  log(`VulnMart edge story 7: state reports from the orchestrator container to the platform receiver (run ${RUN})`);
  log(`Date: ${new Date().toLocaleDateString('en-CA')}; machine: laptop with Docker Desktop (${(await docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim()})`);
  log('Setup: receiver = the real ingest app (uvicorn, TLS, VULNMART_LAB_RUNTIME=1 + report key file) as a HOST process on 127.0.0.1; orchestrator = the COMPOSE CONTAINER (compose.yaml + lab.reports.yaml) reaching it as https://host.docker.internal.');
  log('Why the container and not a host process: it is the deployed shape (H-143) and it must trust the private CA through SSL_CERT_FILE from a file secret, which a host process would not exercise.');
  log('');
  log('--- before: objects of the project already on the machine (not started by this run)');
  const before = (await docker(['ps', '-a', '--format', '{{.Names}} {{.Status}}', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.trim();
  log(before || '(none)');
  proxyPre = before.includes('vulnmart-docker-proxy');
  pre = await vmObjects();
  check('no vm-* container or network before the run (a volume vm-gomod of another project may exist and is left alone)', !pre.containers && !pre.networks, `volumes already there: '${pre.volumes}'`);
  const stubId = imageId('vulnmart-stub-instance:local');
  check('the stub instance image is present locally', !!stubId);
  check('the receiver port is free on the host', !(await canConnect(RPORT)), `port ${RPORT}`);
  pyExe = (await run('uv', ['run', '--locked', '--package', 'vulnmart-api', 'python', '-c', 'import sys;print(sys.executable)'], { cwd: ROOT })).stdout.trim().split(/\r?\n/).pop();
  check('the api virtual environment python is found', !!pyExe && fs.existsSync(pyExe));

  // ---- temporary inputs
  for (const d of [path.join(ORCH_DIR, 'secrets'), path.join(ORCH_DIR, 'templates'), EDGE_SEC]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ORCH_DIR, 'secrets', 'platform_key'), `${KEY}\n`);
  fs.writeFileSync(path.join(TMP, 'report_key'), `${RKEY}\n`);
  fs.writeFileSync(path.join(ORCH_DIR, 'secrets', 'report_key'), `${RKEY}\n`);
  fs.writeFileSync(path.join(EDGE_SEC, 'gate_key_current'), `${GATEKEY}\n`);
  fs.writeFileSync(path.join(EDGE_SEC, 'gate_key_previous'), '');
  fs.writeFileSync(path.join(EDGE_SEC, 'gate_admin_secret'), `${ADMIN}\n`);
  const conf = path.join(TMP, 'openssl.cnf'); fs.writeFileSync(conf, '[req]\ndistinguished_name = dn\n[dn]\n');
  const env = { ...process.env, OPENSSL_CONF: conf };
  const ossl = async (...a) => { const r = await run('openssl', a, { cwd: TMP, env }); if (r.status !== 0) throw new Error(`openssl ${a[0]}: ${r.stderr.slice(-200)}`); };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  for (const [ca, cn] of [['ca', 'proof CA'], ['rca', 'proof report CA']]) {
    await ossl('req', '-x509', ...ec, '-keyout', `${ca}.key`, '-out', `${ca}.pem`, '-days', '1', '-subj', `/CN=${cn}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  }
  for (const [name, ca, usage, san] of [['server', 'ca', 'serverAuth', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], ['client', 'ca', 'clientAuth', ''], ['rsrv', 'rca', 'serverAuth', 'subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1']]) {
    await ossl('req', '-new', ...ec, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    fs.writeFileSync(path.join(TMP, `${name}.ext`), `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=${usage}\n${san}\n`);
    await ossl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`);
  }
  fs.copyFileSync(path.join(TMP, 'server.pem'), path.join(ORCH_DIR, 'secrets', 'tls_cert.pem'));
  fs.copyFileSync(path.join(TMP, 'server.key'), path.join(ORCH_DIR, 'secrets', 'tls_key.pem'));
  fs.copyFileSync(path.join(TMP, 'ca.pem'), path.join(ORCH_DIR, 'secrets', 'tls_ca.pem'));
  fs.copyFileSync(path.join(TMP, 'rca.pem'), path.join(ORCH_DIR, 'secrets', 'report_ca.pem'));
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'examples', 'valid', 'instance-template', 'shop-template.json'), 'utf8'));
  fs.writeFileSync(path.join(ORCH_DIR, 'templates', 'shop-v0.json'), JSON.stringify(loopTemplate(template)));
  fs.writeFileSync(path.join(ORCH_DIR, 'images.json'), JSON.stringify(loopManifest({ stubId, relayUrl: `http://${GATE}:8081/internal/v1/events` })));
  fs.writeFileSync(path.join(TMP, 'template.schema.json'), JSON.stringify(relaxSchema(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'instance-template.schema.json'), 'utf8')))));

  // ---- the secrets volume (Docker Desktop shows bind-mounted files as mode 777 and Compose ignores a secret's mode; see the edge-6 proof)
  await dk(['volume', 'create', '--label', `vm.kind=${KIND}`, '--label', `vm.run=${RUN}`, `${RUN}-secrets`]);
  const copy = [['orch/secrets/platform_key', 'platform_key'], ['edge-secrets/gate_admin_secret', 'gate_admin_secret'], ['orch/secrets/tls_cert.pem', 'tls_cert'], ['orch/secrets/tls_key.pem', 'tls_key'], ['orch/secrets/tls_ca.pem', 'tls_ca'], ['orch/secrets/report_key', 'report_key'], ['orch/secrets/report_ca.pem', 'report_ca']]
    .map(([from, to]) => `cp /src/${from} /dst/${to}`).join(' && ');
  await dk(['run', '--rm', '--network', 'none', '--label', `vm.kind=${KIND}`, '--label', `vm.run=${RUN}`, '-v', `${TMP}:/src:ro`, '-v', `${RUN}-secrets:/dst`, 'busybox:1.37.0-musl', 'sh', '-c', `${copy} && chown 65532:65532 /dst/* && chmod 400 /dst/*`]);

  // ---- temp override: test-only flags and labels (the committed files are unchanged)
  const doc = yaml.load(fs.readFileSync(COMPOSE_FILE, 'utf8'));
  const labels = { 'vm.kind': KIND, 'vm.run': RUN };
  fs.writeFileSync(OVERRIDE, yaml.dump({
    services: {
      orchestrator: {
        command: [...doc.services.orchestrator.command, '--allow-local-images', '--template-schema', '/etc/vulnmart/template.schema.json', '--rate-per-s', '0'],
        secrets: '__RESET__',
        volumes: [`${path.join(TMP, 'template.schema.json').replace(/\\/g, '/')}:/etc/vulnmart/template.schema.json:ro`, 'proof-secrets:/run/secrets:ro'],
        labels,
      },
      'edge-gate': { labels },
    },
    networks: { 'edge-public': { labels } },
    volumes: { 'orch-state': { labels }, 'proof-secrets': { external: true, name: `${RUN}-secrets` } },
  }).replace('secrets: __RESET__', 'secrets: !reset []'));
  log('test-only differences from the committed files (temp override outside the repository): --allow-local-images, --template-schema (relaxed, mounted), --rate-per-s 0, labels, secrets from a volume');

  // ---- receiver 1 (before the orchestrator, so the first report finds it)
  check('receiver (process 1) listens with TLS on 127.0.0.1', await startReceiver(), `port ${RPORT}`);
  const unsigned = await rcall('POST', '/internal/v1/orch/state', { body: '{}', sign: false });
  check('the route is mounted and an unsigned post is 401 ORCH-BAD-SIGNATURE', unsigned.status === 401 && unsigned.json?.code === 'ORCH-BAD-SIGNATURE', `status ${unsigned.status}`);

  // ---- up (lab.reports.yaml is part of the compose chain)
  const up = await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '300', 'orchestrator']);
  log(`compose -f compose.yaml -f lab.reports.yaml up -d --build --wait orchestrator: exit ${up.status}`);
  if (up.status !== 0) { log(redactAll((up.stdout + up.stderr).slice(-1500), SECRETS)); throw new Error('compose up failed'); }
  const insp = JSON.parse(await dk(['inspect', ORCH]))[0];
  check('orchestrator container is running and healthy', insp.State.Running && insp.State.Health?.Status === 'healthy', insp.State.Health?.Status);
  const envList = insp.Config.Env.filter((e) => /^(VM_ORCH_REPORT|SSL_CERT_FILE)/.test(e));
  log(`report-related environment of the container: ${envList.map((e) => e.replace(/https:\/\/host\.docker\.internal:\d+/, 'https://host.docker.internal:<port>')).join(' ')}`);
  check('the container has the report URL, the key FILE path and the CA file path (paths only)', envList.some((e) => e.startsWith('VM_ORCH_REPORT_URL=https://')) && envList.includes('VM_ORCH_REPORT_KEY_FILE=/run/secrets/report_key') && envList.includes('SSL_CERT_FILE=/run/secrets/report_ca'));
  check('docker inspect of the container holds no key or secret', ![KEY, RKEY, ADMIN, GATEKEY].some((s) => JSON.stringify(insp).includes(s)));

  // ---- one stub instance
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  iid = 'i-' + Array.from(randomBytes(16), (b) => alphabet[b % 32]).join('');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'orchestrator', 'examples', 'valid', 'create.request.json'), 'utf8'));
  const create = await call('POST', '/v1/instances', { ...example, instance_id: iid, hostname: `${iid.toLowerCase()}.${ZONE}`, limits: { ...example.limits, memory_mb: 256 } });
  check('create answers 202', create.status === 202, `state ${create.json?.state}`);
  const ready = await pollUntil(async () => { const r = await call('GET', `/v1/instances/${iid}`); return r.status === 200 && ['ready', 'failed'].includes(r.json.state) ? r.json : null; }, { timeoutMs: 120000, intervalMs: 1000, label: 'the instance to be ready' });
  check('the instance reaches ready in the orchestrator', ready.state === 'ready', `state ${ready.state}, error ${ready.error_code}`);
  const gotReady = await pollUntil(async () => { const h = await recorded(iid); return h && h.state === 'ready' ? h : null; }, { timeoutMs: 60000, intervalMs: 500, label: 'the receiver to record ready' });
  const A = gotReady;
  log(`receiver process 1 recorded: ${A.transitions.map((t) => `#${t.transition} ${t.from_state ?? 'none'}->${t.to_state}`).join(', ')}`);
  check('receiver 1 has transitions 1..k in order and the recorded state is ready', JSON.stringify(nums(A)) === JSON.stringify(A.transitions.map((_, i) => i + 1)) && A.transitions.length >= 4 && A.transitions[0].to_state === 'requested', `k = ${A.transitions.length}`);
  const logA = fs.readFileSync(receiver.logFile, 'utf8');
  const copyA = JSON.parse(JSON.stringify(A));

  // ---- stop the receiver, destroy while it is down
  await stopReceiver();
  check('receiver process 1 is stopped (the port no longer accepts)', !(await canConnect(RPORT)));
  const des = await call('POST', `/v1/instances/${iid}/destroy`);
  check('destroy answers 200 or 202 while the receiver is down', [200, 202].includes(des.status), `status ${des.status}`);
  const gone = await pollUntil(async () => { const r = await call('GET', `/v1/instances/${iid}`); return r.status === 404 || r.json?.state === 'destroyed' ? r : null; }, { timeoutMs: 90000, intervalMs: 1000, label: 'the destroy to finish' });
  check('the instance is destroyed in the orchestrator although the receiver is down', gone.status === 404 || gone.json.state === 'destroyed', `state ${gone.json?.state ?? 'none'}`);
  await sleep(6000); // at least one retry after the longest pause (5 s)
  const olog = await docker(['logs', ORCH]);
  const failures = (olog.stdout + olog.stderr).split('\n').filter((l) => /state report failed/.test(l));
  log(`orchestrator container log lines about failed pushes: ${failures.length} (first: ${failures[0]?.replace(/^.*?(state report failed)/, '$1') ?? 'none'})`);
  check('the pusher logged failed attempts while the receiver was down and keeps the reports queued', failures.length >= 2);

  // ---- receiver 2 (same key file, same certificate, empty memory)
  check('receiver (process 2) listens again', await startReceiver());
  const done = await pollUntil(async () => { const h = await recorded(iid); return h && h.state === 'destroyed' ? h : null; }, { timeoutMs: 60000, intervalMs: 500, label: 'the receiver to record destroyed' });
  const B = done;
  log(`receiver process 2 recorded: ${B.transitions.map((t) => `#${t.transition} ${t.from_state ?? 'none'}->${t.to_state}`).join(', ')}`);
  const all = [...copyA.transitions, ...B.transitions];
  const n = all.length;
  check('the two receiver histories join: numbers 1..n with no gap and no duplicate', JSON.stringify(all.map((t) => t.transition)) === JSON.stringify(Array.from({ length: n }, (_, i) => i + 1)), `n = ${n}: ${copyA.transitions.length} before the restart, ${B.transitions.length} after`);
  check('the chain is consistent: each from_state is the previous to_state, first is requested, last is destroyed', all.every((t, i) => t.from_state === (i === 0 ? null : all[i - 1].to_state)) && all[0].to_state === 'requested' && all[n - 1].to_state === 'destroyed', all.map((t) => t.to_state).join(' > '));
  check('every report is epoch 1 (one life of the instance)', all.every((t) => t.epoch === 1));
  check('receiver 2 recorded state is destroyed', B.state === 'destroyed');
  await sleep(1500);

  // ---- repeats and mismatches against the live receiver, signed with the report key
  const last = B.transitions[B.transitions.length - 1];
  const orchLogAll = (await docker(['logs', ORCH]));
  const refused = (orchLogAll.stdout + orchLogAll.stderr).split('\n').filter((l) => /state report refused/.test(l));
  check('the pusher was never refused by the receiver (no "state report refused" line)', refused.length === 0, `${refused.length} lines`);
  // A repeat: the same wire body again must be 200. The body the orchestrator sent is rebuilt from the recorded fields; `at`, `reason` and `health`
  // are not exposed by the demo route, so the repeat uses a report this script itself first sends (new -> 204) and then repeats (-> 200), then changes (-> 409).
  const mine = (over = {}) => JSON.stringify({ instance_id: 'i-ZZZZZZZZZZZZZZZZ', epoch: 1, transition: 1, from_state: null, to_state: 'requested', at: '2026-10-17T12:00:00Z', reason: 'proof', error_code: null, health: 'unknown', ...over });
  const r1 = await rcall('POST', '/internal/v1/orch/state', { body: mine() });
  const r2 = await rcall('POST', '/internal/v1/orch/state', { body: mine() });
  const r3 = await rcall('POST', '/internal/v1/orch/state', { body: mine({ reason: 'changed' }) });
  check('a new report is 204, the identical repeat is 200, the same identity with another body is 409', r1.status === 204 && r2.status === 200 && r3.status === 409 && r3.json?.code === 'ORCH-REQUEST-MISMATCH', `${r1.status} ${r2.status} ${r3.status}`);
  const r4 = await rcall('POST', '/internal/v1/orch/state', { body: mine({ transition: 2, to_state: 'destroyed', from_state: 'requested' }) });
  const h4 = await recorded('i-ZZZZZZZZZZZZZZZZ');
  check('an impossible transition (requested -> destroyed) is 204, kept as history, and does not move the recorded state', r4.status === 204 && h4.state === 'requested' && h4.transitions.length === 2, `status ${r4.status}, state ${h4.state}`);
  const logB = fs.readFileSync(receiver.logFile, 'utf8');
  check('exactly one impossible-transition warning in the receiver 2 log, and none came from the real orchestrator reports', (logB.match(/impossible state transition/g) ?? []).length === 1 && !/impossible state transition/.test(logA) && !logB.split('\n').some((l) => /impossible state transition/.test(l) && l.includes(iid)));
  const olog3 = await docker(['logs', ORCH]);
  check('no key or secret in the orchestrator log, the receiver logs or the evidence', ![KEY, RKEY, ADMIN, GATEKEY, DEMO].some((s) => (olog3.stdout + olog3.stderr + logA + logB).includes(s)));
  const after = await vmObjects();
  check('after destroy: no vm-* container or network, volumes as before the run', !after.containers && !after.networks && after.volumes === pre.volumes, `containers '${after.containers}', networks '${after.networks}', volumes '${after.volumes}'`);

  log('');
  log(`Result: all ${rows.length} checks PASS`);
} catch (e) {
  log(`FAILED: ${redactAll(String(e?.message ?? e), SECRETS)}`);
  try {
    const l = await docker(['logs', '--tail', '400', ORCH]); log('--- orchestrator log tail (request lines left out)');
    log(redactAll((l.stdout + l.stderr).split('\n').filter((x) => !x.includes('"event":"request"') && !/Exception ignored|Traceback|File "|super\(\)|self\.fp|ValueError: I\/O/.test(x)).slice(-25).join('\n'), SECRETS));
    if (receiver) log(`--- receiver log tail\n${redactAll(fs.readFileSync(receiver.logFile, 'utf8').split('\n').slice(-15).join('\n'), SECRETS)}`);
  } catch { /* none */ }
  process.exitCode = 1;
} finally {
  await teardown(iid, proxyPre);
  log('--- after teardown: leftovers of this run and of vm-*');
  log(`docker ps -a --filter label=vm.run=${RUN}: ${(await docker(['ps', '-aq', '--filter', `label=vm.run=${RUN}`])).stdout.trim() || '(empty)'}`);
  log(`docker network ls --filter label=vm.run=${RUN}: ${(await docker(['network', 'ls', '-q', '--filter', `label=vm.run=${RUN}`])).stdout.trim() || '(empty)'}`);
  log(`docker volume ls --filter label=vm.run=${RUN}: ${(await docker(['volume', 'ls', '-q', '--filter', `label=vm.run=${RUN}`])).stdout.trim() || '(empty)'}`);
  const vm = await vmObjects();
  log(`vm-* containers '${vm.containers}', networks '${vm.networks}', volumes '${vm.volumes}' (any volume listed here was already there before the run)`);
  log('docker ps -a (all containers now):');
  log((await docker(['ps', '-a', '--format', '{{.Names}} {{.Status}}'])).stdout.trim() || '(none)');
  log(`networks named vulnmart*: ${(await docker(['network', 'ls', '--format', '{{.Name}}', '--filter', 'name=vulnmart'])).stdout.trim().replace(/\r?\n/g, ', ') || '(none)'}`);
  log(`volumes named vulnmart*: ${(await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=vulnmart'])).stdout.trim() || '(none)'}`);
  log(`receiver port ${RPORT} still accepting: ${await canConnect(RPORT)}; temp folder present: ${fs.existsSync(TMP)}`);
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
}
await sleep(0);
