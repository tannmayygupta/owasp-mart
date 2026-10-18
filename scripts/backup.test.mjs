import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COUNT_SQL, SCRATCH_DB, backupFileName, buildManifest, checkIntegrity, compareCounts, createdbArgs, dropdbArgs, dumpArgs,
  insideRepo, opensslArgs, parseArgs, parseCounts, parseShaFile, restoreArgs, sha256Buf, sidecarPaths, utcStamp,
} from './backup.mjs';

test('parseArgs: commands, defaults and errors', () => {
  const o = parseArgs(['backup', '--out', 'x', '--pass-file', 'p']);
  assert.equal(o.cmd, 'backup');
  assert.equal(o.container, 'vulnmart-postgres');
  assert.match(parseArgs(['backup', '--out', 'x']).error, /Missing --pass-file/);
  assert.match(parseArgs(['restore-test', '--pass-file', 'p']).error, /Missing --file/);
  assert.match(parseArgs(['nope']).error, /Unknown or missing command/);
  assert.match(parseArgs(['verify', '--bogus', '1']).error, /Unknown option/);
  assert.match(parseArgs(['verify', '--file']).error, /needs a value/);
  assert.equal(parseArgs(['verify', '--file', 'f']).file, 'f');
});

test('utcStamp and file name', () => {
  assert.equal(utcStamp(new Date('2026-10-17T09:05:07.123Z')), '20261017T090507Z');
  assert.equal(backupFileName(new Date('2026-10-17T09:05:07Z')), 'vulnmart-20261017T090507Z.dump.enc');
});

test('insideRepo', () => {
  assert.equal(insideRepo('/r/a', '/r'), true);
  assert.equal(insideRepo('/r', '/r'), true);
  assert.equal(insideRepo('/other/a', '/r'), false);
  assert.equal(insideRepo('/r/../x', '/r'), false);
});

test('opensslArgs: AES-256, PBKDF2, 600000 iterations, pass phrase only from a file', () => {
  const a = opensslArgs('encrypt', '/p/pass.txt');
  assert.deepEqual(a.slice(0, 7), ['enc', '-e', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-salt']);
  assert.deepEqual(a.slice(-2), ['-pass', 'file:/p/pass.txt']);
  assert.equal(opensslArgs('decrypt', 'f')[1], '-d');
  assert.throws(() => opensslArgs('x', 'f'));
  assert.ok(!a.some((x) => /^pass:/.test(x)), 'never -pass pass:<value>');
});

test('docker command construction', () => {
  const o = { container: 'c1', user: 'u1', db: 'd1' };
  assert.deepEqual(dumpArgs(o), ['exec', 'c1', 'pg_dump', '-Fc', '-U', 'u1', 'd1']);
  assert.deepEqual(createdbArgs(o).slice(-1), [SCRATCH_DB]);
  assert.deepEqual(dropdbArgs(o).slice(-1), [SCRATCH_DB]);
  assert.ok(restoreArgs(o).includes(SCRATCH_DB));
  assert.ok(!restoreArgs(o).includes('d1'), 'restore never targets the real database');
  assert.match(COUNT_SQL, /query_to_xml/);
});

test('parseCounts', () => {
  assert.deepEqual(parseCounts('public.a|3\npublic.b|0\n'), { 'public.a': 3, 'public.b': 0 });
  assert.deepEqual(parseCounts(''), {});
  assert.throws(() => parseCounts('garbage'), /unreadable/);
});

test('compareCounts', () => {
  assert.equal(compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 }).ok, true);
  const bad = compareCounts({ a: 1, b: 2 }, { a: 1, b: 3 });
  assert.equal(bad.ok, false);
  assert.match(bad.diffs[0], /b: manifest 2, restored 3/);
  assert.match(compareCounts({ a: 1 }, {}).diffs[0], /missing after restore/);
  assert.match(compareCounts({}, { z: 1 }).diffs[0], /not in manifest/);
});

function sample() {
  const enc = Buffer.from('ciphertext-bytes');
  const encSha256 = sha256Buf(enc);
  const manifest = buildManifest({ createdAt: new Date('2026-10-17T00:00:00Z'), plainBytes: 5, plainSha256: 'x', encBytes: enc.length, encSha256, counts: { 'public.t': 2 } });
  return { enc, shaText: `${encSha256}  f.dump.enc\n`, manifestText: JSON.stringify(manifest) };
}

test('checkIntegrity: good, flipped byte, missing parts, mismatching manifest', () => {
  const s = sample();
  assert.equal(checkIntegrity({ encBuf: s.enc, shaText: s.shaText, manifestText: s.manifestText }).ok, true);
  const flipped = Buffer.from(s.enc);
  flipped[3] ^= 1;
  const r = checkIntegrity({ encBuf: flipped, shaText: s.shaText, manifestText: s.manifestText });
  assert.equal(r.ok, false);
  assert.match(r.reason, /checksum mismatch/);
  assert.match(checkIntegrity({ encBuf: s.enc, shaText: s.shaText, manifestText: null }).reason, /manifest missing/);
  assert.match(checkIntegrity({ encBuf: s.enc, shaText: null, manifestText: s.manifestText }).reason, /checksum file missing/);
  assert.match(checkIntegrity({ encBuf: s.enc, shaText: 'zz', manifestText: s.manifestText }).reason, /unreadable/);
  assert.match(checkIntegrity({ encBuf: s.enc, shaText: s.shaText, manifestText: '{' }).reason, /manifest unreadable/);
  const other = JSON.stringify({ ...JSON.parse(s.manifestText), encSha256: 'a'.repeat(64) });
  assert.match(checkIntegrity({ encBuf: s.enc, shaText: s.shaText, manifestText: other }).reason, /does not match/);
});

test('parseShaFile and sidecarPaths', () => {
  assert.equal(parseShaFile('A'.repeat(64) + '  f'), 'a'.repeat(64));
  assert.equal(parseShaFile('nope'), null);
  assert.deepEqual(sidecarPaths('/x/f.dump.enc'), { sha: '/x/f.dump.enc.sha256', manifest: '/x/f.dump.enc.manifest.json' });
});

// Real openssl round trip with the exact arguments the script uses (needs openssl on the PATH, like the repository's other tests).
test('openssl: round trip works, wrong pass phrase fails', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vm-backup-test-'));
  try {
    writeFileSync(path.join(dir, 'p1'), 'first-test-phrase\n');
    writeFileSync(path.join(dir, 'p2'), 'second-test-phrase\n');
    const plain = Buffer.from('PGDMP fake dump content '.repeat(100));
    const enc = spawnSync('openssl', opensslArgs('encrypt', path.join(dir, 'p1')), { input: plain });
    assert.equal(enc.status, 0);
    assert.notDeepEqual(enc.stdout, plain);
    assert.ok(enc.stdout.length >= plain.length);
    assert.equal(readFileSync(path.join(dir, 'p1'), 'utf8').includes('first'), true);
    const dec = spawnSync('openssl', opensslArgs('decrypt', path.join(dir, 'p1')), { input: enc.stdout });
    assert.equal(dec.status, 0);
    assert.deepEqual(dec.stdout, plain);
    const bad = spawnSync('openssl', opensslArgs('decrypt', path.join(dir, 'p2')), { input: enc.stdout });
    // Usually a padding error (non-zero); in the rare case it passes, the plain-hash check in restore-test still catches it.
    assert.ok(bad.status !== 0 || sha256Buf(bad.stdout) !== sha256Buf(plain));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCounts takes any table name and still refuses a line without a count (review finding D7)', () => {
  assert.deepEqual(parseCounts('public.my-table$1|7\npublic.t\u00e4ble|2\n'), { 'public.my-table$1': 7, 'public.t\u00e4ble': 2 });
  assert.throws(() => parseCounts('public.a|x'), /unreadable/);
  assert.throws(() => parseCounts('public.a'), /unreadable/);
});
