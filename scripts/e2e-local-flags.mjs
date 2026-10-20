#!/usr/bin/env node
// Every challenge, attacked the way a player attacks it, against a REAL shop started the way an instance starts it, on this machine (no Docker, no platform).
//   node scripts/e2e-local-flags.mjs [--only C01,C05] [--json file]
// What it does: builds the seeded snapshot, runs the real injector with a fresh flag per challenge (made here, never a real one), starts the shop in instance mode,
// the import service (C06) and the mock services (C10, C08, C11), then runs the exploit module of challenges/tests/<challenge>/ against the shop.
// For each challenge it checks: the exploit holds; the flag planted for THAT challenge came back in the responses; no flag of another challenge came back.
// It also stands in for the sidecar: every event the shop and the mock services post is checked against the posted-event schema of the contract
// (contracts/events/instance-events.posted.schema.json), and each exploit must produce the events the milestone rules of the platform read for milestones 1 and 2
// (apps/api/src/vulnmart/ingest/milestone_rules.json). A challenge whose events do not fit the contract, or never appear, cannot reach its milestones on the live lab.
// Not covered here (the platform's job, proved by scripts/e2e/loop.e2e.test.mjs and scripts/e2e-live-exploits.mjs): the score and the paste check.
// C03 part B (the support bot) needs the bot service and is run by challenges/tests/c03-injection/live-loop.test.mjs.
// Nothing is printed that looks like a flag.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = /VM\{[A-Z2-7]{24}\}/g;
export const CHALLENGES = {
  C01: 'c01-cross-store-order', C02: 'c02-gift-card-codes', C03: 'c03-injection', C04: 'c04-quick-refund', C05: 'c05-security-misconfig', C06: 'c06-prototype-pollution',
  C07: 'c07-auth-failures', C08: 'c08-payment-webhook', C09: 'c09-logging-failures', C10: 'c10-ssrf', C11: 'c11-kyc-failopen',
};
// Challenges whose milestone events are produced by other components (the sidecar's rule match, the support bot and the collector): covered by challenges/tests/c03-injection/live-loop.test.mjs
const EVENTS_ELSEWHERE = { C03: 'the sidecar, the support bot and the collector' };
const EXPLOIT_FILES =['exploit.live.mjs', 'exploit-a-sqli.mjs', 'exploit.mjs'];
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const newFlag = () => `VM{${Array.from(crypto.randomBytes(24), (b) => BASE32[b % 32]).join('')}}`;

const matchValue = (v, cond) => {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('in' in cond) return cond.in.includes(v);
    if ('ne' in cond) return v !== cond.ne;
    if ('nonempty' in cond) return Array.isArray(v) ? v.length > 0 : Boolean(v);
    if ('contains' in cond) return Array.isArray(v) ? v.includes(cond.contains) : String(v ?? '').includes(cond.contains);
    return false;
  }
  return v === cond;
};
const eventFits = (e, r) => e.type === r.type && Object.entries(r.where ?? {}).every(([k, c]) => matchValue(e.data?.[k], c));
/** Did the events of an exploit satisfy a milestone rule? 'yes' for a plain event rule, 'partial' when only the first condition of a counting rule is met, else 'no'. */
export function ruleSeen(events, rule) {
  if (!rule) return 'no';
  if (rule.kind === 'event') return events.some((e) => eventFits(e, rule)) ? 'yes' : 'no';
  if (rule.kind === 'any') { const r = rule.of.map((x) => ruleSeen(events, x)); return r.includes('yes') ? 'yes' : r.includes('partial') ? 'partial' : 'no'; }
  if (rule.kind === 'count' || rule.kind === 'count_distinct') return events.some((e) => eventFits(e, rule)) ? 'partial' : 'no';
  if (rule.kind === 'negative_window') return events.some((e) => eventFits(e, { type: rule.failures.type, where: rule.failures.where })) ? 'partial' : 'no';
  return 'no';
}

const rows = [];
const check =(name, ok, detail = '') => { rows.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); return !!ok; };

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

    // 2. a stand-in for the sidecar's event door, then the companion services and the shop in instance mode
    const events = []; const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
    const validatePosted = ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'events', 'instance-events.posted.schema.json'), 'utf8')));
    const sink = http.createServer((req, res) => {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        if (body) events.push({ ...body, _problems: validatePosted(body) ? [] : validatePosted.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).slice(0, 3) });
        res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"status":"accepted"}');
      });
    });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const eventsUrl = `http://127.0.0.1:${sink.address().port}`;
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'api', 'src', 'vulnmart', 'ingest', 'milestone_rules.json'), 'utf8')).challenges;
    children.push({ kill: () => sink.close() });
    const quiet = { stdio: 'ignore' };
    const sock = path.join(dir, 'import.sock');
    children.push(spawn(process.execPath, [path.join(ROOT, 'services', 'import-service', 'src', 'main.mjs')], { ...quiet, env: { ...process.env, VM_IMPORT_SOCKET: sock, VM_C06_PLACEMENT: path.join(imp, 'C06.placement') } }));
    children.push(spawn(process.execPath, [path.join(ROOT, 'services', 'mock-services', 'src', 'main.mjs')], { ...quiet, env: { ...process.env, VM_PLACEMENT_MOCK_DIR: mock, VM_SIDECAR_EVENTS_URL: eventsUrl, VM_INSTANCE_ID: doc.instance_id } }));
    const port = await freePort();
    children.push(spawn(process.execPath, [path.join(ROOT, 'apps', 'shop', 'src', 'server.mjs')], { ...quiet, cwd: path.join(ROOT, 'apps', 'shop'), env: { ...process.env, PORT: String(port), VM_SNAPSHOT_PATH: path.join(run, 'snapshot.db'),
      VM_FLAGS_PATH: path.join(run, 'flags.json'), VM_DB_PATH: path.join(dir, 'data.db'), VM_MOCK_URL: 'http://127.0.0.1', VM_IMPORT_SOCKET: sock, VM_INSECURE_COOKIES: '1', VM_INSTANCE_ID: doc.instance_id, VM_SIDECAR_EVENTS_URL: eventsUrl } }));
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
      const first = events.length;
      try { await ex.fn({ baseUrl, fetch: recordingFetch(found), signal: AbortSignal.timeout(120000) }); held = true; } catch (e) { detail = `${e.name}: ${String(e.message).slice(0, 160)}`; }
      check(`${key}: the exploit works (${ex.file})`, held, held ? '' : detail);
      await sleep(700); // the shop posts its events without waiting
      const posted = events.slice(first);
      const bad = posted.filter((e) => e._problems.length);
      check(`${key}: every event posted fits the event contract (${posted.length} posted)`, bad.length === 0, bad.length ? `${bad[0].type}: ${bad[0]._problems.join('; ')}` : '');
      for (const m of ['m1', 'm2']) {
        if (EVENTS_ELSEWHERE[key]) { console.log(`SKIP  ${key}: milestone ${m.slice(1)} events come from ${EVENTS_ELSEWHERE[key]}, not from the shop`); continue; }
        if (key === 'C11' && m === 'm1') { console.log('SKIP  C11: milestone 1 (the verbose error) and milestone 2 (the fail-open) need two different registrations, and one account can register one store'); continue; }
        const seen = ruleSeen(posted, rules[key]?.[m]);
        const ok = seen !== 'no';
        check(`${key}: the exploit produces the event that milestone ${m.slice(1)} reads${seen === 'partial' ? ' (first condition only; the counting is the platform\'s)' : ''}`, ok,
          ok ? '' : `the rule needs ${JSON.stringify(rules[key]?.[m]).slice(0, 110)}; posted types: ${[...new Set(posted.map((e) => e.type))].join(', ') || 'none'}`);
      }
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
