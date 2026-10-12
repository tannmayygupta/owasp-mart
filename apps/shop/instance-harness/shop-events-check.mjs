// Shop boundaries + signed app events (T-10, FR-SHP-14). Proves, end to end in
// Docker with the REAL shop and the REAL sidecar + fake ingest:
//   - the shop posts an unsigned event to the sidecar; the sidecar stamps
//     (instance_id, epoch, seq) and signs; the FAKE INGEST accepts and stores it;
//   - the shop's only reachable peer is the sidecar: it has no route to a
//     "platform" service on another network, and no egress to the internet.
//
// The shop posts through its own code (src/instance/instance.mjs postEvent), run
// in-container, so this exercises the real emit path. Secrets (the event key and
// the fake flags) reach the sidecar/ingest on standard input only, never a
// command line, env or `docker inspect`. Needs Docker.
// Run: node apps/shop/instance-harness/shop-events-check.mjs
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshValues, sidecarStartDocument } from '../../../contracts/mocks/stub-instance/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SHOP_IMAGE = process.env.VM_SHOP_IMAGE ?? 'vulnmart-shop:local';
const STUB_IMAGE = process.env.VM_STUB_IMAGE ?? 'vulnmart-stub-instance:local';
const INST = 'vm-t10-inst';
const PLAT = 'vm-t10-plat-net';
const SHOP = 'vm-t10-shop';
const SIDE = 'vm-t10-sidecar';
const INGEST = 'vm-t10-ingest';
const DECOY = 'vm-t10-platform';
const PROBER = 'vm-t10-plat-probe';

const values = freshValues();
const secrets = [values.seed, values.event_key, ...values.flags.map((f) => f.flag)];
const scrub = (s) => { let o = String(s); for (const x of secrets) if (x) o = o.split(x).join('<redacted>'); return o; };

const results = [];
const add = (rule, ok, detail = '') => results.push({ rule, ok, detail: ok ? '' : scrub(detail) });
const skipped = [];
const skip = (rule, reason) => { skipped.push(rule); console.log(`SKIP ${rule} -- ${scrub(reason)}`); };
const children = [];

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// The shop image is distroless (node at /nodejs/bin/node); the stub image
// (ingest/sidecar) is a regular node image (node on PATH).
const execNode = (name, code, bin = '/nodejs/bin/node') => docker(['exec', name, bin, '-e', code]);
const execStub = (name, code) => execNode(name, code, 'node');
// Reachability via an explicit stdout sentinel, so a failed exec (ERROR) is not
// mistaken for "blocked" (the boundary checks must fail closed, not open).
function probe(name, url, bin = '/nodejs/bin/node') {
  const r = execNode(name, `fetch('${url}',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('REACHED')).catch(()=>console.log('BLOCKED'))`, bin);
  const out = r.stdout.trim();
  return out === 'REACHED' || out === 'BLOCKED' ? out : 'ERROR';
}
// Run the shop image as an instance container (hardened, no marker => /healthz 200).
function runShopInstance(name, net, extraEnv = []) {
  return docker(['run', '-d', '--name', name, '--network', net,
    '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--tmpfs', '/data:rw,nosuid,size=64m,uid=65532,gid=65532',
    '--tmpfs', '/run/vm:rw,nosuid,size=16m,uid=65532,gid=65532,mode=0750',
    '-e', 'PORT=3000', '-e', 'VM_DB_PATH=/data/shop.db', '-e', 'VM_SNAPSHOT_PATH=/run/vm/snapshot.db', '-e', 'VM_FLAGS_PATH=/run/vm/flags.json',
    ...extraEnv, SHOP_IMAGE]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 40, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(delayMs); }
  return false;
}
const containerStatus = (name) => docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name]).stdout.trim();
// Wait until a container is running; throw with its (scrubbed) logs if it exits
// early (e.g. a stdin-fed service that got a bad start document).
async function requireRunning(name) {
  const dead = () => { const s = containerStatus(name); return s === '' || s.startsWith('exited') || s.startsWith('dead'); };
  await waitFor(() => containerStatus(name).startsWith('running') || dead(), { tries: 60 });
  if (!containerStatus(name).startsWith('running')) {
    const log = docker(['logs', name]);
    const tail = scrub((log.stderr + log.stdout).trim()).split('\n').slice(-6).join('\n');
    throw new Error(`${name} is "${containerStatus(name) || 'missing'}":\n${tail}`);
  }
}

function ensureImage(image, buildArgs) {
  if (docker(['image', 'inspect', image]).status === 0) return;
  console.log(`building ${image} ...`);
  if (docker(['build', '-t', image, ...buildArgs], { timeout: 600000 }).status !== 0) throw new Error(`could not build ${image}`);
}

// Create a container and feed it a start document on stdin (kept running). `-i`
// (OpenStdin) is required so `docker start -i` actually delivers the document;
// without it the service reads EOF and rejects an empty start document.
function feed(name, netArgs, cmdArgs, startDoc) {
  const c = docker(['create', '-i', '--name', name, ...netArgs, STUB_IMAGE, ...cmdArgs]);
  if (c.status !== 0) throw new Error(`create ${name}: ${c.stderr}`);
  // Ignore the child's stdout/stderr (so a chatty service can't fill the pipe and
  // block); the container's logs are read separately via `docker logs`.
  const child = spawn('docker', ['start', '-a', '-i', name], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(startDoc));
  children.push(child);
}

function cleanup() {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  for (const n of [SHOP, SIDE, INGEST, DECOY, PROBER]) docker(['rm', '-f', n]);
  for (const n of [INST, PLAT]) docker(['network', 'rm', n]);
}

async function main() {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('Docker is not available.'); process.exit(2); }
  ensureImage(STUB_IMAGE, ['-f', path.join('contracts', 'mocks', 'stub-instance', 'Dockerfile'), '.']);
  ensureImage(SHOP_IMAGE, [path.join('apps', 'shop')]);
  cleanup();

  const start = sidecarStartDocument(values); // instance_id, epoch, event_key, flag_digests
  try {
    if (docker(['network', 'create', '--internal', INST]).status !== 0) throw new Error('could not create the internal network');
    if (docker(['network', 'create', PLAT]).status !== 0) throw new Error('could not create the platform network');

    // Ingest and sidecar get the test key on stdin only. Sidecar relays straight
    // to the ingest's /internal/v1/events (the edge is a pass-through we omit here).
    feed(INGEST, ['--network', INST], ['ingest'], start);
    feed(SIDE, ['--network', INST], ['sidecar', '--relay', `http://${INGEST}:8081/internal/v1/events`, '--upstream', `http://${SHOP}:3000`], start);

    // The real shop, instance runtime profile, pointed at the sidecar's events port.
    const run = runShopInstance(SHOP, INST, ['-e', `VM_SIDECAR_EVENTS_URL=http://${SIDE}:9000`]);
    if (run.status !== 0) throw new Error(`could not start the shop:\n${run.stderr}`);

    // A decoy "platform" service and a prober on a SEPARATE network. Both run the
    // shop image in instance mode so they actually serve /healthz (a bare image
    // run would crash — the seed code is not in the instance image — and a dead
    // decoy would make "unreachable" meaningless). The prober is the positive
    // control: it must reach the decoy, so the shop's failure means isolation.
    docker(['run', '-d', '--name', DECOY, '--network', PLAT, '--user', '65532:65532', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--tmpfs', '/data:rw,nosuid,size=64m,uid=65532,gid=65532',
      '--tmpfs', '/run/vm:rw,nosuid,size=16m,uid=65532,gid=65532,mode=0750',
      '-e', 'PORT=3000', '-e', 'VM_DB_PATH=/data/shop.db', '-e', 'VM_SNAPSHOT_PATH=/run/vm/snapshot.db', '-e', 'VM_FLAGS_PATH=/run/vm/flags.json',
      SHOP_IMAGE]);
    runShopInstance(PROBER, PLAT);

    // Every service container must be running (fail fast with logs if a stdin-fed
    // service exited on a bad start document).
    for (const name of [INGEST, SIDE, SHOP, DECOY, PROBER]) await requireRunning(name);

    // Wait for the shop process and the sidecar events port to be up.
    const shopUp = await waitFor(() => execNode(SHOP, "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))").status === 0);
    add('live-shop-up', shopUp, 'the shop did not answer /healthz');
    const sideUp = await waitFor(() => execNode(SHOP, `fetch('http://${SIDE}:9000/v1/events',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>process.exit(0)).catch(()=>process.exit(1))`).status === 0);
    add('live-sidecar-reachable', sideUp, 'the shop could not reach the sidecar events port');
    // Wait for the ingest too, so the sidecar's first relay attempt succeeds
    // rather than backing off past the delivery window.
    const ingestUp = await waitFor(() => execStub(INGEST, "fetch('http://127.0.0.1:8081/_fake/events').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))").status === 0, { tries: 120 });
    add('live-ingest-up', ingestUp, 'the fake ingest did not answer /_fake/events in time');

    // Post ONE event through the shop's own code; expect the sidecar to accept (202).
    const emit = execNode(SHOP, "import('/app/src/instance/instance.mjs').then(m=>m.postEvent(process.env.VM_SIDECAR_EVENTS_URL, m.shopEvent('shop.catalog_query_error',{route:'/api/products/search',error_class:'sql_syntax'},{user_id:'u-1001'}))).then(s=>console.log(s))");
    const sidecarStatus = Number(emit.stdout.trim());
    add('live-sidecar-accepts-event', sidecarStatus === 202, `the sidecar answered ${sidecarStatus || emit.stderr.trim()} (want 202)`);

    // The fake ingest must receive and store the shop's event, signed, with identity.
    let stored = [];
    const reached = await waitFor(() => {
      const r = execStub(INGEST, "fetch('http://127.0.0.1:8081/_fake/events').then(r=>r.text()).then(t=>console.log(t)).catch(()=>console.log('[]'))");
      try { stored = JSON.parse(r.stdout.trim()); } catch { stored = []; }
      return stored.length > 0;
    }, { tries: 120, delayMs: 500 });
    const ok = reached && stored.length === 1 && stored[0].instance_id === values.instance_id
      && stored[0].epoch === values.epoch && stored[0].seq === 1 && stored[0].type === 'shop.catalog_query_error';
    add('live-fake-ingest-accepts-shop-event', ok, `ingest holds ${JSON.stringify(stored)}`);

    // Negative control: the ingest MUST reject an event with no valid signature, so
    // a STORED event proves the sidecar really signed it (not that the ingest takes
    // anything). Post a wire-shaped body (so the id/epoch/seq checks pass) with no
    // X-VM-Signature header, straight to the ingest; expect 401.
    const wire = JSON.stringify({ schema_version: '0.1', instance_id: values.instance_id, epoch: values.epoch, seq: 1000, type: 'shop.catalog_query_error', source: 'shop', session_kind: 'player', user_id: 'u-1', ts: '2026-01-01T00:00:00Z', data: { route: '/x', error_class: 'sql_syntax' } });
    const unsigned = execNode(SHOP, `fetch('http://${INGEST}:8081/internal/v1/events',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(wire)}}).then(r=>console.log(r.status)).catch(()=>console.log(0))`);
    add('live-ingest-rejects-unsigned', Number(unsigned.stdout.trim()) === 401, `ingest answered ${unsigned.stdout.trim() || '<none>'} to an unsigned event (want 401)`);

    // Boundary: no route to the platform decoy on another network. Positive control
    // first (the prober on that network reaches the decoy), then the shop must NOT —
    // by IP and by name. A missing IP or an unreachable decoy fails (not vacuously passes).
    const decoyIp = docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${PLAT}").IPAddress}}`, DECOY]).stdout.trim();
    const decoyUp = !!decoyIp && await waitFor(() => probe(PROBER, `http://${decoyIp}:3000/healthz`) === 'REACHED', { tries: 40 });
    if (!decoyUp) {
      add('live-no-route-to-platform', false, `cannot run the boundary test (decoy ip="${decoyIp}", reachable-from-sibling=${decoyUp})`);
    } else {
      const byIp = probe(SHOP, `http://${decoyIp}:3000/healthz`);
      const byName = probe(SHOP, `http://${DECOY}:3000/healthz`);
      add('live-no-route-to-platform', byIp === 'BLOCKED' && byName === 'BLOCKED', `the shop reached a service on another network (byIp=${byIp}, byName=${byName})`);
    }

    // Boundary: no internet egress. Positive control: a sibling on the default
    // bridge must reach out; if the host itself has no egress, this is SKIPPED
    // (surfaced), never a false pass. The shop's probe must be BLOCKED (fail closed).
    const hostHasEgress = docker(['run', '--rm', SHOP_IMAGE, '-e', "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))"]).status === 0;
    if (!hostHasEgress) skip('live-no-egress', 'the host has no egress, so isolation cannot be proven this run');
    else add('live-no-egress', probe(SHOP, 'http://1.1.1.1') === 'BLOCKED', 'the shop reached the internet (egress not blocked)');

    // No flag or key in the ingest read-out (it must carry only identity + type).
    const dump = JSON.stringify(stored);
    add('live-no-secret-in-ingest-readout', !secrets.some((s) => s && dump.includes(s)), 'a flag or key appeared in the ingest read-out');
  } finally {
    if (!process.argv.includes('--keep')) cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.rule}${r.ok ? '' : ` -- ${r.detail}`}`);
  const skipNote = skipped.length ? `, ${skipped.length} skipped` : '';
  console.log(failed.length === 0 ? `\nshop-events: PASS (${results.length} checks${skipNote})` : `\nshop-events: FAIL (${failed.length}/${results.length}${skipNote})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { try { cleanup(); } catch { /* best effort */ } console.error(scrub(`shop-events harness error: ${e.message}`)); process.exit(1); });
