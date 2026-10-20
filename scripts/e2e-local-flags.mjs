#!/usr/bin/env node
// Every challenge, attacked the way a player attacks it, against a REAL shop started the way an instance starts it, on this machine (no Docker, no platform).
//   node scripts/e2e-local-flags.mjs [--only C01,C05] [--json file]
// What it does: builds the seeded snapshot, runs the real injector with a fresh flag per challenge (made here, never a real one), starts the shop in instance mode,
// the import service (C06) and the mock services (C10, C08, C11), then runs the exploit module of challenges/tests/<challenge>/ against the shop.
// For each challenge it checks: the exploit holds; the flag planted for THAT challenge came back in the responses; no flag of another challenge came back.
// Not covered here (the platform's job, proved by scripts/e2e/loop.e2e.test.mjs and scripts/e2e-live-exploits.mjs): the sidecar event, the score, the paste check.
// C03 part B (the support bot) needs the bot service and is run by challenges/tests/c03-injection/live-loop.test.mjs.
// Nothing is printed that looks like a flag.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = /VM\{[A-Z2-7]{24}\}/g;
export const CHALLENGES = {
  C01: 'c01-cross-store-order', C02: 'c02-gift-card-codes', C03: 'c03-injection', C04: 'c04-quick-refund', C05: 'c05-security-misconfig', C06: 'c06-prototype-pollution',
  C07: 'c07-auth-failures', C08: 'c08-payment-webhook', C09: 'c09-logging-failures', C10: 'c10-ssrf', C11: 'c11-kyc-failopen',
};
const EXPLOIT_FILES = ['exploit.live.mjs', 'exploit-a-sqli.mjs', 'exploit.mjs'];
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const newFlag = () => `VM{${Array.from(crypto.randomBytes(24), (b) => BASE32[b % 32]).join('')}}`;

const rows = [];
const check = (name, ok, detail = '') => { rows.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); return !!ok; };

/** A fetch that remembers every flag-shaped value it sees in a response body. */
export function recordingFetch(found) {
  return async (url, opts = {}) => {
    const res = await fetch(url, opts);
    try { for (const m of (await res.clone().text()).matchAll(FLAG)) found.add(m[0]); } catch { /* a stream or a binary answer */ }
    return res;
  };
}

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
async function waitFor(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch { /* not yet */ } await sleep(300); } throw new Error(`timed out: ${label}`); }
const portOpen = (port) => new Promise((resolve) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); resolve(true); }); c.on('error', () => resolve(false)); });

async function loadExploit(key) {
  const dir = path.join(ROOT, 'challenges', 'tests', CHALLENGES[key]);
  // C03 part B (the support bot) needs the bot service; here C03 means part A, the SQL injection
  for (const f of key === 'C03' ? ['exploit-a-sqli.mjs'] : EXPLOIT_FILES) if (fs.existsSync(path.join(dir, f))) return { fn: (await import(pathToFileURL(path.join(dir, f)).href)).default, file: f };
  return null;
}

/** The same run inside the Linux CI image (scripts/ci-linux.mjs builds it): the repository is copied in without node_modules, installed, and run. Needs Docker and the image. */
function runInDocker(passArgs) {
  const script = ['set -u', 'mkdir /work', 'tar -C /src --exclude=node_modules --exclude=.venv --exclude=tools/.bin --exclude=__pycache__ --exclude=.pytest_cache -cf - . | tar -C /work -xf - 2>/dev/null',
    'cd /work', 'pnpm install --frozen-lockfile > /tmp/install.log 2>&1 || { tail -5 /tmp/install.log; exit 3; }', `node scripts/e2e-local-flags.mjs ${passArgs.join(' ')}`].join('\n');
  return spawnSync('docker', ['run', '--rm', '-v', `${ROOT}:/src:ro`, 'vulnmart-ci-linux:local', 'bash', '-c', script], { stdio: 'inherit' }).status ?? 1;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--docker')) return runInDocker(argv.filter((a) => a !== '--docker'));
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  const only = o.only ? o.only.split(',') : Object.keys(CHALLENGES);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-local-flags-'));
  const children = [];
  const stop = () => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } };
  try {
    // 1. the seeded snapshot, then the real injector with one fresh flag per challenge
    const base = path.join(dir, 'base.db');
    const built = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'shop', 'seed', 'build-snapshot.mjs'), base], { encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`the snapshot did not build: ${built.stderr.slice(0, 200)}`);
    const flags = Object.fromEntries(Object.keys(CHALLENGES).map((k) => [k, newFlag()]));
    const doc = { schema_version: '0.1', instance_id: 'i-LOCALFLAGSAAAAAA', epoch: 1, issued_at: new Date().toISOString(), seed: crypto.randomBytes(24).toString('base64url'),
      flags: Object.entries(flags).map(([challenge_key, flag]) => ({ challenge_key, flag })), decoys: [] };
    const run = path.join(dir, 'run'); const imp = path.join(dir, 'imp'); const mock = path.join(dir, 'mock');
    for (const d of [run, imp, mock]) fs.mkdirSync(d, { recursive: true });
    const { runInject } = await import(pathToFileURL(path.join(ROOT, 'apps', 'shop', 'src', 'instance', 'inject.mjs')).href);
    const code = await runInject({ stdin: Readable.from([JSON.stringify(doc)]), log: () => {}, base,
      env: { VM_SNAPSHOT_PATH: path.join(run, 'snapshot.db'), VM_FLAGS_PATH: path.join(run, 'flags.json') },
      placements: [{ challenge_key: 'C06', dir: imp, file: 'C06.placement' }, { challenge_key: 'C10', dir: mock, file: 'C10.placement' }] });
    check('the injector plants a flag for every challenge', code === 0, `exit ${code}`);
    if (code !== 0) return 1;

    // 2. the companion services, then the shop in instance mode
    const quiet = { stdio: 'ignore' };
    const sock = path.join(dir, 'import.sock');
    children.push(spawn(process.execPath, [path.join(ROOT, 'services', 'import-service', 'src', 'main.mjs')], { ...quiet, env: { ...process.env, VM_IMPORT_SOCKET: sock, VM_C06_PLACEMENT: path.join(imp, 'C06.placement') } }));
    children.push(spawn(process.execPath, [path.join(ROOT, 'services', 'mock-services', 'src', 'main.mjs')], { ...quiet, env: { ...process.env, VM_PLACEMENT_MOCK_DIR: mock } }));
    const port = await freePort();
    children.push(spawn(process.execPath, [path.join(ROOT, 'apps', 'shop', 'src', 'server.mjs')], { ...quiet, cwd: path.join(ROOT, 'apps', 'shop'), env: { ...process.env, PORT: String(port), VM_SNAPSHOT_PATH: path.join(run, 'snapshot.db'),
      VM_FLAGS_PATH: path.join(run, 'flags.json'), VM_DB_PATH: path.join(dir, 'data.db'), VM_MOCK_URL: 'http://127.0.0.1', VM_IMPORT_SOCKET: sock, VM_INSECURE_COOKIES: '1', VM_INSTANCE_ID: doc.instance_id } }));
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(`${baseUrl}/readyz`)).status === 200, 'the shop to be ready');
    await waitFor(() => portOpen(9103), 'the mock services (port 9103 free on this machine?)');
    check('the shop is ready only after the injector (instance mode) and the companions are up', true);

    // 3. each exploit, as a player runs it
    const results = {};
    for (const key of only) {
      // the import service listens on a unix socket and its protocol needs half-close, which Windows cannot give (the repo's own tests skip for the same reason); use --docker
      if (key === 'C06' && process.platform === 'win32') { console.log('SKIP  C06: needs a unix socket; run `node scripts/e2e-local-flags.mjs --docker`'); continue; }
      const ex = await loadExploit(key);
      if (!ex) { check(`${key}: an exploit for this challenge exists`, false, 'no exploit module'); continue; }
      const found = new Set(); let held = false; let detail = '';
      try { await ex.fn({ baseUrl, fetch: recordingFetch(found), signal: AbortSignal.timeout(120000) }); held = true; } catch (e) { detail = `${e.name}: ${String(e.message).slice(0, 160)}`; }
      check(`${key}: the exploit works (${ex.file})`, held, held ? '' : detail);
      const mine = found.has(flags[key]);
      const foreign = [...found].filter((f) => f !== flags[key] && Object.values(flags).includes(f));
      check(`${key}: the flag planted for this challenge comes back in the responses`, mine, mine ? '' : `${found.size} flag-shaped value(s), none is this challenge's`);
      check(`${key}: no flag of another challenge comes back`, foreign.length === 0, foreign.length ? `${foreign.length} foreign flag(s)` : '');
      results[key] = { held, ownFlag: mine, foreign: foreign.length };
    }
    const failed = rows.filter((r) => !r.ok);
    console.log(`\n${rows.length - failed.length} PASS, ${failed.length} FAIL`);
    if (o.json) fs.writeFileSync(o.json, `${JSON.stringify({ at: new Date().toISOString(), results, rows }, null, 2)}\n`);
    return failed.length ? 1 : 0;
  } finally {
    stop();
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
