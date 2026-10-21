#!/usr/bin/env node
// Every challenge, attacked the way a player attacks it, against a REAL shop started the way an instance starts it, on this machine (no Docker, no platform).
//   node scripts/e2e-local-flags.mjs [--only C01,C05] [--json file] [--build vulnerable|fixed] [--deployed-script yes]
// What it does: builds the seeded snapshot, runs the real injector with a fresh flag per challenge (made here, never a real one), starts the shop in instance mode,
// the import service (C06) and the mock services (C10, C08, C11), then runs the exploit module of challenges/tests/<challenge>/ against the shop.
// For each challenge it checks: the exploit holds; the flag planted for THAT challenge came back in the responses; no flag of another challenge came back; no decoy came back
// (a decoy is planted per instance at rest, beside nothing a player reads). `--build fixed` runs the SAME instance with VM_BUILD=fixed (every challenge on its fixed code) and checks the
// other way round: the exploit FAILS, no planted flag comes back, and the milestone 2 rule is NOT satisfied by the events the attempt produced (for C09: the fixed build posts
// shop.security_event_written, so the negative observation cannot hold).
// --deployed-script yes skips that loop and instead runs scripts/verify-deployed-exploits.mjs (the T-32 script for a deployed shop) against this same instance, in the chosen build,
// so the script that will run on the instance VM is itself proven here on both builds.
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
/**
 * Did the events of an exploit satisfy a milestone rule? The rule kinds of the platform engine (apps/api/src/vulnmart/ingest/rules.py and engine.py) evaluated over the posted events in order:
 * event, any, count (group_by, sum_field, then), count_distinct and negative_window. Time is not modelled: a proof run lasts seconds, far inside the 600 s window and the 30 s grace of C09.
 * Returns 'yes' or 'no' ('flag' rules are the platform's flag check, not events: 'no').
 */
export function ruleSeen(events, rule) {
  return ruleHolds(events, rule) ? 'yes' : 'no';
}
function ruleHolds(events, rule) {
  if (!rule) return false;
  const fits = (e, r) => e.type === r.type && Object.entries(r.where ?? {}).every(([k, c]) => matchValue(e.data?.[k], c));
  switch (rule.kind) {
    case 'event': return events.some((e) => fits(e, rule));
    case 'any': return rule.of.some((x) => ruleHolds(events, x));
    case 'count_distinct': return new Set(events.filter((e) => fits(e, rule)).map((e) => e.data?.[rule.field]).filter((v) => v != null)).size >= rule.at_least;
    case 'count': {
      let pool = events;
      if (rule.then) {
        const at = events.findIndex((e) => fits(e, rule.then));
        if (at < 0) return false;
        pool = events.slice(0, at);
      }
      const hits = pool.filter((e) => fits(e, rule));
      if (rule.sum_field) return hits.reduce((s, e) => s + (Number.isInteger(e.data?.[rule.sum_field]) ? e.data[rule.sum_field] : 0), 0) >= rule.at_least;
      if (rule.group_by) {
        const g = new Map();
        for (const e of hits) g.set(e.data?.[rule.group_by], (g.get(e.data?.[rule.group_by]) ?? 0) + 1);
        return Math.max(0, ...g.values()) >= rule.at_least;
      }
      return hits.length >= rule.at_least;
    }
    case 'negative_window': {
      // an account with at_least failures, then a success, and no `absent` event for that account anywhere in the run
      const ok = (e, part) => fits(e, { type: part.type, where: part.where });
      for (let i = 0; i < events.length; i += 1) {
        if (!ok(events[i], rule.success)) continue;
        const account = events[i].data?.[rule.group_by];
        const failed = events.slice(0, i).filter((e) => ok(e, rule.failures) && e.data?.[rule.group_by] === account).length;
        const absentSeen = events.some((e) => e.type === rule.absent.type && e.data?.[rule.group_by] === account);
        if (failed >= rule.failures.at_least && !absentSeen) return true;
      }
      return false;
    }
    default: return false;
  }
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
  const build = o.build ?? 'vulnerable';
  if (!['vulnerable', 'fixed'].includes(build)) throw new Error('--build must be vulnerable or fixed');
  const fixedBuild = build === 'fixed';
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
      flags: Object.entries(flags).map(([challenge_key, flag]) => ({ challenge_key, flag })),
      // one decoy per challenge in the shop database; C06 and C10 also get a file beside their placement (H-42, H-331)
      decoys: Object.keys(CHALLENGES).flatMap((challenge_key, i) => [{ challenge_key, index: 0, value: newFlag() }, ...(['C06', 'C10'].includes(challenge_key) ? [{ challenge_key, index: 1, value: newFlag(), decoy_placement: 'service-file' }] : [])]) };
    const decoyValues = doc.decoys.map((x) => x.value);
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
      VM_FLAGS_PATH: path.join(run, 'flags.json'), VM_DB_PATH: path.join(dir, 'data.db'), VM_MOCK_URL: 'http://127.0.0.1', VM_IMPORT_SOCKET: sock, VM_INSECURE_COOKIES: '1', VM_INSTANCE_ID: doc.instance_id, VM_SIDECAR_EVENTS_URL: eventsUrl, ...(fixedBuild ? { VM_BUILD: 'fixed' } : {}) } }));
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(`${baseUrl}/readyz`)).status === 200, 'the shop to be ready');
    await waitFor(() => portOpen(9103), 'the mock services (port 9103 free on this machine?)');
    check(`the shop is ready only after the injector (instance mode) and the companions are up (build: ${build})`, true);

    if (o['deployed-script']) {
      const { main: verify } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'verify-deployed-exploits.mjs')).href);
      const skipC06 = process.platform === 'win32'; // the import service needs a unix socket (see below)
      const keys = only.filter((k) => !(skipC06 && k === 'C06'));
      const code = await verify(['--base', baseUrl, '--build', build, '--only', keys.join(',')], { log: (l) => console.log(l) });
      check(`scripts/verify-deployed-exploits.mjs agrees with the ${build} build on ${keys.length} challenges`, code === 0, `exit ${code}`);
      const failedOnly = rows.filter((r) => !r.ok);
      console.log(`\n${rows.length - failedOnly.length} PASS, ${failedOnly.length} FAIL`);
      return failedOnly.length ? 1 : 0;
    }

    // 3. each exploit, as a player runs it
    const results = {};
    for (const key of only) {
      // the import service listens on a unix socket and its protocol needs half-close, which Windows cannot give (the repo's own tests skip for the same reason); use --docker
      if (key === 'C06' && process.platform === 'win32') { console.log('SKIP  C06: needs a unix socket; run `node scripts/e2e-local-flags.mjs --docker`'); continue; }
      if (key === 'C06' && fixedBuild) { console.log('SKIP  C06: the fixed build of the import service is a different service image; challenges/tests/c06-prototype-pollution/c06.test.mjs proves it (release gate)'); continue; }
      const ex = await loadExploit(key);
      if (!ex) { check(`${key}: an exploit for this challenge exists`, false, 'no exploit module'); continue; }
      const found = new Set(); let held = false; let detail = '';
      const first = events.length;
      try { await ex.fn({ baseUrl, fetch: recordingFetch(found), signal: AbortSignal.timeout(120000) }); held = true; } catch (e) { detail = `${e.name}: ${String(e.message).slice(0, 160)}`; }
      if (fixedBuild) check(`${key}: the exploit FAILS on the fixed build (${ex.file})`, !held, held ? 'the exploit still works on the fixed build' : '');
      else check(`${key}: the exploit works (${ex.file})`, held, held ? '' : detail);
      await sleep(700); // the shop posts its events without waiting
      const posted = events.slice(first);
      const bad = posted.filter((e) => e._problems.length);
      check(`${key}: every event posted fits the event contract (${posted.length} posted)`, bad.length === 0, bad.length ? `${bad[0].type}: ${bad[0]._problems.join('; ')}` : '');
      const postedText = JSON.stringify(posted.map(({ _problems, ...e }) => e));
      const inEvents = [...Object.values(flags), ...decoyValues].filter((v) => postedText.includes(v));
      check(`${key}: no event holds a flag or a decoy value`, inEvents.length === 0, inEvents.length ? `${inEvents.length} value(s) in the events` : '');
      for (const m of ['m1', 'm2']) {
        if (EVENTS_ELSEWHERE[key]) { console.log(`SKIP  ${key}: milestone ${m.slice(1)} events come from ${EVENTS_ELSEWHERE[key]}, not from the shop`); continue; }
        if (key === 'C11' && m === 'm1') { console.log('SKIP  C11: milestone 1 (the verbose error) and milestone 2 (the fail-open) need two different registrations, and one account can register one store'); continue; }
        const seen = ruleSeen(posted, rules[key]?.[m]);
        if (fixedBuild) {
          // milestone 1 may fire on the fixed build (an attempt, by the spec); milestone 2 is working-exploit evidence and must not
          if (m === 'm2') check(`${key}: milestone 2 is NOT reached on the fixed build`, seen === 'no', seen === 'no' ? '' : `the rule ${JSON.stringify(rules[key]?.[m]).slice(0, 110)} is satisfied by the fixed build's events`);
          continue;
        }
        const ok = seen === 'yes';
        check(`${key}: the exploit produces the events that milestone ${m.slice(1)} reads`, ok,
          ok ? '' : `the rule needs ${JSON.stringify(rules[key]?.[m]).slice(0, 110)}; posted types: ${[...new Set(posted.map((e) => e.type))].join(', ') || 'none'}`);
      }
      const mine = found.has(flags[key]);
      const foreign = [...found].filter((f) => f !== flags[key] && Object.values(flags).includes(f));
      const decoysSeen = [...found].filter((f) => decoyValues.includes(f));
      if (fixedBuild) check(`${key}: no planted flag comes back on the fixed build`, ![...found].some((f) => Object.values(flags).includes(f)), '');
      else {
        check(`${key}: the flag planted for this challenge comes back in the responses`, mine, mine ? '' : `${found.size} flag-shaped value(s), none is this challenge's`);
        check(`${key}: no flag of another challenge comes back`, foreign.length === 0, foreign.length ? `${foreign.length} foreign flag(s)` : '');
      }
      check(`${key}: no decoy comes back in any response`, decoysSeen.length === 0, decoysSeen.length ? `${decoysSeen.length} decoy value(s) came back` : '');      results[key] = { held, ownFlag: mine, foreign: foreign.length, decoys: decoysSeen.length };
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
