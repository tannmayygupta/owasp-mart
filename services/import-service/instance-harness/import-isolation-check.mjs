// Import-service isolation (T-12, FR-SHP-13): a job runs in a FRESH process and
// the service cannot reach the network or a database. Runs the real image with
// network_mode none and no /data mount, sends two jobs over the unix socket, and
// asserts: both succeed with DIFFERENT worker pids (fresh process per job); the
// network is unreachable from inside; the container has no /data mount and no
// database env. Needs Docker. Run: node services/import-service/instance-harness/import-isolation-check.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The build context resolves relative to this file, so the harness works whether
// run from the repo root or via the package script (cwd = the package dir).
const CONTEXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.VM_IMPORT_IMAGE ?? 'vulnmart-import-service:local';
const NAME = 'vm-t12-import';
const SOCKET = '/run/import/import.sock';

const results = [];
const add = (rule, ok, detail = '') => results.push({ rule, ok, detail: ok ? '' : detail });
function docker(args, opts = {}) { const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, ...opts }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; }
const execNode = (code) => docker(['exec', NAME, '/nodejs/bin/node', '-e', code]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 60, delayMs = 500 } = {}) { for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(delayMs); } return false; }
function cleanup() { docker(['rm', '-f', NAME]); }

// Send one job over the socket from inside the container; returns the parsed result or null.
function sendJob(job) {
  const code = `const net=require('net');const c=net.connect(process.env.VM_IMPORT_SOCKET,()=>c.end(JSON.stringify(${JSON.stringify(job)})));let d='';c.on('data',x=>d+=x);c.on('end',()=>process.stdout.write(d));c.on('error',()=>process.stdout.write(''));`;
  const r = execNode(code);
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
}

async function main() {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('Docker is not available.'); process.exit(2); }
  if (docker(['image', 'inspect', IMAGE]).status !== 0) {
    if (docker(['build', '-t', IMAGE, CONTEXT], { timeout: 600000 }).status !== 0) { console.error(`could not build ${IMAGE}`); process.exit(2); }
  }
  cleanup();
  try {
    // network_mode none, hardened, no /data mount; the socket lives on a tmpfs.
    const run = docker(['run', '-d', '--name', NAME, '--network', 'none',
      '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--tmpfs', '/run/import:rw,nosuid,size=16m,uid=65532,gid=65532,mode=0770',
      '-e', `VM_IMPORT_SOCKET=${SOCKET}`, IMAGE]);
    if (run.status !== 0) throw new Error(`could not start import-service:\n${run.stderr}`);

    // Wait until the socket accepts a connection.
    const up = await waitFor(() => { const j = sendJob({ product: { title: 'ping' } }); return j && j.ok === true; });
    add('live-import-up', up, 'the import service did not answer on its socket');

    // Fresh process per job: two jobs must run in different worker processes.
    const a = sendJob({ product: { title: 'A' } });
    const b = sendJob({ product: { title: 'B' } });
    add('live-fresh-process-per-job', !!a?.worker_pid && !!b?.worker_pid && a.worker_pid !== b.worker_pid, `worker pids a=${a?.worker_pid} b=${b?.worker_pid}`);
    add('live-job-preview-correct', a?.ok === true && a.preview?.title === 'A', `job A result ${JSON.stringify(a)}`);

    // No network egress from inside (the container runs network_mode none).
    const egress = execNode("fetch('http://1.1.1.1',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('REACHED')).catch(()=>console.log('BLOCKED'))");
    add('live-no-network', egress.stdout.trim() === 'BLOCKED', `network probe said "${egress.stdout.trim()}"`);

    // Network is genuinely "none" at the container level.
    const netMode = docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', NAME]).stdout.trim();
    add('live-network-mode-none', netMode === 'none', `network mode is "${netMode}"`);

    // No database access: no /data mount and no db env var.
    const mounts = docker(['inspect', '-f', '{{json .Mounts}}', NAME]).stdout;
    const env = docker(['inspect', '-f', '{{json .Config.Env}}', NAME]).stdout;
    add('live-no-data-mount', !/"\/data"/.test(mounts) && !/\/data\b/.test(mounts), `mounts: ${mounts}`);
    add('live-no-db-env', !/VM_DB_PATH|VM_CATALOG_DB_PATH/.test(env), 'a database env var is set');
  } finally {
    if (!process.argv.includes('--keep')) cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.rule}${r.ok ? '' : ` -- ${r.detail}`}`);
  console.log(failed.length === 0 ? `\nimport-service: PASS (${results.length} checks)` : `\nimport-service: FAIL (${failed.length}/${results.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { try { cleanup(); } catch { /* best effort */ } console.error(`import-isolation harness error: ${e.message}`); process.exit(1); });
