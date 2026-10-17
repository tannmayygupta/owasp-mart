// Local proof of edge story 6 (H-143 option (a)): the orchestrator runs as a CONTAINER on labs-core, through the real compose file.
//   Run from the repository root: node docs/assets/story-edge-6-orchestrator-container/proof-run.mjs
// What it does (Docker Desktop, throwaway): temporary secrets, certificates, template and image manifest in a temp folder (never in the repository),
// `docker compose --profile lab up` of the orchestrator (which brings edge-gate; the socket proxy `docker-proxy` is reused when it already runs),
// one stub instance created over mutual TLS with a signed request, checks of the edge attach and of the gate state, destroy, then teardown and a
// leftover check. Test-only differences from production, all in a temp override file: --allow-local-images and a relaxed template schema (the stub
// image cannot play every role), and labels so everything it starts can be found. No key, secret or certificate is printed or written to evidence.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { relaxSchema } from '../../../scripts/demo.mjs';
import { ROOT, docker, imageId, loopManifest, loopTemplate, orchSign, pollUntil, redactAll, run, sleep } from '../../../scripts/e2e/loop-support.mjs';

const OUT = path.join(ROOT, 'docs', 'assets', 'story-edge-6-orchestrator-container', 'proof-output.txt');
const RUN = `vmorchc${randomBytes(3).toString('hex')}`;
const KIND = 'orch-container-proof';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-orchc-'));
const ORCH_DIR = path.join(TMP, 'orch');
const EDGE_SEC = path.join(TMP, 'edge-secrets');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'compose', 'compose.yaml');
const OVERRIDE = path.join(TMP, 'override.yaml');
const PROJECT = 'vulnmart';
const GATE = 'vulnmart-edge-gate';
const ORCH = 'vulnmart-orchestrator';
const ZONE = 'labs.invalid';
const KEY = randomBytes(32).toString('hex');
const ADMIN = randomBytes(16).toString('hex');
const GATEKEY = randomBytes(32).toString('hex');
const SECRETS = [KEY, ADMIN, GATEKEY];
const lines = [];
const rows = [];
const log = (s = '') => { const t = redactAll(s, SECRETS); lines.push(t); console.log(t); };
const composeEnv = { ...process.env, VULNMART_ORCH_DIR: ORCH_DIR, VULNMART_EDGE_SECRETS: EDGE_SEC };
const compose = (args, opts = {}) => run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '-f', OVERRIDE, '--profile', 'lab', ...args], { env: composeEnv, cwd: path.join(ROOT, 'infra', 'compose'), timeout: 1200000, ...opts });
const check = (name, ok, detail = '') => { rows.push(ok); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) throw new Error(`step failed: ${name}`); };
const dk = async (args) => { const r = await docker(args); if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${r.stderr.trim().slice(0, 300)}`); return r.stdout.trim(); };

// ---- signed call over mutual TLS (client certificate from the temp folder)
const tls = () => ({ ca: fs.readFileSync(path.join(TMP, 'ca.pem')), cert: fs.readFileSync(path.join(TMP, 'client.pem')), key: fs.readFileSync(path.join(TMP, 'client.key')) });
function call(method, target, bodyObj, { clientCert = true } = {}) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  const nonce = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: 9443, servername: 'localhost', path: target, method, timeout: 30000,
      ...(clientCert ? tls() : { ca: fs.readFileSync(path.join(TMP, 'ca.pem')) }),
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

// The gate answers by state (apps/edge/src/gate.mjs): unknown or closed 410, frozen 423, open without a cookie 403. Asked from a throwaway container on edge-public.
async function gateStatus(id) {
  const js = `require('http').get({host:'edge-gate-player',port:8080,path:'/',headers:{host:'${id.toLowerCase()}.${ZONE}'}},r=>{console.log(r.statusCode);r.resume()}).on('error',e=>{console.log('ERR '+e.code)})`;
  const r = await docker(['run', '--rm', '--network', 'vulnmart-edge-public', '--label', `vm.kind=${KIND}`, '--label', `vm.run=${RUN}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--entrypoint', 'node', 'vulnmart-edge:local', '-e', js]);
  return r.stdout.trim();
}
const attached = async (net) => { const r = await docker(['network', 'inspect', net, '--format', '{{range .Containers}}{{.Name}} {{end}}']); return r.status === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean) : null; };
const vmObjects = async () => ({
  containers: (await docker(['ps', '-a', '--filter', 'name=vm-', '--format', '{{.Names}}'])).stdout.trim(),
  networks: (await docker(['network', 'ls', '--filter', 'name=vm-', '--format', '{{.Name}}'])).stdout.trim(),
  volumes: (await docker(['volume', 'ls', '--filter', 'name=vm-', '--format', '{{.Name}}'])).stdout.trim(),
});

async function teardown(id) {
  log('--- teardown');
  if (id) {
    const cs = (await docker(['ps', '-aq', '--filter', `label=vm.instance=${id}`])).stdout.split('\n').filter(Boolean);
    if (cs.length) await docker(['rm', '-f', '-v', ...cs]);
    for (const n of (await docker(['network', 'ls', '-q', '--filter', `label=vm.instance=${id}`])).stdout.split('\n').filter(Boolean)) await docker(['network', 'rm', n]);
    for (const v of (await docker(['volume', 'ls', '-q', '--filter', `label=vm.instance=${id}`])).stdout.split('\n').filter(Boolean)) await docker(['volume', 'rm', '-f', v]);
  }
  const rm = await compose(['rm', '-sf', '-v', 'orchestrator', 'edge-gate']);
  log(`compose rm orchestrator edge-gate: exit ${rm.status}`);
  await docker(['volume', 'rm', '-f', `${PROJECT}_orch-state`, `${RUN}-secrets`]);
  await docker(['network', 'rm', 'vulnmart-edge-public']);
  const stray = (await docker(['ps', '-aq', '--filter', `label=vm.run=${RUN}`])).stdout.split('\n').filter(Boolean);
  if (stray.length) await docker(['rm', '-f', '-v', ...stray]);
  fs.rmSync(TMP, { recursive: true, force: true });
}

let iid = null;
let pre = null;
try {
  log(`VulnMart edge story 6: the orchestrator as a container on labs-core (run ${RUN})`);
  log(`Date: ${new Date().toLocaleDateString('en-CA')}; machine: laptop with Docker Desktop (${(await docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim()})`);
  log('');
  log('--- before: objects of the project already on the machine (not started by this run)');
  log((await docker(['ps', '-a', '--format', '{{.Names}} {{.Status}}', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.trim() || '(none)');
  log(`networks: ${(await docker(['network', 'ls', '--format', '{{.Name}}', '--filter', 'name=vulnmart'])).stdout.trim().replace(/\r?\n/g, ', ') || '(none)'}`);
  log(`volumes: ${(await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=vulnmart'])).stdout.trim().replace(/\r?\n/g, ', ') || '(none)'}`);
  pre = await vmObjects();
  check('no vm-* container or network before the run (a volume vm-gomod of another project may exist and is left alone)', !pre.containers && !pre.networks, `volumes already there: '${pre.volumes}'`);
  const stubId = imageId('vulnmart-stub-instance:local');
  check('the stub instance image is present locally', !!stubId);

  // ---- temporary inputs
  for (const d of [path.join(ORCH_DIR, 'secrets'), path.join(ORCH_DIR, 'templates'), EDGE_SEC]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ORCH_DIR, 'secrets', 'platform_key'), `${KEY}\n`);
  fs.writeFileSync(path.join(EDGE_SEC, 'gate_key_current'), `${GATEKEY}\n`);
  fs.writeFileSync(path.join(EDGE_SEC, 'gate_key_previous'), '');
  fs.writeFileSync(path.join(EDGE_SEC, 'gate_admin_secret'), `${ADMIN}\n`);
  const conf = path.join(TMP, 'openssl.cnf'); fs.writeFileSync(conf, '[req]\ndistinguished_name = dn\n[dn]\n');
  const env = { ...process.env, OPENSSL_CONF: conf };
  const ossl = async (...a) => { const r = await run('openssl', a, { cwd: TMP, env }); if (r.status !== 0) throw new Error(`openssl ${a[0]}: ${r.stderr.slice(-200)}`); };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  await ossl('req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=proof CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  for (const [name, usage, san] of [['server', 'serverAuth', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], ['client', 'clientAuth', '']]) {
    await ossl('req', '-new', ...ec, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    fs.writeFileSync(path.join(TMP, `${name}.ext`), `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=${usage}\n${san}\n`);
    await ossl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`);
  }
  fs.copyFileSync(path.join(TMP, 'server.pem'), path.join(ORCH_DIR, 'secrets', 'tls_cert.pem'));
  fs.copyFileSync(path.join(TMP, 'server.key'), path.join(ORCH_DIR, 'secrets', 'tls_key.pem'));
  fs.copyFileSync(path.join(TMP, 'ca.pem'), path.join(ORCH_DIR, 'secrets', 'tls_ca.pem'));
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'examples', 'valid', 'instance-template', 'shop-template.json'), 'utf8'));
  fs.writeFileSync(path.join(ORCH_DIR, 'templates', 'shop-v0.json'), JSON.stringify(loopTemplate(template)));
  fs.writeFileSync(path.join(ORCH_DIR, 'images.json'), JSON.stringify(loopManifest({ stubId, relayUrl: `http://${GATE}:8081/internal/v1/events` })));
  fs.writeFileSync(path.join(TMP, 'template.schema.json'), JSON.stringify(relaxSchema(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'instance-template.schema.json'), 'utf8')))));

  // ---- the secrets volume (see the note in the override below)
  await dk(['volume', 'create', '--label', `vm.kind=${KIND}`, '--label', `vm.run=${RUN}`, `${RUN}-secrets`]);
  const copy = [['orch/secrets/platform_key', 'platform_key'], ['edge-secrets/gate_admin_secret', 'gate_admin_secret'], ['orch/secrets/tls_cert.pem', 'tls_cert'], ['orch/secrets/tls_key.pem', 'tls_key'], ['orch/secrets/tls_ca.pem', 'tls_ca']]
    .map(([from, to]) => `cp /src/${from} /dst/${to}`).join(' && ');
  await dk(['run', '--rm', '--network', 'none', '--label', `vm.kind=${KIND}`, '--label', `vm.run=${RUN}`, '-v', `${TMP}:/src:ro`, '-v', `${RUN}-secrets:/dst`, 'busybox:1.37.0-musl', 'sh', '-c', `${copy} && chown 65532:65532 /dst/* && chmod 400 /dst/*`]);

  // ---- temp override: test-only flags and labels (the committed service is unchanged)
  const doc = yaml.load(fs.readFileSync(COMPOSE_FILE, 'utf8'));
  const labels = { 'vm.kind': KIND, 'vm.run': RUN };
  fs.writeFileSync(OVERRIDE, yaml.dump({
    services: {
      orchestrator: {
        command: [...doc.services.orchestrator.command, '--allow-local-images', '--template-schema', '/etc/vulnmart/template.schema.json', '--rate-per-s', '0'],
        // Docker Desktop shows every bind-mounted file as mode 777 and Compose ignores the mode of a secret, so the service would refuse the key file here.
        // On Linux (vm-i) the host file is owned by 65532 with mode 0400 and is mounted as it is. Here the same files are put into a named volume by a helper
        // container, owner 65532 mode 0400, and mounted at /run/secrets: the same result the service sees on vm-i.
        secrets: '__RESET__',
        volumes: [`${path.join(TMP, 'template.schema.json').replace(/\\/g, '/')}:/etc/vulnmart/template.schema.json:ro`, 'proof-secrets:/run/secrets:ro'],
        labels,
      },
      'edge-gate': { labels },
    },
    networks: { 'edge-public': { labels } },
    volumes: { 'orch-state': { labels }, 'proof-secrets': { external: true, name: `${RUN}-secrets` } },
  }).replace('secrets: __RESET__', 'secrets: !reset []'));
  log('test-only differences from the committed service (temp override outside the repository): --allow-local-images, --template-schema (relaxed, mounted), --rate-per-s 0, labels');

  // ---- up
  const up = await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '300', 'orchestrator']);
  log(`compose up -d --build --wait orchestrator: exit ${up.status}`);
  if (up.status !== 0) { log(redactAll((up.stdout + up.stderr).slice(-1500), SECRETS)); throw new Error('compose up failed'); }
  log(redactAll((await compose(['ps', '-a', '--format', '{{.Name}} {{.Service}} {{.Status}}'])).stdout.trim(), SECRETS));

  // ---- the container as built
  const insp = JSON.parse(await dk(['inspect', ORCH]))[0];
  const hc = insp.HostConfig;
  check('orchestrator container is running and healthy', insp.State.Running && insp.State.Health?.Status === 'healthy', insp.State.Health?.Status);
  check('no Docker socket and no bind of a docker path in its mounts', !insp.Mounts.some((m) => (m.Type === 'bind' && /docker/i.test(m.Source)) || /docker\.sock/.test(m.Destination)), insp.Mounts.map((m) => `${m.Type}:${m.Destination}${m.RW ? ':rw' : ':ro'}`).join(', '));
  check('not privileged, read-only root, cap_drop ALL, no-new-privileges, non-root', !hc.Privileged && hc.ReadonlyRootfs && (hc.CapDrop ?? []).includes('ALL') && (hc.SecurityOpt ?? []).includes('no-new-privileges:true') && insp.Config.User === '65532:65532', `user ${insp.Config.User}, caps added ${JSON.stringify(hc.CapAdd)}, pid mode '${hc.PidMode}'`);
  check('on labs-core only (not host network)', JSON.stringify(Object.keys(insp.NetworkSettings.Networks)) === JSON.stringify(['vulnmart-labs-core']) && hc.NetworkMode !== 'host', Object.keys(insp.NetworkSettings.Networks).join(','));
  const ports = Object.entries(insp.NetworkSettings.Ports ?? {}).map(([k, v]) => `${k}->${(v ?? []).map((b) => `${b.HostIp}:${b.HostPort}`).join('|')}`);
  check('the only published port is 127.0.0.1:9443 -> 8443', ports.length === 1 && ports[0] === '8443/tcp->127.0.0.1:9443', ports.join(' '));
  const sec = await docker(['exec', ORCH, 'sh', '-c', 'for f in /run/secrets/*; do stat -c "%n %a %u:%g" "$f"; done']);
  log(sec.stdout.trim());
  check('secret files are mode 400 owned by 65532 under /run/secrets (names only here)', sec.status === 0 && sec.stdout.trim().split('\n').length === 5 && sec.stdout.trim().split('\n').every((l) => / 400 65532:65532$/.test(l)));
  const cmdline = hc && insp.Config.Cmd ? insp.Config.Cmd.join(' ') : '';
  check('Docker host is the proxy over labs-core, edge flags set, no TLS bypass', cmdline.includes('--docker-host tcp://docker-proxy:2375') && cmdline.includes('--edge-container vulnmart-edge-gate') && cmdline.includes('--gate-url http://edge-gate-admin:9090') && !cmdline.includes('--insecure-no-tls') && !cmdline.includes('--allow-fake-backend'));
  check('docker inspect of the container holds no key or secret (no secret in environment or command)', ![KEY, ADMIN, GATEKEY].some((s) => JSON.stringify(insp).includes(s)));
  const olog = await docker(['logs', ORCH]);
  check('the container log holds no key or secret', ![KEY, ADMIN, GATEKEY].some((s) => (olog.stdout + olog.stderr).includes(s)));
  // the proxy answers the orchestrator by name, but nothing on the host path is needed
  const gp = await docker(['exec', ORCH, 'python', '-c', "import socket;[socket.create_connection((h,p),3).close() for h,p in (('docker-proxy',2375),('edge-gate-admin',9090))];print('reach ok')"]);
  check('from inside the container docker-proxy:2375 and edge-gate-admin:9090 accept a connection', gp.stdout.trim() === 'reach ok', gp.stderr.trim().slice(0, 150));

  // ---- the listener: mutual TLS
  let refused = false;
  try { await call('GET', '/v1/host', undefined, { clientCert: false }); } catch (e) { refused = /ECONNRESET|socket hang up|alert|certificate|handshake/i.test(`${e.code} ${e.message}`); }
  check('without a client certificate the TLS handshake is refused', refused);
  const host = await call('GET', '/v1/host');
  check('with the client certificate and a signed request GET /v1/host answers 200', host.status === 200 && host.json?.kind === 'vm', `host_id ${host.json?.host_id}, instances ${host.json?.instances}`);
  const bad = await call('GET', '/v1/host', undefined);
  check('(repeat) a second signed call is accepted (fresh nonce)', bad.status === 200);

  // ---- one stub instance
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  iid = 'i-' + Array.from(randomBytes(16), (b) => alphabet[b % 32]).join('');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'orchestrator', 'examples', 'valid', 'create.request.json'), 'utf8'));
  const create = await call('POST', '/v1/instances', { ...example, instance_id: iid, hostname: `${iid.toLowerCase()}.${ZONE}`, limits: { ...example.limits, memory_mb: 256 } });
  check('create answers 202', create.status === 202, `state ${create.json?.state}${create.status === 202 ? '' : ' ' + redactAll(create.text, SECRETS).slice(0, 200)}`);
  const ready = await pollUntil(async () => { const r = await call('GET', `/v1/instances/${iid}`); return r.status === 200 && ['ready', 'failed'].includes(r.json.state) ? r.json : null; }, { timeoutMs: 120000, intervalMs: 1000, label: 'the instance to be ready' });
  check('the instance reaches ready', ready.state === 'ready', `state ${ready.state}, error ${ready.error_code}, access ${ready.access}`);
  const net1 = `vm-${iid.toLowerCase()}-e1-net`;
  const onNet = await attached(net1);
  check('the edge gate container is attached to the instance network (docker network inspect)', !!onNet && onNet.includes(GATE), `members: ${(onNet ?? []).map((n) => n.replace(iid.toLowerCase(), '<id>')).join(', ')}`);
  const insp2 = JSON.parse(await dk(['inspect', GATE]))[0];
  check('docker inspect of the edge gate lists the instance network', Object.keys(insp2.NetworkSettings.Networks).includes(net1), `${Object.keys(insp2.NetworkSettings.Networks).length} networks`);
  check('the instance network is internal (no outbound)', (await dk(['network', 'inspect', net1, '--format', '{{.Internal}}'])) === 'true');
  const closed = await gateStatus(iid);
  check('gate has the record closed after create: player request answers 410 (ended page)', closed === '410', `status ${closed}`);
  const open = await call('POST', `/v1/instances/${iid}/access`, { access: 'open', access_epoch: 1 });
  check('POST access open (epoch 1) answers 200', open.status === 200 && open.json?.access === 'open', `access ${open.json?.access}, epoch ${open.json?.access_epoch}`);
  const openStatus = await gateStatus(iid);
  check('gate got the open state: player request without a ticket answers 403 (denied, not 410 ended)', openStatus === '403', `status ${openStatus}`);
  const frozen = await call('POST', `/v1/instances/${iid}/access`, { access: 'frozen', access_epoch: 2 });
  const frozenStatus = await gateStatus(iid);
  check('gate got the frozen state: 423 (paused page)', frozen.status === 200 && frozenStatus === '423', `status ${frozenStatus}`);
  const olog2 = await docker(['logs', ORCH]);
  check('no key or secret in the orchestrator log after the run of the instance', ![KEY, ADMIN, GATEKEY].some((s) => (olog2.stdout + olog2.stderr).includes(s)));

  // ---- destroy
  const des = await call('POST', `/v1/instances/${iid}/destroy`);
  check('destroy answers 200 or 202', [200, 202].includes(des.status), `status ${des.status}`);
  const gone = await pollUntil(async () => { const r = await call('GET', `/v1/instances/${iid}`); return r.status === 404 || r.json?.state === 'destroyed' ? r : null; }, { timeoutMs: 90000, intervalMs: 1000, label: 'the destroy to finish' });
  check('the instance is destroyed', gone.status === 404 || gone.json.state === 'destroyed', `state ${gone.json?.state ?? 'none'}`);
  const after = await vmObjects();
  check('after destroy: no vm-* container or network, volumes as before the run', !after.containers && !after.networks && after.volumes === pre.volumes, `containers '${after.containers}', networks '${after.networks}', volumes '${after.volumes}'`);
  const insp3 = JSON.parse(await dk(['inspect', GATE]))[0];
  check('the edge gate has no instance network any more', !Object.keys(insp3.NetworkSettings.Networks).some((n) => n.startsWith('vm-')), Object.keys(insp3.NetworkSettings.Networks).join(', '));
  const endedStatus = await gateStatus(iid);
  check('gate record removed: 410 again', endedStatus === '410', `status ${endedStatus}`);

  log('');
  log(`Result: all ${rows.length} checks PASS`);
} catch (e) {
  log(`FAILED: ${redactAll(String(e?.message ?? e), SECRETS)}`);
  try { const l = await docker(['logs', '--tail', '400', ORCH]); log('--- orchestrator log tail (request lines left out)'); log(redactAll((l.stdout + l.stderr).split('\n').filter((x) => !x.includes('"event":"request"') && !/Exception ignored|Traceback|File "|super\(\)|self\.fp|ValueError: I\/O/.test(x)).slice(-25).join('\n'), SECRETS)); const pl = await docker(['logs', '--since', '3m', 'vulnmart-docker-proxy']); log('--- proxy log lines with a status of 400 or more, and the create and start calls'); log((pl.stdout + pl.stderr).split('\n').filter((x) => / [45]\d\d \d+ /.test(x) || /POST \/v[\d.]+\/(containers|networks)\/[^ ]*(start|connect|attach)/.test(x)).map((x) => x.replace(/^.*?\] /, '').slice(0, 260)).slice(0, 40).join('\n')); } catch { /* none */ }
  process.exitCode = 1;
} finally {
  await teardown(iid);
  log('--- after teardown: leftovers of this run and of vm-*');
  log(`docker ps -a --filter label=vm.run=${RUN}: ${(await docker(['ps', '-aq', '--filter', `label=vm.run=${RUN}`])).stdout.trim() || '(empty)'}`);
  log(`docker network ls --filter label=vm.run=${RUN}: ${(await docker(['network', 'ls', '-q', '--filter', `label=vm.run=${RUN}`])).stdout.trim() || '(empty)'}`);
  log(`docker volume ls --filter label=vm.run=${RUN}: ${(await docker(['volume', 'ls', '-q', '--filter', `label=vm.run=${RUN}`])).stdout.trim() || '(empty)'}`);
  const vm = await vmObjects();
  log(`vm-* containers '${vm.containers}', networks '${vm.networks}', volumes '${vm.volumes}' (any volume listed here was already there before the run, see the check at the top)`);
  log('docker ps -a (project vulnmart):');
  log((await docker(['ps', '-a', '--format', '{{.Names}} {{.Status}}', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.trim() || '(none)');
  log(`networks named vulnmart*: ${(await docker(['network', 'ls', '--format', '{{.Name}}', '--filter', 'name=vulnmart'])).stdout.trim().replace(/\r?\n/g, ', ') || '(none)'}`);
  log(`volumes named vulnmart*: ${(await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=vulnmart'])).stdout.trim() || '(none)'}`);
  log(`temp folder present: ${fs.existsSync(TMP)}`);
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
}
await sleep(0);
