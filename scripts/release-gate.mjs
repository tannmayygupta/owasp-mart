#!/usr/bin/env node
// Release gate (T-31, FR-CHL-13/16): run every challenge's exploit self-test and
// block a release if any does not hold the pass-on-vulnerable / fail-on-fixed
// contract. Each `challenges/tests/<cNN-*>/<cNN>.test.mjs` boots the real shop in
// the vulnerable and the fixed build and asserts the exploit passes on the former
// and fails on the latter; a failing one means the weakness regressed (a fixed
// build is still exploitable) or the exploit broke — either way the release is
// blocked. Node built-ins only.
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.resolve(HERE, '..', 'challenges', 'tests');

// The per-challenge self-test folders (cNN-*), excluding the runner and _example.
export function challengeTests(dir = TESTS_DIR) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^c\d\d-/.test(d.name))
    .map((d) => {
      const key = d.name.slice(0, 3).toUpperCase(); // c01-... -> C01
      const file = path.join(dir, d.name, `${d.name.slice(0, 3)}.test.mjs`);
      return { key, dir: d.name, file };
    })
    .filter((t) => existsSync(t.file))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function main(argv = []) {
  const tests = challengeTests();
  if (tests.length === 0) {
    console.error('release-gate: no challenge self-tests found');
    return 1;
  }
  const results = [];
  for (const t of tests) {
    const r = spawnSync(process.execPath, ['--test', t.file], { encoding: 'utf8' });
    const passed = r.status === 0;
    results.push({ key: t.key, passed, detail: passed ? '' : (r.stdout || '').split('\n').filter((l) => /not ok|fail/.test(l)).slice(0, 2).join(' | ') });
    console.log(`${passed ? 'PASS' : 'FAIL'}\t${t.key}\t${t.dir}`);
    if (!passed && argv.includes('--verbose')) console.log(r.stdout);
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\nRELEASE GATE: ${results.length - failed.length}/${results.length} challenge exploit tests pass`);
  if (failed.length) {
    console.log(`BLOCKED: ${failed.map((f) => f.key).join(', ')} failed (a fixed build is still exploitable, or the exploit broke)`);
    return 1;
  }
  console.log('OK: every challenge is exploitable on its vulnerable build and safe on its fixed build');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
