// End-to-end proof of the edge service (story edge-2, D-62, D-64; the local part of spike S-15) on REAL Docker:
//   stock Caddy (TLS, strict host test) -> edge-gate (apps/edge) -> stub instances (sidecar + shop from contracts/mocks/stub-instance),
//   each instance on its own --internal network, the edge attached to every one of them, and the fake ingest behind the event relay.
// Needs Docker running (the whole file is skipped with a message otherwise) and openssl (skipped with a message without it).
// Run: node --test scripts/e2e/edge.e2e.test.mjs     (EDGE_E2E_NETWORKS=6 for a slow machine; the default is 20)
// Everything is throwaway: random keys and secrets live in a temporary folder and in memory only, the certificate is self-signed and made here,
// every container and network carries the labels vm.kind=edge-test and vm.run=<run id>, and the `after` hook removes them and checks that none is left.
// The edge and Caddy are started with the run flags of infra/compose/compose.yaml (services edge-gate and edge-caddy), read from the file, so the
// hardening is the one that ships. Differences from compose, on purpose: 443 is published on 127.0.0.1 with a free host port, and the networks are made here.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { newJti, signCookie, signTicket } from '../../apps/edge/src/tickets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_DIR = path.join(ROOT, 'infra', 'compose');
const compose = yaml.load(fs.readFileSync(path.join(COMPOSE_DIR, 'compose.yaml'), 'utf8'));
const STUB_IMAGE = 'vulnmart-stub-instance:local';
const EDGE_IMAGE = compose.services['edge-gate'].image;
const CADDY_IMAGE = compose.services['edge-caddy'].image;
const ZONE = 'labs.test';
const N = Number(process.env.EDGE_E2E_NETWORKS ?? 20);
const RUN = `vmedge${randomBytes(3).toString('hex')}`;
const LABEL = ['--label', 'vm.kind=edge-test', '--label', `vm.run=${RUN}`];
const NET_PUB = `${RUN}-pub`;
const NET_CORE = `${RUN}-core`;
const GATE = `${RUN}-edge-gate`;
const CADDY = `${RUN}-edge-caddy`;
const INGEST = `${RUN}-ingest`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-edge-e2e-'));

const dockerInfo = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20000 });
const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
const SKIP = !(dockerInfo.status === 0 && /^\d/.test(dockerInfo.stdout.trim()))
  ? 'Docker is not running: start Docker Desktop, then run the edge e2e test again.'
  : openssl.status !== 0 ? 'openssl is not installed: the test needs it to make a throwaway self-signed certificate.' : false;

// ------------------------------------------------------------------ helpers
const run = (args, { input, cmd = 'docker', timeout = 240000 } = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const timer = setTimeout(() => p.kill(), timeout);
  p.stdout.on('data', (c) => (stdout += c));
  p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  p.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: String(e) }); });
  p.stdin.on('error', () => {});
  p.stdin.end(input);
});
const docker = async (args, opts) => {
  const r = await run(args, opts);
  assert.equal(r.status, 0, `docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim().slice(0, 400)}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n = 32) => randomBytes(n).toString('hex');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const newId = () => `i-${Array.from(randomBytes(16), (b) => B32[b % 32]).join('')}`;
const hostOf = (id) => `${id.toLowerCase()}.${ZONE}`;
const sidecarName = (id) => `vm-${id.toLowerCase()}-e1-sidecar`;
const shopName = (id) => `vm-${id.toLowerCase()}-e1-shop`;
const subst = (text, vars) => String(text).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k, d) => vars[k] ?? d ?? '');

/** The run flags of a compose service as docker arguments: the hardening that ships. mounts maps a container path to a host path. */
function composeFlags(svc, { vars = {}, mounts = {}, env = {} } = {}) {
  const a = [];
  if (svc.user) a.push('--user', String(svc.user));
  if (svc.read_only) a.push('--read-only');
  for (const c of svc.cap_drop ?? []) a.push('--cap-drop', c);
  for (const c of svc.cap_add ?? []) a.push('--cap-add', c);
  for (const s of svc.security_opt ?? []) a.push('--security-opt', s);
  for (const t of svc.tmpfs ?? []) a.push('--tmpfs', t);
  if (svc.mem_limit) a.push('--memory', String(svc.mem_limit));
  if (svc.pids_limit) a.push('--pids-limit', String(svc.pids_limit));
  for (const [k, v] of Object.entries({ ...(svc.environment ?? {}), ...env })) a.push('-e', `${k}=${subst(v, vars)}`);
  for (const v of svc.volumes ?? []) {
    const m = /^(.*?):(\/[^:]*)(?::(\w+))?$/.exec(subst(v, vars));
    assert.ok(m, `cannot read the compose volume ${v}`);
    const host = m[1].startsWith('.') ? path.resolve(COMPOSE_DIR, m[1]) : mounts[m[2]];
    assert.ok(host, `the compose file mounts ${m[2]} and this test does not know it: add it to the test`);
    a.push('-v', `${host}:${m[2]}${m[3] ? `:${m[3]}` : ''}`);
  }
  return a;
}

/** A tiny client run INSIDE a container (docker exec -i ... node -e): http, tcp and dns probes from that container's point of view. */
const PROBE_JS = `
const http=require('http'),net=require('net'),dns=require('dns');
let raw='';process.stdin.on('data',c=>raw+=c).on('end',async()=>{const out=[];for(const s of JSON.parse(raw))out.push(await one(s));console.log(JSON.stringify(out));});
function one(s){return new Promise(res=>{const to=s.timeoutMs||3000;
 if(s.kind==='tcp'){const c=net.connect({host:s.host,port:s.port});const t=setTimeout(()=>{c.destroy();res({result:'timeout'})},to);
  c.on('connect',()=>{clearTimeout(t);c.destroy();res({result:'connected'})});c.on('error',e=>{clearTimeout(t);res({result:e.code||'error'})});return;}
 if(s.kind==='dns'){dns.lookup(s.host,{family:4},(e,a)=>res(e?{result:e.code||'error'}:{result:'resolved',address:a}));return;}
 const body=s.bodyB64?Buffer.from(s.bodyB64,'base64'):undefined;
 const r=http.request({host:s.host,port:s.port,method:s.method||'GET',path:s.path||'/',headers:s.headers||{},timeout:to},rs=>{const c=[];rs.on('data',x=>c.push(x));rs.on('end',()=>res({status:rs.statusCode,text:Buffer.concat(c).toString('utf8')}));});
 r.on('timeout',()=>{r.destroy();res({result:'timeout'})});r.on('error',e=>res({result:e.code||'error'}));r.end(body);});}`;
async function probe(container, specs) {
  const r = await run(['exec', '-i', container, 'node', '-e', PROBE_JS], { input: JSON.stringify(specs), timeout: 120000 });
  assert.equal(r.status, 0, `probe in ${container}: ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout.trim());
}

// ------------------------------------------------------------------ the rig
const keys = { current: randomBytes(32) };
const adminSecret = hex(16);
const eventKey = hex(32); // the fake ingest's throwaway key for instance 0 (the stub sidecar signs with it)
const instances = []; // { id, net, owner, shop, sidecar, marker }
let clockOffsetS = 0;
let tlsPort;
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
const spent = []; // every ticket and cookie value used, checked against the logs at the end

/** One HTTPS request to Caddy with an exact Host header. Resolves { status, headers, text }. */
const web = (host, p = '/', { cookie, method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port: tlsPort, path: p, method, agent, servername: 'x.labs.test', timeout: 15000,
    headers: { host, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
  });
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', reject);
  r.end(body);
});
const ticketFor = (inst, own, ae = 1) => {
  const t = signTicket(keys, { inst: inst.id ?? inst, own, ae, exp: Math.floor(Date.now() / 1000) + clockOffsetS + 30, jti: newJti() });
  spent.push(t);
  return t;
};
const cookiePair = (res) => [].concat(res.headers['set-cookie'] ?? [])[0]?.split(';')[0];
async function enter(inst, { own = inst.owner, ae = 1, host = hostOf(inst.id) } = {}) {
  const res = await web(host, `/_vm/enter?t=${ticketFor(inst, own, ae)}`);
  const c = cookiePair(res);
  if (c) spent.push(c.split('=')[1]);
  return { res, cookie: c };
}
async function adminCall(method, p, body, { secret = adminSecret } = {}) {
  const js = `let raw='';process.stdin.on('data',c=>raw+=c).on('end',()=>{const s=JSON.parse(raw);const http=require('http');const h={'content-type':'application/json'};if(s.secret)h['x-vm-gate-admin']=s.secret;
const r=http.request({host:'edge-gate-admin',port:9090,method:s.method,path:s.path,headers:h},rs=>{const c=[];rs.on('data',x=>c.push(x));rs.on('end',()=>console.log(JSON.stringify({status:rs.statusCode,text:Buffer.concat(c).toString()})));});
r.on('error',e=>console.log(JSON.stringify({error:e.code})));r.end(s.body===undefined?undefined:JSON.stringify(s.body));});`;
  const r = await run(['exec', '-i', GATE, 'node', '-e', js], { input: JSON.stringify({ method, path: p, body, secret }) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}
const record = (inst, over = {}) => ({ hostname: hostOf(inst.id), instance_id: inst.id, epoch: 1, owner: inst.owner, access: 'open', access_epoch: 1, ...over });
const logLines = async (name, re) => {
  const r = await run(['logs', name]);
  return (r.stdout + r.stderr).split('\n').filter((l) => re.test(l)).length;
};
const shopHits = (inst) => logLines(shopName(inst.id), /^(GET|POST|HEAD|PUT|DELETE) /);
const gateHits = () => logLines(GATE, /^player /);
const ingestEvents = async () => {
  const [r] = await probe(INGEST, [{ kind: 'http', host: '127.0.0.1', port: 8081, path: '/_fake/events' }]);
  return JSON.parse(r.text);
};
const inspect = async (name) => JSON.parse(await docker(['inspect', name]))[0];
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

before(async () => {
  if (SKIP) return;
  const b1 = await run(['build', '-q', '-f', 'contracts/mocks/stub-instance/Dockerfile', '-t', STUB_IMAGE, ROOT]);
  assert.equal(b1.status, 0, b1.stderr);
  const b2 = await run(['build', '-q', '-f', 'apps/edge/Dockerfile', '-t', EDGE_IMAGE, ROOT]);
  assert.equal(b2.status, 0, b2.stderr);
  // certificate, key files, admin secret: a throwaway folder, readable by the container users (the production key is root-only and Caddy runs as root, H-115)
  const certDir = path.join(TMP, 'certs');
  const secDir = path.join(TMP, 'secrets');
  fs.mkdirSync(certDir, { mode: 0o755 }); fs.mkdirSync(secDir, { mode: 0o755 });
  const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'privkey.pem'), '-out', path.join(certDir, 'fullchain.pem'), '-days', '1', '-subj', `/CN=*.${ZONE}`, '-addext', `subjectAltName=DNS:*.${ZONE}`], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  fs.chmodSync(path.join(certDir, 'privkey.pem'), 0o644);
  fs.writeFileSync(path.join(secDir, 'gate_key_current'), `${keys.current.toString('hex')}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(secDir, 'gate_key_previous'), '', { mode: 0o644 }); // empty: "no previous key"
  fs.writeFileSync(path.join(secDir, 'ingest_ca.pem'), '', { mode: 0o644 }); // the compose file mounts the CA of an https ingest; this test uses http and the edge reads an empty file as none
  fs.writeFileSync(path.join(secDir, 'gate_admin_secret'), `${adminSecret}\n`, { mode: 0o644 });

  await docker(['network', 'create', ...LABEL, NET_PUB]);
  await docker(['network', 'create', '--internal', ...LABEL, NET_CORE]);

  // instances: one internal network each, stub shop and stub sidecar with the names the builder gives
  for (let i = 0; i < N; i++) {
    const id = newId();
    instances.push({ id, i, net: `${RUN}-n${i}`, owner: hex(32), shop: shopName(id), sidecar: sidecarName(id), marker: `marker-${hex(8)}` });
  }
  await inBatches(instances, 10, async (inst) => {
    await docker(['network', 'create', '--internal', ...LABEL, inst.net]);
    const vm = path.join(TMP, `vm-${inst.i}`); const start = path.join(TMP, `start-${inst.i}`);
    fs.mkdirSync(vm, { mode: 0o755 }); fs.mkdirSync(start, { mode: 0o755 });
    fs.writeFileSync(path.join(vm, 'flags.json'), JSON.stringify({ flags: [{ challenge_key: 'C01', flag: inst.marker }] }));
    fs.writeFileSync(path.join(vm, 'injected'), '');
    fs.writeFileSync(path.join(vm, 'snapshot.db'), '{"products":[]}');
    const digest = createHash('sha256').update(inst.marker).digest('hex');
    fs.writeFileSync(path.join(start, 'start.json'), JSON.stringify({ schema_version: '0.1', instance_id: inst.id, epoch: 1, event_key: inst.i === 0 ? eventKey : hex(32), flag_digests: [{ challenge_key: 'C01', kind: 'real', sha256: digest }] }));
    const hard = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '64', ...LABEL];
    await docker(['run', '-d', '--name', inst.shop, '--network', inst.net, '--network-alias', 'shop', ...hard,
      '--tmpfs', '/data:rw,noexec,nosuid,size=4m,uid=65532,gid=65532', '-v', `${vm}:/run/vm:ro`,
      '-e', 'PORT=3000', '-e', 'VM_FLAGS_PATH=/run/vm/flags.json', '-e', 'VM_SNAPSHOT_PATH=/run/vm/snapshot.db', '-e', 'VM_DB_PATH=/data/shop.db', '-e', 'VM_SIDECAR_EVENTS_URL=http://sidecar:9000',
      STUB_IMAGE, 'shop']);
    await docker(['run', '-d', '--name', inst.sidecar, '--network', inst.net, '--network-alias', 'sidecar', ...hard,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=4m,uid=65532,gid=65532', '-v', `${start}:/run/start:ro`, '--entrypoint', 'sh', STUB_IMAGE,
      '-c', `exec node /app/contracts/mocks/stub-instance/main.mjs sidecar --relay http://${GATE}:8081/internal/v1/events --upstream http://shop:3000 < /run/start/start.json`]);
  });

  // the fake ingest (core network only, alias ingest) accepts the signed events of instance 0
  await docker(['run', '-d', '--name', INGEST, '--network', NET_CORE, '--network-alias', 'ingest', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '64', '--tmpfs', '/tmp', ...LABEL,
    '--entrypoint', 'node', STUB_IMAGE, '/app/contracts/mocks/fake-ingest/server.mjs', '--key', eventKey, '--instance', instances[0].id, '--epoch', '1', '--host', '0.0.0.0', '--port', '8081']);

  // the edge gate, with the flags of compose; edge-public and labs-core legs carry the aliases the listeners bind to
  const vars = { VULNMART_LABS_ZONE: ZONE, VULNMART_EDGE_INGEST_URL: 'http://ingest:8081' };
  const gateSvc = compose.services['edge-gate'];
  await docker(['create', '--name', GATE, '--network', NET_PUB, ...gateSvc.networks['edge-public'].aliases.flatMap((a) => ['--network-alias', a]), ...LABEL,
    ...composeFlags(gateSvc, { vars, mounts: { '/run/secrets/gate_key_current': path.join(secDir, 'gate_key_current'), '/run/secrets/gate_key_previous': path.join(secDir, 'gate_key_previous'), '/run/secrets/gate_admin_secret': path.join(secDir, 'gate_admin_secret'), '/run/secrets/ingest_ca': path.join(secDir, 'ingest_ca.pem') } }), EDGE_IMAGE]);
  await docker(['network', 'connect', ...gateSvc.networks['labs-core'].aliases.flatMap((a) => ['--alias', a]), NET_CORE, GATE]);
  await docker(['start', GATE]);
  for (let i = 0; i < 60; i++) { const l = await run(['logs', GATE]); if (/edge-gate: player/.test(l.stdout)) break; if (i === 59) assert.fail(`the gate did not start: ${l.stdout}${l.stderr}`); await sleep(500); }
  await inBatches(instances, 10, (inst) => docker(['network', 'connect', inst.net, GATE]));

  const caddySvc = compose.services['edge-caddy'];
  await docker(['run', '-d', '--name', CADDY, '--network', NET_PUB, '-p', '127.0.0.1::443', ...LABEL,
    ...composeFlags(caddySvc, { vars, mounts: { '/certs': certDir } }), CADDY_IMAGE]);
  tlsPort = Number((await docker(['port', CADDY, '443/tcp'])).split('\n')[0].split(':').pop());
  clockOffsetS = Number(await docker(['exec', GATE, 'date', '+%s'])) - Math.floor(Date.now() / 1000);
  // wait for Caddy
  for (let i = 0; i < 80; i++) { try { await web('localhost'); break; } catch { if (i === 79) assert.fail('caddy did not come up'); await sleep(250); } }
  // the orchestrator's job in story 3, done here by hand: push the full list
  const sync = await adminCall('PUT', '/internal/v1/gate/sync', { instances: instances.map((x) => record(x)) });
  assert.equal(sync.status, 204, sync.text ?? sync.error);
});

after(async () => {
  const left = { containers: [], networks: [] };
  try {
    const ids = (await run(['ps', '-aq', '--filter', `label=vm.run=${RUN}`])).stdout.split('\n').filter(Boolean);
    if (ids.length) await run(['rm', '-f', ...ids]);
    const nets = (await run(['network', 'ls', '-q', '--filter', `label=vm.run=${RUN}`])).stdout.split('\n').filter(Boolean);
    for (const n of nets) await run(['network', 'rm', n]);
    left.containers = (await run(['ps', '-aq', '--filter', 'label=vm.kind=edge-test'])).stdout.split('\n').filter(Boolean);
    left.networks = (await run(['network', 'ls', '-q', '--filter', 'label=vm.kind=edge-test'])).stdout.split('\n').filter(Boolean);
  } catch { /* the check below reports it */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  if (!SKIP) {
    console.log(`cleanup: containers left ${left.containers.length}, networks left ${left.networks.length}, temp folder present ${fs.existsSync(TMP)}`);
    assert.deepEqual(left, { containers: [], networks: [] }, 'the test left something behind');
    assert.equal(fs.existsSync(TMP), false);
  }
});

// ------------------------------------------------------------------ the matrix
test('production shape: the edge runs with the hardening of compose; only Caddy has a published port, and it is 443 on loopback', { skip: SKIP }, async (t) => {
  const gate = await inspect(GATE);
  const caddy = await inspect(CADDY);
  for (const c of [gate, caddy]) {
    assert.equal(c.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
    assert.ok(c.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.ok(c.HostConfig.Memory > 0 && c.HostConfig.PidsLimit > 0, 'memory and pid limits are set');
    assert.equal(c.HostConfig.Privileged, false);
  }
  assert.equal(gate.Config.User, '65532:65532');
  assert.deepEqual(gate.HostConfig.CapAdd ?? [], []);
  assert.deepEqual((caddy.HostConfig.CapAdd ?? []).map((x) => x.replace(/^CAP_/, '')), ['NET_BIND_SERVICE']);
  assert.deepEqual(Object.keys(gate.HostConfig.PortBindings ?? {}), [], 'the gate publishes nothing');
  assert.deepEqual(Object.keys(caddy.HostConfig.PortBindings ?? {}), ['443/tcp']);
  assert.equal(caddy.HostConfig.PortBindings['443/tcp'][0].HostIp, '127.0.0.1');
  assert.ok(!gate.HostConfig.Binds?.some((b) => /docker\.sock/.test(b)), 'no Docker socket in the gate');
  const gateNets = Object.keys(gate.NetworkSettings.Networks);
  t.diagnostic(`edge-gate is attached to ${gateNets.length} networks (edge-public, labs-core and ${gateNets.length - 2} instance networks)`);
  assert.equal(gateNets.length, N + 2);
  const r = await web('localhost');
  assert.equal(r.status, 404, 'TLS works and an unknown host gets the fixed 404');
});

test(`owner path on ${N} internal networks: each hostname reaches its own instance (unique marker per instance), nothing else`, { skip: SKIP }, async (t) => {
  const seen = new Map();
  await inBatches(instances, 10, async (inst) => {
    const { res, cookie } = await enter(inst);
    assert.equal(res.status, 302, `enter ${inst.i}`);
    assert.equal(res.headers.location, '/');
    assert.match([].concat(res.headers['set-cookie'])[0], /^__Host-vm_gate=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    inst.cookie = cookie;
    let page;
    for (let k = 0; k < 80; k++) { // the stub shop is up a moment after the container
      page = await web(hostOf(inst.id), '/_stub/planted-flag?key=C01', { cookie });
      if (page.status === 200) break;
      await sleep(500);
    }
    assert.equal(page.status, 200, `instance ${inst.i}: ${page.text.slice(0, 120)}`);
    const body = JSON.parse(page.text);
    assert.equal(body.flag, inst.marker, `instance ${inst.i} answered with the marker of another instance`);
    seen.set(inst.id, body.flag);
  });
  assert.equal(new Set(seen.values()).size, N, 'every marker is unique');
  t.diagnostic(`${N} instances on ${N} separate --internal networks, ${N} hostnames, ${N} distinct markers reached through Caddy and the gate`);
  // a cookie for one host does nothing on the next host
  const a = instances[0]; const b = instances[N - 1];
  assert.equal((await web(hostOf(b.id), '/_stub/planted-flag?key=C01', { cookie: a.cookie })).status, 403);
});

test('second account, forged owner, edited hostname: refused with the gate page, the other instance is not touched', { skip: SKIP }, async () => {
  const a = instances[0]; const b = instances[1];
  const hitsB = await shopHits(b);
  const hitsA = await shopHits(a);
  const gateBefore = await gateHits();
  // another owner's ticket for A's host
  const other = await web(hostOf(a.id), `/_vm/enter?t=${ticketFor(a, hex(32))}`);
  assert.equal(other.status, 403);
  assert.match(other.text, /This link is not valid/);
  // a valid cookie, signed for A but with another owner hash
  const forged = signCookie(keys, { inst: a.id, own: hex(32), ae: 1 });
  spent.push(forged);
  assert.equal((await web(hostOf(a.id), '/_stub/planted-flag?key=C01', { cookie: `__Host-vm_gate=${forged}` })).status, 403);
  // no cookie at all
  assert.equal((await web(hostOf(a.id), '/_stub/planted-flag?key=C01')).status, 403);
  // the cookie of A sent to the host of B
  const edited = await web(hostOf(b.id), '/_stub/planted-flag?key=C01', { cookie: a.cookie });
  assert.equal(edited.status, 403);
  assert.match(edited.text, /This link is not valid/);
  // a ticket of B replayed on its own host: first use works, second does not
  const t = ticketFor(b, b.owner);
  assert.equal((await web(hostOf(b.id), `/_vm/enter?t=${t}`)).status, 302);
  assert.equal((await web(hostOf(b.id), `/_vm/enter?t=${t}`)).status, 403);
  await sleep(400);
  assert.equal(await shopHits(a), hitsA, 'the shop of A was not touched by the refused requests');
  assert.equal(await shopHits(b), hitsB, 'the shop of B was not touched');
  assert.ok((await gateHits()) > gateBefore, 'the gate answered them (it was reached)');
});

test('foreign Host or IP: Caddy answers 404 and the gate is not reached; a well-formed unknown instance reaches the gate and gets 410', { skip: SKIP }, async () => {
  const a = instances[0];
  const before = await gateHits();
  for (const h of ['localhost', '127.0.0.1', '10.255.255.254', `i-${'a'.repeat(16)}.other.test`, `${a.id.toLowerCase()}.other.test`, `${a.id}.${ZONE}`, hostOf(a.id).toUpperCase(),
    `i-${'a'.repeat(15)}.${ZONE}`, `i-${'a'.repeat(17)}.${ZONE}`, `x.${hostOf(a.id)}`, ZONE, `i-${'a'.repeat(16)}.${ZONE}:8443`, `i-${'1'.repeat(16)}.${ZONE}`]) {
    const r = await web(h, '/', { cookie: a.cookie });
    assert.equal(r.status, 404, `Host ${h}`);
    assert.equal(r.text, '', `Host ${h}: the 404 of Caddy has no body`);
  }
  await sleep(300);
  assert.equal(await gateHits(), before, 'the gate saw none of them');
  const unknown = await web(`i-${'a'.repeat(16)}.${ZONE}`, '/', { cookie: a.cookie });
  assert.equal(unknown.status, 410);
  assert.match(unknown.text, /This lab has ended/);
  assert.ok((await gateHits()) > before);
});

test('Caddy adds no security header to the answers (D-62); the gate sets only its own page headers', { skip: SKIP }, async () => {
  const a = instances[0];
  const page = await web(hostOf(a.id), '/_stub/planted-flag?key=C01', { cookie: a.cookie });
  const refused = await web(hostOf(a.id), '/');
  for (const r of [page, refused, await web('localhost')]) {
    for (const h of ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'permissions-policy', 'cross-origin-opener-policy']) {
      assert.equal(r.headers[h], undefined, `${h} must not be set`);
    }
  }
  assert.equal(page.status, 200);
});

test('frozen then closed: 423 then 410 at once, the shop sees no request; unknown admin calls are refused', { skip: SKIP }, async () => {
  const c = instances[N - 1];
  const ok = await enter(c);
  const cookie = ok.cookie;
  assert.equal((await web(hostOf(c.id), '/_stub/planted-flag?key=C01', { cookie })).status, 200);
  assert.equal((await adminCall('PUT', `/internal/v1/gate/instances/${c.id}`, record(c), { secret: null })).status, 401, 'no admin secret');
  assert.equal((await adminCall('PUT', `/internal/v1/gate/instances/${c.id}`, record(c), { secret: 'wrong-secret-of-16+chars' })).status, 401, 'wrong admin secret');
  const hits = await shopHits(c);
  assert.equal((await adminCall('PUT', `/internal/v1/gate/instances/${c.id}`, record(c, { access: 'frozen', access_epoch: 2 }))).status, 204);
  const frozen = await web(hostOf(c.id), '/_stub/planted-flag?key=C01', { cookie });
  assert.equal(frozen.status, 423);
  assert.match(frozen.text, /This lab is paused/);
  assert.equal((await adminCall('PUT', `/internal/v1/gate/instances/${c.id}`, record(c, { access: 'closed', access_epoch: 3 }))).status, 204);
  const closed = await web(hostOf(c.id), '/_stub/planted-flag?key=C01', { cookie });
  assert.equal(closed.status, 410);
  assert.match(closed.text, /This lab has ended/);
  assert.equal((await adminCall('PUT', `/internal/v1/gate/instances/${c.id}`, record(c, { access_epoch: 1 }))).status, 409, 'an older access epoch is refused');
  await sleep(400);
  assert.equal(await shopHits(c), hits, 'the shop of the frozen and closed instance saw nothing after the first request');
});

test('relay good: one signed event of the stub sidecar goes through the relay and the fake ingest stores it (the signature covers the exact bytes)', { skip: SKIP }, async () => {
  const a = instances[0];
  const before = (await ingestEvents()).length;
  const emit = await web(hostOf(a.id), '/_stub/emit', { cookie: a.cookie, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'valid' }) });
  assert.equal(emit.status, 200, emit.text);
  assert.equal(JSON.parse(emit.text).sidecar_status, 202);
  let events = [];
  for (let i = 0; i < 60; i++) { events = await ingestEvents(); if (events.length > before) break; await sleep(500); }
  assert.equal(events.length, before + 1, 'the ingest stored the event');
  assert.deepEqual(events.at(-1), { instance_id: a.id, epoch: 1, seq: 1, type: 'shop.catalog_query_error' });
  assert.ok(await logLines(INGEST, /^202 /) >= 1, 'the fake ingest answered 202');
});

test('relay bad: wrong path, GET, two events, 16 KiB + 1, wrong content type, no signature, not JSON: refused by the relay, the ingest never sees them', { skip: SKIP }, async (t) => {
  const a = instances[0];
  const sig = `v1=${'c'.repeat(64)}`;
  const json = { 'content-type': 'application/json', 'x-vm-signature': sig };
  const event = '{"schema_version":"0.1","type":"shop.catalog_query_error"}';
  const b64 = (s) => Buffer.from(s).toString('base64');
  const cases = [
    ['wrong path', { path: '/_fake/events', method: 'GET', headers: json }, 404, 'REQ-ROUTE-UNKNOWN'],
    ['wrong path (POST)', { path: '/internal/v1/events/extra', method: 'POST', headers: json, bodyB64: b64(event) }, 404, 'REQ-ROUTE-UNKNOWN'],
    ['GET', { path: '/internal/v1/events', method: 'GET', headers: json }, 405, 'REQ-METHOD-NOT-ALLOWED'],
    ['two events in an array', { path: '/internal/v1/events', method: 'POST', headers: json, bodyB64: b64(`[${event},${event}]`) }, 422, 'EVT-SCHEMA'],
    ['body over 16 KiB', { path: '/internal/v1/events', method: 'POST', headers: json, bodyB64: b64(JSON.stringify({ pad: 'x'.repeat(16384) })) }, 413, 'EVT-TOO-LARGE'],
    ['wrong content type', { path: '/internal/v1/events', method: 'POST', headers: { 'content-type': 'text/plain', 'x-vm-signature': sig }, bodyB64: b64(event) }, 415, 'REQ-UNSUPPORTED-MEDIA-TYPE'],
    ['no signature header', { path: '/internal/v1/events', method: 'POST', headers: { 'content-type': 'application/json' }, bodyB64: b64(event) }, 401, 'EVT-BAD-SIGNATURE'],
    ['not JSON', { path: '/internal/v1/events', method: 'POST', headers: json, bodyB64: b64('{"a":') }, 422, 'EVT-SCHEMA'],
  ];
  const eventsBefore = (await ingestEvents()).length;
  const logBefore = await logLines(INGEST, /^\d{3} /);
  const out = await probe(a.shop, cases.map(([, c]) => ({ kind: 'http', host: GATE, port: 8081, ...c, timeoutMs: 5000 })));
  cases.forEach(([name, , status, code], k) => {
    assert.equal(out[k].status, status, `${name}: ${JSON.stringify(out[k]).slice(0, 200)}`);
    const body = JSON.parse(out[k].text);
    assert.equal(body.code, code, name);
    assert.equal(body.type, `urn:vulnmart:error:${code}`, name);
    assert.equal(body.status, status, name);
    assert.ok(typeof body.request_id === 'string' && body.request_id.length >= 8, name);
  });
  await sleep(400);
  assert.equal((await ingestEvents()).length, eventsBefore, 'the ingest stored nothing new');
  assert.equal(await logLines(INGEST, /^\d{3} /), logBefore, 'the ingest logged no request');
  t.diagnostic(`${cases.length} refused relay requests: ${out.map((o) => o.status).join(', ')}`);
});

test('an instance cannot reach the edge\'s other legs, other networks or other instances (recorded as results)', { skip: SKIP }, async (t) => {
  const a = instances[0]; const b = instances[1];
  const gate = await inspect(GATE);
  const ipOn = (net) => gate.NetworkSettings.Networks[net].IPAddress;
  const ipB = ipOn(b.net); const ipCore = ipOn(NET_CORE); const ipPub = ipOn(NET_PUB);
  const sidecarB = (await inspect(b.sidecar)).NetworkSettings.Networks[b.net].IPAddress;
  const own = ipOn(a.net);
  const specs = [
    ['own leg 8081 (the relay, by design)', { kind: 'tcp', host: GATE, port: 8081 }, 'connected'],
    ['own leg 8081 by IP', { kind: 'tcp', host: own, port: 8081 }, 'connected'],
    ['own leg 8080 (player listener)', { kind: 'tcp', host: own, port: 8080 }, 'ECONNREFUSED'],
    ['own leg 9090 (admin listener)', { kind: 'tcp', host: own, port: 9090 }, 'ECONNREFUSED'],
    ['own leg by name 9090', { kind: 'tcp', host: GATE, port: 9090 }, 'ECONNREFUSED'],
    ['edge IP on the labs-core network 9090', { kind: 'tcp', host: ipCore, port: 9090, timeoutMs: 2500 }, 'blocked'],
    ['edge IP on the labs-core network 8081', { kind: 'tcp', host: ipCore, port: 8081, timeoutMs: 2500 }, 'blocked'],
    ['edge IP on the edge-public network 8080', { kind: 'tcp', host: ipPub, port: 8080, timeoutMs: 2500 }, 'blocked'],
    ['edge IP on the network of instance 1, 8081', { kind: 'tcp', host: ipB, port: 8081, timeoutMs: 2500 }, 'blocked'],
    ['edge IP on the network of instance 1, 9090', { kind: 'tcp', host: ipB, port: 9090, timeoutMs: 2500 }, 'blocked'],
    ['the sidecar of instance 1 by IP, 8080', { kind: 'tcp', host: sidecarB, port: 8080, timeoutMs: 2500 }, 'blocked'],
    ['the sidecar of instance 1 by name', { kind: 'dns', host: b.sidecar }, 'unresolved'],
    ['the alias edge-gate of the Caddy network', { kind: 'dns', host: 'edge-gate' }, 'unresolved'],
    ['the alias edge-gate-admin', { kind: 'dns', host: 'edge-gate-admin' }, 'unresolved'],
    ['the ingest alias', { kind: 'dns', host: 'ingest' }, 'unresolved'],
    ['Caddy by name', { kind: 'dns', host: CADDY }, 'unresolved'],
  ];
  const out = await probe(a.shop, specs.map(([, s]) => s));
  const report = [];
  specs.forEach(([name, , want], k) => {
    const got = out[k].result;
    report.push(`${name}: ${got}`);
    if (want === 'blocked') assert.notEqual(got, 'connected', name);
    else if (want === 'unresolved') assert.notEqual(got, 'resolved', name);
    else assert.equal(got, want, name);
  });
  t.diagnostic(report.join(' | '));
  // from the Caddy network: the gate answers on 8080, not on 9090
  const nc = async (host, port) => (await run(['exec', CADDY, 'nc', '-z', '-w', '2', host, String(port)])).status;
  assert.equal(await nc('edge-gate', 8080), 0, 'Caddy reaches the player listener');
  assert.notEqual(await nc('edge-gate', 9090), 0, 'Caddy cannot reach the admin listener');
  // on the gate itself the admin listener is not on loopback either
  const [lo] = await probe(GATE, [{ kind: 'tcp', host: '127.0.0.1', port: 9090 }]);
  assert.equal(lo.result, 'ECONNREFUSED');
});

test('no instance container publishes a host port (inspect shows none); the edge is the only one with a binding', { skip: SKIP }, async (t) => {
  const names = (await docker(['ps', '-a', '--filter', `label=vm.run=${RUN}`, '--format', '{{.Names}}'])).split('\n').filter(Boolean);
  let instanceContainers = 0;
  for (const name of names) {
    const c = await inspect(name);
    const bound = Object.entries(c.NetworkSettings.Ports ?? {}).filter(([, v]) => v && v.length);
    const configured = Object.keys(c.HostConfig.PortBindings ?? {});
    if (name === CADDY) { assert.deepEqual(configured, ['443/tcp']); continue; }
    assert.deepEqual(bound, [], `${name} has a published port`);
    assert.deepEqual(configured, [], `${name} asks for a port binding`);
    if (/^vm-i-/.test(name)) instanceContainers += 1;
  }
  assert.equal(instanceContainers, 2 * N);
  t.diagnostic(`${names.length} containers checked (${instanceContainers} instance containers, the gate, the ingest, Caddy): only Caddy 443/tcp is bound`);
  const published = (await docker(['port', CADDY])).split('\n').filter(Boolean);
  assert.equal(published.length, 1);
  assert.match(published[0], /^443\/tcp -> 127\.0\.0\.1:\d+$/);
});

test('logs: neither a ticket, a cookie value nor an admin secret appears in the Caddy or gate log; the ticket query is redacted', { skip: SKIP }, async () => {
  const caddy = await run(['logs', CADDY]);
  const gate = await run(['logs', GATE]);
  const text = `${caddy.stdout}${caddy.stderr}`;
  const gtext = `${gate.stdout}${gate.stderr}`;
  assert.ok(spent.length > N, 'the test used tickets and cookies');
  for (const s of spent) {
    assert.ok(!text.includes(s), 'a ticket or cookie value is in the Caddy log');
    assert.ok(!gtext.includes(s), 'a ticket or cookie value is in the gate log');
  }
  for (const log of [text, gtext]) {
    assert.ok(!log.includes(adminSecret) && !log.includes(keys.current.toString('hex')) && !log.includes(eventKey));
  }
  assert.match(text, /_vm\/enter\?t=REDACTED/, 'the access log has the enter request with the ticket redacted');
  assert.ok(!/__Host-vm_gate=/.test(text), 'no cookie in the Caddy log');
});
