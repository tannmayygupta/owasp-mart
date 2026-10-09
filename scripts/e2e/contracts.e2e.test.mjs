// End-to-end tests for the instance contract (IF-6) and its command-line check, run the way CI and a developer run them.
// Run: node --test "scripts/e2e/contracts.e2e.test.mjs"   (needs pnpm and network or a warm pnpm store for the fresh-checkout test)
// Node built-ins only. Temporary copies live under the OS temp folder and are removed afterwards.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = path.join(ROOT, 'scripts', 'validate-contracts.mjs');
const temps = [];
const tmp = (label) => {
  const d = mkdtempSync(path.join(os.tmpdir(), `vm-e2e-${label}-`));
  temps.push(d);
  return d;
};
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// A nested `node --test` must not inherit NODE_TEST_CONTEXT, or it behaves as a child of this run and prints no summary.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 300000, env: cleanEnv, shell: process.platform === 'win32' && cmd === 'pnpm', ...opts });
const runCheck = (dir, ...extra) => run(process.execPath, [CHECK, ...(dir ? ['--dir', dir] : []), ...extra]);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

// A copy of contracts/instance that a test may break.
function contractCopy(label) {
  const dir = path.join(tmp(label), 'instance');
  cpSync(path.join(ROOT, 'contracts', 'instance'), dir, { recursive: true });
  return dir;
}

test('fresh checkout parity: install with a frozen lockfile, then the CI scripts job command passes', () => {
  const copy = path.join(tmp('fresh'), 'repo');
  mkdirSync(copy, { recursive: true });
  // tracked files plus new files that are not ignored: what a pull request would contain
  const list = run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT }).stdout.split(/\r?\n/).filter(Boolean);
  for (const f of list) {
    const from = path.join(ROOT, f);
    if (!existsSync(from)) continue; // deleted on disk but still in the index
    const to = path.join(copy, f);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to);
  }
  assert.ok(!existsSync(path.join(copy, 'node_modules')), 'the copy must start without node_modules');
  const install = run('pnpm', ['install', '--frozen-lockfile'], { cwd: copy });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const tests = run(process.execPath, ['--test', 'scripts/*.test.mjs'], { cwd: copy });
  assert.equal(tests.status, 0, tests.stdout.slice(-3000) + tests.stderr.slice(-1000));
  const ran = Number((tests.stdout.match(/^(?:#|ℹ) tests (\d+)/m) || [])[1]);
  assert.ok(ran >= 30, `the CI scripts job command must run the real unit tests, ran ${ran}`);
  // the CI scripts job also runs the Python tests (needs uv and a lockfile that matches)
  const py = run('uv', ['run', '--locked', '--package', 'vulnmart-api', 'pytest', '-q'], { cwd: copy });
  assert.equal(py.status, 0, py.stdout.slice(-3000) + py.stderr.slice(-1000));
  assert.match(py.stdout, /\d+ passed/);
  const check = run('pnpm', ['run', 'contracts:check'], { cwd: copy });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /checked 3 schemas, \d+ valid and \d+ invalid examples/);
  assert.match(check.stdout, /contracts: PASS/);
  assert.match(check.stdout, /orchestrator contract: checked 8 operations, \d+ valid and \d+ invalid examples/);
  assert.match(check.stdout, /orchestrator contract: PASS/);
  // the same command also checks the event contract (IF-4)
  assert.match(check.stdout, /checked 1 schema, 29 event types, 29 valid events, \d+ signed envelopes, \d+ valid posted bodies and \d+ invalid examples/);
  assert.match(check.stdout, /events: PASS/);
});

test('pnpm run contracts:check passes in the real repository and prints the counts of both contracts', () => {
  const r = run('pnpm', ['run', 'contracts:check'], { cwd: ROOT });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /checked 3 schemas, \d+ valid and \d+ invalid examples/);
  assert.match(r.stdout, /contracts: PASS/);
  assert.match(r.stdout, /orchestrator contract: PASS/);
  assert.match(r.stdout, /checked 1 schema, 29 event types, 29 valid events, \d+ signed envelopes, \d+ valid posted bodies and \d+ invalid examples/);
  assert.match(r.stdout, /events: PASS/);
});

test('pnpm run events:check passes alone, and validate-events exits 1 on a broken copy of the event contract', () => {
  const ok = run('pnpm', ['run', 'events:check'], { cwd: ROOT });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /events: PASS/);
  // break a copy of the event contract: drop a type from the schema but keep it in the catalogue
  const dir = path.join(tmp('events'), 'events');
  cpSync(path.join(ROOT, 'contracts', 'events'), dir, { recursive: true });
  const file = path.join(dir, 'instance-events.schema.json');
  const s = readJson(file);
  s.properties.type.enum = s.properties.type.enum.filter((t) => t !== 'order.paid');
  writeJson(file, s);
  const r = run(process.execPath, [path.join(ROOT, 'scripts', 'validate-events.mjs'), '--dir', dir]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /order\.paid/);
  assert.match(r.stdout, /events: FAIL/);
});

test('the fake ingest runs as a command and answers a signed event over HTTP', async () => {
  const { spawn } = await import('node:child_process');
  const { signEvent, TEST_KEY } = await import('../../contracts/mocks/fake-ingest/sign.mjs');
  const server = path.join(ROOT, 'contracts', 'mocks', 'fake-ingest', 'server.mjs');
  const child = spawn(process.execPath, [server, '--key', TEST_KEY, '--port', '0', '--host', '127.0.0.1'], { env: cleanEnv });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('fake ingest did not start: ' + out)), 15000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/127\.0\.0\.1:(\d+)\//);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
      child.on('exit', (c) => reject(new Error(`fake ingest exited with ${c}: ${out}`)));
    });
    const ev = readJson(path.join(ROOT, 'contracts', 'events', 'examples', 'valid', 'instance-events', 'proxy.request.json'));
    const s = signEvent(TEST_KEY, ev);
    const url = `http://127.0.0.1:${port}/internal/v1/events`;
    assert.equal((await fetch(url, { method: 'POST', headers: s.headers, body: s.body })).status, 202);
    assert.equal((await fetch(url, { method: 'POST', headers: s.headers, body: s.body })).status, 200);
    const altered = JSON.stringify({ ...JSON.parse(s.body), ts: '2026-05-05T05:05:05Z' });
    assert.notEqual(altered, s.body, 'the tampered body must differ');
    assert.equal((await fetch(url, { method: 'POST', headers: s.headers, body: altered })).status, 401);
  } finally {
    child.removeAllListeners('exit');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  const bad = run(process.execPath, [server]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--key is required/);
});

test('breaking a rule exits 1: removing epoch from the injection schema', () => {
  const dir = contractCopy('epoch');
  const file = path.join(dir, 'injection-document.schema.json');
  const schema = readJson(file);
  assert.ok(schema.required.includes('epoch'), 'precondition: epoch is required');
  schema.required = schema.required.filter((k) => k !== 'epoch');
  writeJson(file, schema);
  const r = runCheck(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /FAIL/);
  assert.match(r.stdout, /contracts: FAIL/);
});

test('breaking a rule exits 1: the injector and the shop use different /run/vm volumes', () => {
  const dir = contractCopy('volumes');
  const file = path.join(dir, 'examples', 'valid', 'instance-template', 'shop-template.json');
  const tpl = readJson(file);
  const injector = tpl.components.find((c) => c.role === 'injector');
  const mount = injector.mounts.find((m) => m.target === '/run/vm');
  assert.ok(mount, 'precondition: the injector mounts /run/vm');
  mount.source = tpl.volumes.map((v) => v.name).find((n) => n !== mount.source);
  writeJson(file, tpl);
  const r = runCheck(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /shop-template\.json/);
});

test('breaking a rule exits 1: a real-looking flag in an example', () => {
  const dir = contractCopy('flag');
  const file = path.join(dir, 'examples', 'valid', 'injection-document', 'full.json');
  const doc = readJson(file);
  doc.flags[0].value = 'VM{K7Q2M4ZPX3R5T6V7W2A3B4C5}';
  writeJson(file, doc);
  const r = runCheck(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /FAIL/);
});

test('usage: --help exits 0, an unknown argument exits 2, a missing folder fails with exit 1', () => {
  const help = runCheck(null, '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/validate-contracts\.mjs/);
  const bad = run(process.execPath, [CHECK, '--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown argument/);
  const missing = runCheck(path.join(os.tmpdir(), 'vm-e2e-this-folder-does-not-exist'));
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /contracts: FAIL/);
});

test('the contract document has sections 1 to 11 in order and an open-points table', () => {
  const text = readFileSync(path.join(ROOT, 'contracts', 'instance', 'instance-contract.md'), 'utf8');
  const numbered = [...text.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const at = text.indexOf('## Open points (to confirm)');
  assert.ok(at > text.lastIndexOf('## 11. '), 'the open-points table comes after section 11');
  const rows = text.slice(at).split(/\r?\n/).filter((l) => /^\| \d+ \|/.test(l));
  assert.ok(rows.length >= 20, `open-points rows: ${rows.length}`);
  assert.doesNotMatch(text, /^﻿/, 'no byte-order mark');
});
