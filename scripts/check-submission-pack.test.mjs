import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REQUIRED, checkDir, checkFile, exitCodeOf, main, realIo, runChecks, scanPack, scanText } from './check-submission-pack.mjs';

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'vm-pack-'));
}
const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const long = (n) => 'word '.repeat(n);

function fullPack(root) {
  for (const it of REQUIRED) {
    if (it.kind === 'file') put(root, it.path, long(Math.ceil(it.min / 4)));
  }
  for (let i = 1; i <= 10; i++) put(root, `docs/adr/${String(i).padStart(4, '0')}-x.md`, 'adr');
  for (let i = 1; i <= 10; i++) put(root, `docs/dev-log/2026-10-${String(10 + i)}-a-b.md`, 'log');
  for (let i = 1; i <= 5; i++) put(root, `docs/assets/s${i}/out.txt`, 'out');
}

test('a complete synthetic pack passes', () => {
  const root = tmp();
  try {
    fullPack(root);
    const rows = runChecks(root, realIo);
    assert.deepEqual(rows.filter((r) => r.status !== 'PASS'), []);
    assert.equal(exitCodeOf(rows, scanPack(root, realIo).hits), 0);
    assert.equal(main(['--root', root]), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing, empty, too short and short folders are FAIL with the path named', () => {
  const root = tmp();
  try {
    fullPack(root);
    rmSync(path.join(root, 'initial.md'));
    put(root, 'CHANGELOG.md', '   \n  ');
    put(root, 'docs/traceability.md', 'tiny');
    rmSync(path.join(root, 'docs/adr/0001-x.md'));
    const rows = runChecks(root, realIo);
    const f = Object.fromEntries(rows.filter((r) => r.status === 'FAIL').map((r) => [r.name, r.detail]));
    assert.match(f['source of truth (decision log, open questions)'], /missing: initial\.md/);
    assert.match(f.changelog, /empty: CHANGELOG\.md/);
    assert.match(f['traceability matrix'], /too short/);
    assert.match(f['decision records (ADRs)'], /9 matching file\(s\)/);
    assert.equal(Object.keys(f).length, 4);
    assert.equal(main(['--root', root]), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty file inside a folder fails the folder; a missing folder fails', () => {
  const root = tmp();
  try {
    fullPack(root);
    put(root, 'docs/adr/0003-x.md', '');
    assert.match(checkDir(REQUIRED.find((r) => r.path === 'docs/adr'), root, realIo).detail, /1 empty file/);
    rmSync(path.join(root, 'docs/assets'), { recursive: true });
    assert.match(checkDir(REQUIRED.find((r) => r.path === 'docs/assets'), root, realIo).detail, /missing folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('secret scan: finds real-looking secrets, ignores the fake development values', () => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const hits = scanText('f.md', ['ok line', `key ${key}`, '-----BEGIN ' + 'RSA PRIVATE KEY-----', 'flag VM{' + 'abcdefgh12345678abcd}', 'password: ' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7', 'token ghp_' + 'a'.repeat(30)].join('\n'));
  assert.deepEqual(hits.map((h) => [h.line, h.kind]), [
    [2, 'AWS access key id'], [3, 'private key block'], [4, 'real-looking flag value'], [5, 'secret assignment with a long random value'], [6, 'GitHub token'],
  ]);
  assert.deepEqual(scanText('f.md', 'POSTGRES_PASSWORD: vulnmart-dev-only-not-a-secret\nflag format VM{...}\nfake flag VM{' + 'A'.repeat(24) + '}\npassword: changeme\nsecret: <hex>'), []);
  assert.ok(!JSON.stringify(hits).includes(key), 'the matched value is never reported');
});

test('a secret in a scanned doc makes the pack fail', () => {
  const root = tmp();
  try {
    fullPack(root);
    put(root, 'docs/runbooks/oops.md', 'key ' + 'AKIA' + 'ABCDEFGHIJKLMNOP');
    const scan = scanPack(root, realIo);
    assert.equal(scan.hits.length, 1);
    assert.equal(scan.hits[0].file, 'docs/runbooks/oops.md');
    assert.equal(main(['--root', root]), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkFile and arguments', () => {
  const root = tmp();
  try {
    put(root, 'a.md', 'x y z');
    assert.equal(checkFile({ name: 'a', path: 'a.md', min: 3 }, root, realIo).status, 'PASS');
    assert.equal(checkFile({ name: 'a', path: 'a.md', min: 50 }, root, realIo).status, 'FAIL');
    assert.equal(main(['--bogus']), 2);
    assert.equal(main(['--root']), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
