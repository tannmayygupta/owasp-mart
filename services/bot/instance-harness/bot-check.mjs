// Support-agent bot checks (T-13, FR-SHP-11 + spike S-5). Runs the real bot image
// with a target on the instance network and proves: it visits an allow-listed
// page of its own instance, refuses a non-allow-listed page and a page of another
// origin, and its memory per instance is measured (S-5 baseline for the
// controller; the headless-browser memory is the remaining S-5 work). Needs
// Docker. Run: node services/bot/instance-harness/bot-check.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTEXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT_IMAGE = process.env.VM_BOT_IMAGE ?? 'vulnmart-bot:local';
const TARGET_IMAGE = process.env.VM_TARGET_IMAGE ?? 'vulnmart-mock-services:local'; // serves /healthz on 9101
const INST = 'vm-t13-inst';
const BOT = 'vm-t13-bot';
const TARGET = 'vm-t13-target';
const TARGET_URL = `http://${TARGET}:9101`;
const MEM_CAP_MB = 200; // the controller (no browser) must stay well under the bot's 512 MB budget

const results = [];
const add = (rule, ok, detail = '') => results.push({ rule, ok, detail: ok ? '' : detail });
function docker(args, opts = {}) { const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, ...opts }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; }
const execNode = (name, code) => docker(['exec', name, '/nodejs/bin/node', '-e', code]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 60, delayMs = 500 } = {}) { for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(delayMs); } return false; }
const running = (name) => docker(['inspect', '-f', '{{.State.Status}}', name]).stdout.trim();
function cleanup() { for (const n of [BOT, TARGET]) docker(['rm', '-f', n]); docker(['network', 'rm', INST]); }

// Ask the bot (from inside its container) to visit a path; returns the parsed JSON {status, body}.
function askVisit(pathStr) {
  const code = `fetch('http://127.0.0.1:9200/visit',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify({ path: pathStr }))}}).then(async r=>console.log(JSON.stringify({s:r.status,b:await r.json()}))).catch(()=>console.log(''))`;
  const r = execNode(BOT, code);
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
}

async function main() {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('Docker is not available.'); process.exit(2); }
  if (docker(['image', 'inspect', BOT_IMAGE]).status !== 0 && docker(['build', '-t', BOT_IMAGE, CONTEXT], { timeout: 600000 }).status !== 0) { console.error(`could not build ${BOT_IMAGE}`); process.exit(2); }
  if (docker(['image', 'inspect', TARGET_IMAGE]).status !== 0) { console.error(`target image ${TARGET_IMAGE} is not built (build mock-services first)`); process.exit(2); }
  cleanup();
  const hardened = ['--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m'];
  try {
    if (docker(['network', 'create', '--internal', INST]).status !== 0) throw new Error('could not create the instance network');
    if (docker(['run', '-d', '--name', TARGET, '--network', INST, ...hardened, TARGET_IMAGE]).status !== 0) throw new Error('could not start the target');
    if (docker(['run', '-d', '--name', BOT, '--network', INST, ...hardened,
      '-e', `VM_BOT_TARGET=${TARGET_URL}`, '-e', 'VM_BOT_ALLOW_PREFIXES=/healthz', '-e', 'VM_BOT_MAX_VISIT_MS=3000', BOT_IMAGE]).status !== 0) throw new Error('could not start the bot');

    for (const n of [TARGET, BOT]) { const ok = await waitFor(() => running(n) === 'running'); if (!ok) throw new Error(`${n} is ${running(n) || 'missing'}`); }
    add('live-bot-up', await waitFor(() => execNode(BOT, "fetch('http://127.0.0.1:9200/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))").status === 0), 'the bot did not answer /healthz');

    // Visits an allow-listed page of its OWN instance.
    const allowed = await waitFor(() => { const v = askVisit('/healthz'); return v && v.s === 200 && v.b?.visited === true && v.b?.status === 200; }, { tries: 40 });
    add('live-visits-allowed-page', allowed, 'the bot did not visit an allow-listed page of its instance');

    // Refuses a non-allow-listed page of its own instance.
    const notAllowed = askVisit('/ledger');
    add('live-refuses-disallowed-path', notAllowed?.s === 403 && notAllowed?.b?.refused === true, `visit /ledger -> ${JSON.stringify(notAllowed)}`);

    // Refuses a page of ANOTHER origin (not this instance).
    const other = askVisit('http://evil.invalid/healthz');
    add('live-refuses-other-instance', other?.s === 403 && other?.b?.refused === true, `visit other-origin -> ${JSON.stringify(other)}`);

    // Memory per instance (S-5 baseline for the controller).
    const mem = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', BOT]).stdout.trim(); // e.g. "41.2MiB / 512MiB"
    const used = mem.split('/')[0].trim();
    const mb = /([\d.]+)\s*([KMG]?i?B)/.exec(used);
    let usedMb = NaN;
    if (mb) {
      const n = Number(mb[1]);
      const unit = mb[2][0];
      usedMb = unit === 'G' ? n * 1024 : unit === 'K' ? n / 1024 : unit === 'B' ? n / (1024 * 1024) : n; // M or MiB
    }
    console.log(`NOTE bot memory per instance (S-5 baseline, controller only): ${used}`);
    add('live-memory-measured', Number.isFinite(usedMb) && usedMb > 0 && usedMb < MEM_CAP_MB, `bot memory ${used} (cap ${MEM_CAP_MB}MB)`);
  } finally {
    if (!process.argv.includes('--keep')) cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.rule}${r.ok ? '' : ` -- ${r.detail}`}`);
  console.log(failed.length === 0 ? `\nbot: PASS (${results.length} checks)` : `\nbot: FAIL (${failed.length}/${results.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { try { cleanup(); } catch { /* best effort */ } console.error(`bot harness error: ${e.message}`); process.exit(1); });
