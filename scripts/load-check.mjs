// `node scripts/load-check.mjs [--n 6] [--target-s 60]` (story 8.3, LX-2): starts N stub instances AT ONCE through the real
// orchestrator (Docker backend, Docker Desktop), records the time to `ready` of each (p50, max), the memory of the instance
// containers (docker stats --no-stream), destroys them, and writes the numbers to
// docs/assets/story-8-3-loop-and-load/load-check.txt with the machine's CPU and RAM. Exit 1 on FAIL.
// These are LAPTOP numbers. The concurrency target on the deployed VM-I (NFR-PRF) is NOT proven by this: it is a runbook step
// (story 6, docs/runbooks/measure-instances.md). The 60 s target is a placeholder (OI-25 style), not a decision.
// The pure parts (statistics, report text) are exported and tested in scripts/load-check.test.mjs.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, reduceTemplate, relaxSchema } from './demo.mjs';
import {
  ROOT, STUB_TAG, docker, findLeftovers, freePort, imageId, killTree, leftoverText, orchCall, parseMemMiB, readLog, redactAll, sleep,
  startOrchestrator, toolOk, waitListening,
} from './e2e/loop-support.mjs';

export const EVIDENCE_FILE = path.join(ROOT, 'docs', 'assets', 'story-8-3-loop-and-load', 'load-check.txt');
export const DEFAULT_N = 6;
export const DEFAULT_TARGET_S = 60;

// ---------------- pure parts
export function parseArgs(argv) {
  const out = { n: DEFAULT_N, targetS: DEFAULT_TARGET_S };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n' || a === '--target-s') {
      const v = Number(argv[++i]);
      const max = a === '--n' ? 50 : 3600;
      if (!Number.isInteger(v) || v < 1 || v > max) return { error: `${a} needs a whole number from 1 to ${max}` };
      out[a === '--n' ? 'n' : 'targetS'] = v;
    } else return { error: `Unknown option "${a}". Usage: node scripts/load-check.mjs [--n 6] [--target-s 60]` };
  }
  return out;
}

/** Nearest-rank percentile of a list of numbers (p in 0..100). null for an empty list. */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(s.length, rank) - 1];
}

/** times: seconds to ready per instance, or null for an instance that never became ready. */
export function summarize(times) {
  const ok = times.filter((t) => typeof t === 'number');
  return { count: times.length, ready: ok.length, failed: times.length - ok.length, p50: percentile(ok, 50), max: ok.length ? Math.max(...ok) : null, min: ok.length ? Math.min(...ok) : null };
}

/** PASS only when every instance is ready within the target. */
export function verdict(times, targetS) {
  const s = summarize(times);
  return s.failed === 0 && s.count > 0 && s.max <= targetS ? 'PASS' : 'FAIL';
}

export function memoryStats(mibList) {
  const v = mibList.filter((m) => typeof m === 'number');
  if (!v.length) return { count: 0, total: null, avg: null, max: null };
  const total = v.reduce((a, b) => a + b, 0);
  return { count: v.length, total, avg: total / v.length, max: Math.max(...v) };
}

const f1 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(1));

export function formatReport({ date, n, targetS, times, mem, machine, leftover, note }) {
  const s = summarize(times);
  return redactAll([
    'VulnMart load check (node scripts/load-check.mjs): LAPTOP numbers on Docker Desktop, not the VM-I concurrency target',
    `Date: ${date}`,
    `Machine: ${machine}`,
    `Instances started at once: ${n} (stub instance image, real orchestrator, Docker backend, reduced two-component template)`,
    `Target for every instance to be ready: ${targetS} s (placeholder, OI-25 style, not a decision)`,
    '',
    'Instance  Seconds to ready',
    ...times.map((t, i) => `${String(i + 1).padStart(8)}  ${typeof t === 'number' ? t.toFixed(1) : 'NOT READY'}`),
    '',
    `Ready: ${s.ready} of ${s.count}   p50: ${f1(s.p50)} s   max: ${f1(s.max)} s   min: ${f1(s.min)} s`,
    `Memory of the instance containers (docker stats, no-stream): ${mem.count} containers, total ${f1(mem.total)} MiB, average ${f1(mem.avg)} MiB, largest ${f1(mem.max)} MiB`,
    `After destroy: ${leftover}`,
    ...(note ? [`Note: ${note}`] : []),
    '',
    `Result: ${verdict(times, targetS)}`,
    '',
  ].join('\n'));
}

export function machineText({ cpus, ramGiB, dockerCpus, dockerRamGiB }) {
  return `${cpus.count} logical CPUs (${cpus.model}), ${ramGiB.toFixed(1)} GiB RAM; Docker engine sees ${dockerCpus} CPUs and ${dockerRamGiB.toFixed(1)} GiB`;
}

// ---------------- impure part
const newId = () => { const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; return `i-${Array.from(randomBytes(16), (b) => B32[b % 32]).join('')}`; };

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) { console.error(args.error); return 1; }
  if (!toolOk('docker', ['info', '--format', '{{.ServerVersion}}'])) { console.error('Docker is not running: start Docker Desktop first.'); return 1; }
  if (!toolOk('uv', ['--version'])) { console.error('uv is not installed (docs/bmad/INSTALL.md).'); return 1; }
  if ((await docker(['ps', '-aq', '--filter', 'label=vm.instance'])).stdout.trim()) { console.error('Containers labelled vm.instance exist already (not made by this check): remove them first.'); return 1; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-load-check-'));
  const key = randomBytes(32).toString('hex');
  const made = [];
  let orch = null;
  let times = []; let mem = memoryStats([]); let note = '';
  try {
    const build = await docker(['build', '-q', '-f', 'contracts/mocks/stub-instance/Dockerfile', '-t', STUB_TAG, ROOT], { cwd: ROOT, timeout: 900000 });
    if (build.status !== 0) throw new Error(`stub image build failed: ${build.stderr.slice(-200)}`);
    const stubId = imageId(STUB_TAG);
    fs.mkdirSync(path.join(tmp, 'templates'));
    fs.writeFileSync(path.join(tmp, 'templates', 'shop-v0.json'), JSON.stringify(reduceTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'examples', 'valid', 'instance-template', 'shop-template.json'), 'utf8')))), 'utf8');
    fs.writeFileSync(path.join(tmp, 'template.schema.json'), JSON.stringify(relaxSchema(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'instance-template.schema.json'), 'utf8')))), 'utf8');
    const port = await freePort();
    orch = startOrchestrator({ dir: tmp, manifest: buildManifest({ stubId, shopId: stubId, realShop: false }), port, key, healthTimeoutS: Math.max(60, args.targetS * 2) });
    if (!(await waitListening(orch, port))) throw new Error(`the orchestrator did not start: ${redactAll(readLog(orch.logFile).split('\n').slice(-4).join(' | '))}`);
    const base = `http://127.0.0.1:${port}`;
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'orchestrator', 'examples', 'valid', 'create.request.json'), 'utf8'));

    const ids = Array.from({ length: args.n }, newId);
    ids.forEach((i) => made.push(i));
    const t0 = Date.now();
    times = await Promise.all(ids.map(async (id, k) => {
      const r = await orchCall(base, key, 'POST', '/v1/instances', { ...example, instance_id: id, hostname: `load-${k}.instances.example.invalid` });
      if (r.status !== 202 && r.status !== 200) return null;
      const end = t0 + args.targetS * 2000; // look twice as long as the target, so a slow instance still gets a number
      while (Date.now() < end) {
        const g = await orchCall(base, key, 'GET', `/v1/instances/${id}`);
        if (g.json?.state === 'ready') return (Date.now() - t0) / 1000;
        if (g.json?.state === 'failed') return null;
        await sleep(500);
      }
      return null;
    }));
    await sleep(3000); // let the processes settle before reading memory (the method of measure-instances.md uses a settle time too)
    const st = await docker(['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}']);
    const mine = new Set(made.map((i) => `vm-${i.toLowerCase()}-`));
    const mibs = st.stdout.split(/\r?\n/).filter(Boolean).filter((l) => [...mine].some((p) => l.startsWith(p))).map((l) => parseMemMiB(l.split('|')[1]));
    mem = memoryStats(mibs);
    if (times.some((t) => t === null)) note = 'at least one instance did not become ready in time or failed';
    for (const id of made) await orchCall(base, key, 'DELETE', `/v1/instances/${id}`);
    for (let i = 0; i < 60; i++) {
      if (!(await docker(['ps', '-aq', ...made.flatMap((id) => ['--filter', `label=vm.instance=${id}`])])).stdout.trim()) break;
      await sleep(1000);
    }
  } catch (e) {
    note = redactAll(String(e?.message ?? e)).slice(0, 300);
    times = times.length ? times : [null];
  } finally {
    killTree(orch);
    // remove only what these instance ids made (preflight proved no vm.instance object existed before)
    let left = findLeftovers({});
    for (const id of made) {
      const f = ['--filter', `label=vm.instance=${id}`];
      const cs = (await docker(['ps', '-aq', ...f])).stdout.split('\n').filter(Boolean);
      if (cs.length) await docker(['rm', '-f', '-v', ...cs]);
      for (const n of (await docker(['network', 'ls', '-q', ...f])).stdout.split('\n').filter(Boolean)) await docker(['network', 'rm', n]);
      for (const v of (await docker(['volume', 'ls', '-q', ...f])).stdout.split('\n').filter(Boolean)) await docker(['volume', 'rm', '-f', v]);
    }
    const probe = { containers: '', networks: '', volumes: '' };
    for (const id of made) {
      const f = ['--filter', `label=vm.instance=${id}`];
      probe.containers += `\n${(await docker(['ps', '-aq', ...f])).stdout}`;
      probe.networks += `\n${(await docker(['network', 'ls', '-q', ...f])).stdout}`;
      probe.volumes += `\n${(await docker(['volume', 'ls', '-q', ...f])).stdout}`;
    }
    left = findLeftovers(probe);
    fs.rmSync(tmp, { recursive: true, force: true });
    const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout || '{}');
    const cpu = os.cpus();
    const machine = machineText({ cpus: { count: cpu.length, model: (cpu[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim() }, ramGiB: os.totalmem() / 2 ** 30, dockerCpus: info.NCPU ?? '?', dockerRamGiB: (info.MemTotal ?? 0) / 2 ** 30 });
    const report = formatReport({ date: new Date().toLocaleDateString('en-CA'), n: args.n, targetS: args.targetS, times, mem, machine, leftover: leftoverText(left), note });
    console.log(report);
    try { fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true }); fs.writeFileSync(EVIDENCE_FILE, report, 'utf8'); console.log('Evidence (redacted) written to docs/assets/story-8-3-loop-and-load/load-check.txt'); } catch (e) { console.error(`Could not write the evidence file: ${e.message}`); }
    process.exitCode = verdict(times, args.targetS) === 'PASS' && left.total === 0 ? 0 : 1;
  }
  return process.exitCode ?? 0;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c));
}
