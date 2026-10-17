// Mock-services reachability (T-11, FR-SHP-13): the four mocks answer INSIDE the
// instance network and are UNREACHABLE from outside. Runs the real mock image
// (no published ports) on an internal network; a sibling on that network reaches
// all four ports, an outsider on another network cannot, and the host has no
// port mapping. Needs Docker. Run: node services/mock-services/instance-harness/mock-reach-check.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const IMAGE = process.env.VM_MOCK_IMAGE ?? 'vulnmart-mock-services:local';
const INST = 'vm-t11-inst';
const OUT = 'vm-t11-out';
const MOCK = 'vm-t11-mock';
const SIBLING = 'vm-t11-sibling';
const OUTSIDER = 'vm-t11-outsider';
const PORTS = { payment: 9101, kyc: 9102, metadata: 9103, collector: 9104 };

const results = [];
const add = (rule, ok, detail = '') => results.push({ rule, ok, detail: ok ? '' : detail });

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 60, delayMs = 500 } = {}) { for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(delayMs); } return false; }
// Reachability via an explicit sentinel so a broken exec (ERROR) is not read as BLOCKED.
function probe(name, url) {
  const r = docker(['exec', name, '/nodejs/bin/node', '-e', `fetch('${url}',{signal:AbortSignal.timeout(3000)}).then(r=>console.log(r.ok?'REACHED':'STATUS'+r.status)).catch(()=>console.log('BLOCKED'))`]);
  const out = r.stdout.trim();
  return out === 'REACHED' ? 'REACHED' : out === 'BLOCKED' ? 'BLOCKED' : 'ERROR';
}
const running = (name) => docker(['inspect', '-f', '{{.State.Status}}', name]).stdout.trim();

function cleanup() {
  for (const n of [MOCK, SIBLING, OUTSIDER]) docker(['rm', '-f', n]);
  for (const n of [INST, OUT]) docker(['network', 'rm', n]);
}

async function main() {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('Docker is not available.'); process.exit(2); }
  if (docker(['image', 'inspect', IMAGE]).status !== 0) {
    if (docker(['build', '-t', IMAGE, path.join('services', 'mock-services')], { timeout: 600000 }).status !== 0) { console.error(`could not build ${IMAGE}`); process.exit(2); }
  }
  cleanup();
  const hardened = ['--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m'];
  try {
    if (docker(['network', 'create', '--internal', INST]).status !== 0) throw new Error('could not create INST');
    if (docker(['network', 'create', '--internal', OUT]).status !== 0) throw new Error('could not create OUT');

    // The mock-services, hardened, NO published ports, on the instance network.
    if (docker(['run', '-d', '--name', MOCK, '--network', INST, ...hardened, IMAGE]).status !== 0) throw new Error('could not start mock-services');
    // A sibling on the instance network, and an outsider on a different network.
    docker(['run', '-d', '--name', SIBLING, '--network', INST, ...hardened, IMAGE]);
    docker(['run', '-d', '--name', OUTSIDER, '--network', OUT, ...hardened, IMAGE]);

    for (const n of [MOCK, SIBLING, OUTSIDER]) {
      const ok = await waitFor(() => running(n) === 'running');
      if (!ok) throw new Error(`${n} is ${running(n) || 'missing'}:\n${docker(['logs', n]).stderr.trim().split('\n').slice(-5).join('\n')}`);
    }

    // Inside the instance: every mock port answers /healthz.
    for (const [name, port] of Object.entries(PORTS)) {
      const ok = await waitFor(() => probe(SIBLING, `http://${MOCK}:${port}/healthz`) === 'REACHED', { tries: 60 });
      add(`live-inside-${name}-reachable`, ok, `the ${name} mock (:${port}) is not reachable from a sibling on the instance network`);
    }

    // From outside the instance network: no route (by name and IP).
    const mockIp = docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${INST}").IPAddress}}`, MOCK]).stdout.trim();
    const byName = probe(OUTSIDER, `http://${MOCK}:9101/healthz`);
    const byIp = mockIp ? probe(OUTSIDER, `http://${mockIp}:9101/healthz`) : 'ERROR';
    add('live-outside-no-route', byName === 'BLOCKED' && byIp === 'BLOCKED', `an outsider reached mock-services (byName=${byName}, byIp=${byIp})`);

    // No host port mapping (never published to the host).
    const portMap = docker(['inspect', '-f', '{{json .NetworkSettings.Ports}}', MOCK]).stdout.trim();
    let published = false;
    try { published = Object.values(JSON.parse(portMap) || {}).some((v) => Array.isArray(v) && v.length > 0); } catch { published = true; }
    add('live-not-published-to-host', !published, `mock-services has host port bindings: ${portMap}`);
  } finally {
    if (!process.argv.includes('--keep')) cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.rule}${r.ok ? '' : ` -- ${r.detail}`}`);
  console.log(failed.length === 0 ? `\nmock-services: PASS (${results.length} checks)` : `\nmock-services: FAIL (${failed.length}/${results.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { try { cleanup(); } catch { /* best effort */ } console.error(`mock-reach harness error: ${e.message}`); process.exit(1); });
