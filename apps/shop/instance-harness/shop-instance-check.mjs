// Shop instance harness (T-09, FR-SHP-15). Runs the REAL shop image as an
// instance container under the IF-6 runtime profile (section 7) and proves:
//   - the shop is NEVER ready before the injector marker (/readyz 503), and
//     becomes ready only after the marker + the injected snapshot opens (200);
//   - it runs non-root (65532), read-only root, cap-drop ALL, no-new-privileges;
//   - it has no network egress (an internal docker network, no route out).
//
// Tanmay's lab harness (scripts/dev.mjs harness) drives the STUB with its own
// /_stub routes and a JSON snapshot; this harness drives the real shop with a
// real seeded SQLite snapshot (built on the host by T-08's buildSnapshot and
// injected with `docker cp`, since the shop image carries no seed/migrations).
// The sidecar/event chain is T-10; the marketplace-on-snapshot wiring is tracked
// as a follow-up. Needs Docker. Run: node apps/shop/instance-harness/shop-instance-check.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../seed/build-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = process.env.VM_SHOP_IMAGE ?? 'vulnmart-shop:t09';
const NAME = 'vm-t09-shop';
const NET = 'vm-t09-net';
const UID = '65532';

// A fake per-run flag (VM{24 base32}); never a real secret.
const FLAGS = {
  schema_version: '0.1',
  instance_id: 'i-ABCDEFGHIJKLMNOP',
  epoch: 1,
  flags: [{ challenge_key: 'C01', flag: 'VM{AAAAAAAAAAAAAAAAAAAAAAAA}' }],
};

const results = [];
const add = (rule, ok, detail = '') => { results.push({ rule, ok, detail: ok ? '' : detail }); };
let dir; // host temp dir (snapshot + fake flags), removed on exit incl. early failure

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// Run node inside the container (distroless has node at /nodejs/bin/node, no shell).
const nodeIn = (code) => docker(['exec', NAME, '/nodejs/bin/node', '-e', code]);

function cleanup() {
  docker(['rm', '-f', NAME]);
  docker(['network', 'rm', NET]);
}

function readyStatus() {
  // Ask the shop itself over loopback (no host port needed, so no egress route).
  // Let node exit naturally so the pipe flushes (no process.exit truncation).
  const r = nodeIn("fetch('http://127.0.0.1:3000/readyz').then(x=>console.log(x.status)).catch(()=>console.log(0))");
  return Number(r.stdout.trim()) || 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 40, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await sleep(delayMs);
  }
  return false;
}

async function main() {
  // Pre-flight: Docker present and the shop image built.
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
    console.error('Docker is not available; this harness needs Docker.');
    process.exit(2);
  }
  if (docker(['image', 'inspect', IMAGE]).status !== 0) {
    console.error(`The shop image ${IMAGE} is not built. Build it first: docker build -t ${IMAGE} apps/shop`);
    process.exit(2);
  }
  cleanup();

  // 1. Build a real seeded snapshot on the host (the injector would patch it).
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-t09-'));
  const snapshot = path.join(dir, 'snapshot.db');
  const flagsFile = path.join(dir, 'flags.json');
  await buildSnapshot(snapshot);
  fs.writeFileSync(flagsFile, JSON.stringify(FLAGS));

  try {
    // 2. An internal network: no gateway out, so no egress.
    if (docker(['network', 'create', '--internal', NET]).status !== 0) throw new Error('could not create the internal network');

    // 3. Run the real shop under the IF-6 runtime profile, instance env set, no marker yet.
    const run = docker(['run', '-d', '--name', NAME, '--network', NET,
      '--user', `${UID}:${UID}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--tmpfs', `/data:rw,nosuid,size=256m,uid=${UID},gid=${UID}`,
      '--tmpfs', `/run/vm:rw,nosuid,size=16m,uid=${UID},gid=${UID},mode=0750`,
      '-e', 'PORT=3000', '-e', 'VM_DB_PATH=/data/shop.db',
      '-e', 'VM_SNAPSHOT_PATH=/run/vm/snapshot.db', '-e', 'VM_FLAGS_PATH=/run/vm/flags.json',
      IMAGE]);
    if (run.status !== 0) throw new Error(`could not start the shop container:\n${run.stderr}`);

    // 4. Server is up and answering health (process live) before the marker.
    const up = await waitFor(() => nodeIn("fetch('http://127.0.0.1:3000/healthz').then(x=>process.exit(x.status===200?0:1)).catch(()=>process.exit(1))").status === 0);
    add('live-process-up', up, 'the shop process did not answer /healthz');

    // 5. NOT ready before the injector marker.
    add('live-not-ready-before-marker', readyStatus() === 503, 'the shop reported ready before the injector marker');

    // 6. Inject as the shop user (65532): a cap-dropped root cannot chown, so the
    //    files are written over `docker exec -i` stdin by node running as 65532,
    //    owned correctly with the injector's modes. Snapshot + flags first, marker LAST.
    const writeIn = (dstPath, mode, input) => spawnSync('docker',
      ['exec', '-i', NAME, '/nodejs/bin/node', '-e',
        `const fs=require('fs');fs.writeFileSync(${JSON.stringify(dstPath)}, fs.readFileSync(0));fs.chmodSync(${JSON.stringify(dstPath)}, ${mode});`],
      { input, timeout: 120000 });
    if (writeIn('/run/vm/snapshot.db', 0o444, fs.readFileSync(snapshot)).status !== 0) throw new Error('could not inject the snapshot');
    if (writeIn('/run/vm/flags.json', 0o400, fs.readFileSync(flagsFile)).status !== 0) throw new Error('could not inject the flags file');
    const marker = docker(['exec', NAME, '/nodejs/bin/node', '-e', "const fs=require('fs');fs.writeFileSync('/run/vm/injected','');fs.chmodSync('/run/vm/injected',0o444);"]);
    if (marker.status !== 0) throw new Error(`could not write the marker:\n${marker.stderr}`);

    // 7. Ready only AFTER the marker (snapshot copied to /data and opened).
    const becameReady = await waitFor(() => readyStatus() === 200);
    add('live-ready-after-marker', becameReady, 'the shop did not become ready after the marker');

    // 8. Runtime profile (IF-6 section 7) via docker inspect.
    const insp = docker(['inspect', NAME]);
    let c = {};
    try { c = JSON.parse(insp.stdout)[0]; } catch { /* checked below */ }
    const hc = c.HostConfig ?? {};
    add('live-runtime-nonroot', c.Config?.User === `${UID}:${UID}`, `User is ${c.Config?.User}`);
    add('live-runtime-readonly-root', hc.ReadonlyRootfs === true, 'root filesystem is not read-only');
    add('live-runtime-cap-drop-all', Array.isArray(hc.CapDrop) && hc.CapDrop.includes('ALL'), 'ALL capabilities are not dropped');
    add('live-runtime-no-new-privileges', (hc.SecurityOpt ?? []).some((s) => /no-new-privileges/.test(s)), 'no-new-privileges is not set');

    // 9. No network egress. A bare negative (the shop cannot reach out) would also
    //    pass on an offline host, so use a positive control: a sibling container on
    //    the default bridge must be able to reach out. If the host itself has no
    //    egress, the isolation claim cannot be proven this run (reported, not passed).
    const EGRESS_PROBE = "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))";
    const hostHasEgress = docker(['run', '--rm', IMAGE, '-e', EGRESS_PROBE]).status === 0;
    const shopReachedOut = nodeIn(EGRESS_PROBE).status === 0; // true = the shop could reach out (bad)
    if (hostHasEgress) {
      add('live-no-egress', !shopReachedOut, 'the shop could reach an external address (egress is not blocked)');
    } else {
      console.log('NOTICE live-no-egress: the host itself has no egress, so instance isolation cannot be proven this run');
    }

    // 10. No flag leaks in /healthz or /version (and the endpoints must actually answer 200).
    const vget = (p) => {
      const r = nodeIn(`fetch('http://127.0.0.1:3000${p}').then(async x=>console.log(JSON.stringify({s:x.status,t:await x.text()}))).catch(()=>console.log(JSON.stringify({s:0,t:''})))`);
      try { return JSON.parse(r.stdout.trim()); } catch { return { s: 0, t: '' }; }
    };
    const flag = FLAGS.flags[0].flag;
    const hz = vget('/healthz');
    const vz = vget('/version');
    add('live-no-flag-in-health', hz.s === 200 && vz.s === 200 && !hz.t.includes(flag) && !vz.t.includes(flag),
      'an endpoint did not answer 200, or a flag leaked in /healthz or /version');
  } finally {
    const keep = process.argv.includes('--keep');
    if (!keep) cleanup();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.rule}${r.ok ? '' : ` -- ${r.detail}`}`);
  console.log(failed.length === 0 ? `\nshop-instance: PASS (${results.length} checks)` : `\nshop-instance: FAIL (${failed.length}/${results.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  try { cleanup(); } catch { /* best effort */ }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  console.error(`shop-instance harness error: ${e.message}`);
  process.exit(1);
});
