import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { make, parseArgs } from './deploy-secrets.mjs';

const okArgs = (extra = []) => ['--out', path.join(os.tmpdir(), 'vm-secrets-x'), '--vmi-ip', '10.0.2.10', '--vmp-ip', '10.0.1.10', ...extra];
const opensslOk = spawnSync('openssl', ['version']).status === 0;

test('arguments: both addresses and an output folder outside the repository are required', () => {
  assert.equal(parseArgs(okArgs()).days, 60);
  assert.match(parseArgs(['--out', os.tmpdir()]).error, /IPv4/);
  assert.match(parseArgs(['--vmi-ip', '10.0.2.10', '--vmp-ip', '10.0.1.10']).error, /--out/);
  assert.match(parseArgs(okArgs(['--days', '0'])).error, /whole number/);
  assert.match(parseArgs(okArgs(['--nope'])).error, /unknown/);
  assert.match(parseArgs(['--out', path.join(process.cwd(), 'tmp-secrets'), '--vmi-ip', '10.0.2.10', '--vmp-ip', '10.0.1.10']).error, /outside the repository/);
  assert.match(parseArgs(['--out', os.tmpdir(), '--vmi-ip', '999.1.1.1', '--vmp-ip', '10.0.1.10']).error, /IPv4/);
});

test('the certificates chain to one CA, carry the addresses and the right usages, and every key is fresh and long enough', { skip: !opensslOk }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-secrets-'));
  try {
    const r = make({ out: path.join(dir, 'o'), vmiIp: '10.0.2.10', vmpIp: '10.0.1.10', days: 5, force: false });
    const pki = path.join(dir, 'o', 'pki');
    for (const leaf of ['orch', 'ingest', 'client']) {
      const v = spawnSync('openssl', ['verify', '-CAfile', path.join(pki, 'ca.pem'), path.join(pki, `${leaf}.pem`)], { encoding: 'utf8' });
      assert.equal(v.status, 0, v.stdout + v.stderr);
    }
    const text = (f) => spawnSync('openssl', ['x509', '-in', path.join(pki, f), '-noout', '-text'], { encoding: 'utf8' }).stdout;
    assert.match(text('orch.pem'), /IP Address:10\.0\.2\.10/);
    assert.match(text('orch.pem'), /TLS Web Server Authentication/);
    assert.match(text('ingest.pem'), /IP Address:10\.0\.1\.10/);
    assert.match(text('client.pem'), /TLS Web Client Authentication/);
    assert.match(text('ca.pem'), /CA:TRUE/);
    assert.match(text('ca.pem'), /Certificate Sign/);
    const keys = path.join(dir, 'o', 'keys');
    const values = fs.readdirSync(keys).filter((n) => n !== 'gate_key_previous').map((n) => fs.readFileSync(path.join(keys, n), 'utf8'));
    assert.equal(new Set(values).size, values.length, 'no two secrets are equal');
    for (const n of ['platform_key', 'report_key', 'gate_key_current', 'gate_admin_secret', 'origin_secret', 'csrf_secret']) assert.match(fs.readFileSync(path.join(keys, n), 'utf8'), /^[0-9a-f]{64}$/, n);
for (const n of ['event_master', 'flag_key', 'owner_key']) assert.equal(Buffer.from(fs.readFileSync(path.join(keys, n), 'utf8'), 'base64url').length, 32, n);
assert.match(fs.readFileSync(path.join(keys, 'kek'), 'utf8'), /^1:[A-Za-z0-9_-]{43}$/);
assert.match(fs.readFileSync(path.join(keys, 'keystore_password'), 'utf8'), /^[0-9a-f]{48}$/);
    assert.equal(fs.readFileSync(path.join(keys, 'gate_key_previous'), 'utf8'), '');
    assert.ok(r.pki.includes('ca.key') && r.keys.includes('pg_app_password'));
    assert.throws(() => make({ out: path.join(dir, 'o'), vmiIp: '10.0.2.10', vmpIp: '10.0.1.10', days: 5, force: false }), /not empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});