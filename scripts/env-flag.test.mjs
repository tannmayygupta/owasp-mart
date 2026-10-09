// The environment switch rule (scripts/env-flag.mjs), and the real branch "openssl is missing" of the Node mTLS end-to-end test,
// run with a PATH that has no openssl: it must fail for CI=true or CI=1 and skip for CI=false, CI=0 and an empty CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { flagOn } from './env-flag.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E = path.join(ROOT, 'scripts', 'e2e', 'orchestrator.e2e.test.mjs');

test('only true and 1 switch a flag on', () => {
  for (const on of ['true', 'TRUE', ' true ', '1']) assert.equal(flagOn(on), true, on);
  for (const off of ['false', 'FALSE', '0', '', ' ', undefined, null, 'yes', 'on', '2']) assert.equal(flagOn(off), false, String(off));
});

// Node is started by its absolute path, and PATH is an empty temporary folder, so no openssl can be found (the folder of a system node
// may hold one). SystemRoot is kept on Windows, which node needs.
const emptyDir = mkdtempSync(path.join(tmpdir(), 'vm-no-openssl-'));
test.after(() => rmSync(emptyDir, { recursive: true, force: true }));

function envWithoutOpenssl(ci) {
  const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'].includes(k)));
  const env = { ...keep, PATH: emptyDir, VULNMART_E2E_SKIP_NESTED_PYTEST: '1' };
  if (ci !== undefined) env.CI = ci;
  return env;
}

function runTlsTestWithoutOpenssl(ci) {
  return spawnSync(process.execPath, ['--test', '--test-name-pattern=with --tls flags', E2E], { env: envWithoutOpenssl(ci), encoding: 'utf8', timeout: 120000 });
}

test('the environment of these tests really has no openssl', () => {
  const probe = spawnSync('openssl', ['version'], { env: envWithoutOpenssl('true'), encoding: 'utf8' });
  assert.ok(probe.error && probe.error.code === 'ENOENT', 'openssl was found on the restricted PATH, so the tests below prove nothing');
});

for (const ci of ['true', '1']) {
  test(`a missing openssl fails the mTLS test when CI=${ci}`, () => {
    const r = runTlsTestWithoutOpenssl(ci);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /openssl is not installed/);
  });
}
for (const ci of ['false', '0', '', undefined]) {
  test(`a missing openssl skips the mTLS test when CI=${JSON.stringify(ci)}`, () => {
    const r = runTlsTestWithoutOpenssl(ci);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# skipped 1|ℹ skipped 1/);
  });
}
