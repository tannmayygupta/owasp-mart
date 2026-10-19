#!/usr/bin/env node
// Sandbox probe (S-8, story L-29): what a process that already runs code inside an instance container can see of the host kernel, under runc and under gVisor (runsc).
//   node scripts/sandbox-probe.mjs [--runtime runc|runsc] [--image <image>] [--out <report.json>]
// It starts ONE hardened container (the profile of an instance: user 65532, read-only root, cap_drop ALL, no-new-privileges, limits, no network, no mount), runs a fixed set of
// read-only look-arounds in it and prints what it found. It is not an attack: it asks the kernel questions a player's exploit would ask first (which kernel am I on, can I read
// kernel memory, can I list kernel modules, can I make a mount or a user namespace). Under runsc the answers come from gVisor's own kernel, written in Go, between the player and
// the host kernel; under runc they come from the host kernel itself. The verdict `boundary` is `user-space kernel` only when the container does NOT see the host kernel's
// identity and cannot read what only the host kernel could give. Exit 0 when the runtime's expectation holds (runsc: user-space kernel; runc: shared host kernel), 1 otherwise,
// 2 when Docker or the image is not available. Everything it creates carries the label vm.kind=sandbox-probe and is removed in every case. No address or secret is printed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_LABEL = 'vm.kind=sandbox-probe';
export const FALLBACK_IMAGE = 'node:24.21.0-alpine';
// the sandbox's own threads count against the limits (apps/orchestrator backend.py)
const LIMITS = { runc: { pids: 32, mem: 64 }, runsc: { pids: 128, mem: 128 } };

// One shell program, one `key=value` line per question. Every command is read-only; failures are answers too.
export const PROGRAM = [
  'echo "kernel_release=$(uname -r)"',
  'echo "proc_version=$(cat /proc/version 2>&1 | cut -c1-120)"',
  'echo "dmesg_first=$(dmesg 2>&1 | head -n 1 | cut -c1-100)"',
  'echo "kcore_read=$(head -c 1 /proc/kcore >/dev/null 2>&1 && echo readable || echo refused)"',
  'echo "modules_listed=$(wc -l < /proc/modules 2>/dev/null || echo 0)"',
  'echo "debugfs_listed=$(ls /sys/kernel/debug 2>/dev/null | wc -l)"',
  'echo "mount_tmpfs=$(mount -t tmpfs none /tmp 2>&1 >/dev/null && echo allowed || echo refused)"',
  'echo "user_namespace=$(unshare -U true >/dev/null 2>&1 && echo allowed || echo refused)"',
  'echo "cap_eff=$(grep CapEff /proc/self/status | cut -f2)"',
  'echo "processes_visible=$(ls /proc | grep -c \'^[0-9]\')"',
  'echo "dev_nodes=$(ls /dev | wc -l)"',
].join('; ');

// Two containers share a memory-backed volume the way the import service and the shop do (IF-6: /run/import). One listens on a unix socket in it, the other connects.
// Under gVisor this only works when the runtime is started with --host-uds=all (ENOENT without it, found live on vm-i), so a regression here is a broken import path.
const SOCKET_SERVER = 'require("net").createServer((c)=>c.end("pong")).listen("/v/s.sock",()=>{});setTimeout(()=>{},60000)';
const SOCKET_CLIENT = 'const c=require("net").connect("/v/s.sock");c.on("data",(d)=>{process.stdout.write(String(d));process.exit(0)});c.on("error",(e)=>{process.stdout.write("error "+e.code);process.exit(1)});setTimeout(()=>{process.stdout.write("timeout");process.exit(1)},4000)';

export function sharedSocket({ docker, runtime, image, nonce }) {
  const vol = `vmsandbox-${nonce}-v`; const srv = `vmsandbox-${nonce}-srv`;
  const base = ['--runtime', runtime, '--network', 'none', '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', `${LIMITS[runtime].mem}m`,
    '--pids-limit', String(LIMITS[runtime].pids), '--label', PROBE_LABEL, '-v', `${vol}:/v`, '--entrypoint', 'node'];
  try {
    if (docker(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=noexec,nosuid,nodev,size=1m,uid=65532,gid=65532,mode=0750', '--label', PROBE_LABEL, vol]).code !== 0) return 'volume-failed';
    if (docker(['run', '-d', '--name', srv, ...base, image, '-e', SOCKET_SERVER]).code !== 0) return 'server-failed';
    docker(['exec', srv, 'node', '-e', 'setTimeout(()=>{},1500)']); // give the listener a moment
    const r = docker(['run', '--rm', ...base, image, '-e', SOCKET_CLIENT]);
    return r.stdout.trim() === 'pong' ? 'works' : `fails (${r.stdout.trim() || 'no answer'})`;
  } finally {
    docker(['rm', '-f', srv]);
    docker(['volume', 'rm', '-f', vol]);
  }
}

export function cliDocker(args, { timeout = 120000 } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error) return { code: -1, stdout: '', stderr: r.error.code === 'ENOENT' ? 'docker not found' : String(r.error.message) };
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function parseFacts(text) {
  const facts = {};
  for (const line of String(text).split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) facts[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return facts;
}

/** Pure: the verdict from the facts and the host's kernel release. */
export function judge(runtime, facts, hostRelease) {
  const seesHostKernel = facts.kernel_release === hostRelease || (facts.proc_version ?? '').includes(hostRelease);
  const kernelMemory = facts.kcore_read === 'readable';
  const modules = Number(facts.modules_listed || 0);
  const problems = [];
  const boundary = !seesHostKernel && !kernelMemory && modules === 0 ? 'user-space kernel' : 'shared host kernel';
  if (facts.cap_eff && !/^0+$/.test(facts.cap_eff)) problems.push(`the container holds capabilities (${facts.cap_eff})`);
  if (facts.mount_tmpfs === 'allowed') problems.push('a mount was allowed');
  if (kernelMemory) problems.push('kernel memory (/proc/kcore) is readable');
  if (runtime === 'runsc' && boundary !== 'user-space kernel') problems.push('under runsc the container still sees the host kernel');
  if (facts.shared_socket !== undefined && facts.shared_socket !== 'works') problems.push(`a unix socket shared through a volume between two containers does not work (${facts.shared_socket}): the import path would break`);
  if (runtime === 'runc' && boundary !== 'shared host kernel') problems.push('under runc the container does not see the host kernel: is the daemon default really runc?');
  return { ok: problems.length === 0, boundary, problems };
}

export function runProbe({ docker = cliDocker, runtime = 'runsc', image, hostRelease = os.release(), nonce = randomBytes(4).toString('hex') } = {}) {
  if (!['runc', 'runsc'].includes(runtime)) return { exitCode: 2, report: { error: 'runtime is runc or runsc' } };
  if (docker(['version', '--format', '{{.Server.Version}}']).code !== 0) return { exitCode: 2, report: { error: 'Docker is not available' } };
  const chosen = image ?? FALLBACK_IMAGE;
  if (docker(['image', 'inspect', chosen]).code !== 0 && docker(['pull', chosen], { timeout: 300000 }).code !== 0) return { exitCode: 2, report: { error: `image ${chosen} is not available` } };
  const name = `vmsandbox-${nonce}`;
  const lim = LIMITS[runtime];
  try {
    const r = docker(['run', '--rm', '--name', name, '--label', PROBE_LABEL, '--runtime', runtime, '--network', 'none', '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', `${lim.mem}m`, '--cpus', '0.5', '--pids-limit', String(lim.pids), '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=1m,uid=65532,gid=65532,mode=0750',
      '--entrypoint', 'sh', chosen, '-c', PROGRAM]);
    if (r.code !== 0) return { exitCode: 2, report: { error: `the probe container failed: ${r.stderr.trim().split('\n').pop()}` } };
    const facts = parseFacts(r.stdout);
    facts.shared_socket = sharedSocket({ docker, runtime, image: chosen, nonce });
    const verdict = judge(runtime, facts, hostRelease);
    return { exitCode: verdict.ok ? 0 : 1, report: { ok: verdict.ok, runtime, image: chosen, boundary: verdict.boundary, host_kernel_release: hostRelease, facts, problems: verdict.problems } };
  } finally {
    const ids = docker(['ps', '-aq', '--filter', `label=${PROBE_LABEL}`]).stdout.split(/\s+/).filter(Boolean);
    if (ids.length) docker(['rm', '-f', ...ids]);
  }
}

export function main(argv = process.argv.slice(2)) {
  let runtime = 'runsc'; let image; let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runtime' && argv[i + 1]) runtime = argv[++i];
    else if (argv[i] === '--image' && argv[i + 1]) image = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
    else { console.error('Usage: node scripts/sandbox-probe.mjs [--runtime runc|runsc] [--image <image>] [--out <report.json>]'); return 2; }
  }
  const { exitCode, report } = runProbe({ runtime, image });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
  console.log(exitCode === 0 ? `sandbox probe: PASS (${runtime}: ${report.boundary})` : `sandbox probe: FAIL ${report.error ?? report.problems?.join('; ')}`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());