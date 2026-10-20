// The host jobs of L-10 and L-24: the alert of a failed unit, the daily backup, and the operations check that reads both.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { judge, MAX_BACKUP_AGE_HOURS } from './live-ops-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = path.join(ROOT, 'infra', 'hosts');
const read = (n) => fs.readFileSync(path.join(HOSTS, n), 'utf8');
const hasSh = spawnSync('sh', ['-c', 'command -v find touch wc date']).status === 0;
const fwd = (p) => p.replace(/\\/g, '/');

test('every job unit that matters calls the alert on failure and clears it after a good run', () => {
  for (const n of ['vulnmart-certs.service', 'vulnmart-backup.service']) {
    const u = read(n);
    assert.match(u, /^OnFailure=vulnmart-alert@%n\.service$/m, `${n} alerts on failure`);
    assert.match(u, /^ExecStartPost=-\/usr\/local\/sbin\/vulnmart-alert\.sh clear %n$/m, `${n} clears the alert after a good run`);
  }
  assert.match(read('vulnmart-alert@.service'), /^ExecStart=\/usr\/local\/sbin\/vulnmart-alert\.sh fail %i$/m);
  assert.match(read('vulnmart-backup.timer'), /^Persistent=true$/m, 'a backup missed while the host was stopped runs at the next boot');
  assert.match(read('vulnmart-backup.timer'), /^OnCalendar=\*-\*-\* 02:30:00$/m);
});

test('the hooks command installs the alert on both hosts and the backup timer on vm-p only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'live-deploy.mjs'), 'utf8');
  assert.match(src, /vulnmart-alert\.sh/);
  assert.match(src, /vulnmart-alert@\.service/);
  assert.match(src, /enable --now vulnmart-backup\.timer/);
  assert.match(src, /stage\(H\.p\.pub, \[\{ local: path\.join\(ROOT, 'infra', 'hosts', 'vulnmart-backup\.sh'\)/);
});

test('the alert script leaves a file for a failure, removes it on a clear, and refuses a bad unit name', { skip: !hasSh && 'needs sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-'));
  try {
    const run = (...args) => spawnSync('sh', [fwd(path.join(HOSTS, 'vulnmart-alert.sh')), ...args], { env: { ...process.env, MARK_DIR: fwd(dir) }, encoding: 'utf8' });
    assert.equal(run('fail', 'vulnmart-certs.service').status, 0);
    assert.match(fs.readFileSync(path.join(dir, 'ALERT-vulnmart-certs.service'), 'utf8'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
    assert.equal(run('clear', 'vulnmart-certs.service').status, 0);
    assert.equal(fs.existsSync(path.join(dir, 'ALERT-vulnmart-certs.service')), false);
    assert.equal(run('fail', '../etc/passwd').status, 2);
    assert.equal(run('frobnicate', 'x').status, 2);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeDocker(dir, { failDump = false } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const body = `#!/bin/sh
# exec [-i] <container> pg_dump|pg_restore ...
shift
[ "$1" = -i ] && shift
shift
case "$1" in
  pg_dump) ${failDump ? 'echo "pg_dump: error" >&2; exit 1' : 'echo "PGDMP fake dump of $5 $4"'} ;;
  pg_restore) cat > /dev/null ;;
  *) exit 9 ;;
esac
`;
  fs.writeFileSync(path.join(bin, 'docker'), body, { mode: 0o755 });
  return bin;
}

test('the backup dumps both databases, reads each back, writes the marker and keeps only the retention window', { skip: !hasSh && 'needs sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  try {
    const bin = fakeDocker(dir);
    const backups = path.join(dir, 'b'); const marks = path.join(dir, 'm');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, 'vulnmart-20000101T000000Z.dump'), 'old');
    spawnSync('touch', ['-d', '2000-01-01', fwd(path.join(backups, 'vulnmart-20000101T000000Z.dump'))]);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BACKUP_DIR: fwd(backups), MARK_DIR: fwd(marks), KEEP_DAYS: '7' };
    const r = spawnSync('sh', [fwd(path.join(HOSTS, 'vulnmart-backup.sh')), 'run'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(backups).sort();
    assert.equal(files.filter((f) => /^vulnmart-\d{8}T\d{6}Z\.dump$/.test(f)).length, 1, 'exactly one platform dump: the old one is gone, the new one is there');
    assert.ok(files.some((f) => /^vm_keystore-\d{8}T\d{6}Z\.dump$/.test(f)), 'the key store has its own dump');
    assert.ok(!files.includes('vulnmart-20000101T000000Z.dump') && !files.some((f) => f.endsWith('.part')));
    assert.match(fs.readFileSync(path.join(marks, 'backup-ok'), 'utf8'), /^\d{8}T\d{6}Z vulnmart-\d{8}T\d{6}Z\.dump:\d+ vm_keystore-\d{8}T\d{6}Z\.dump:\d+\n$/);
    assert.equal(spawnSync('sh', [fwd(path.join(HOSTS, 'vulnmart-backup.sh')), 'verify', fwd(path.join(backups, files.find((f) => f.startsWith('vm_keystore'))))], { env, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('sh', [fwd(path.join(HOSTS, 'vulnmart-backup.sh')), 'nonsense'], { env, encoding: 'utf8' }).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failing dump fails the unit (exit 1), leaves no half file and does not refresh the marker', { skip: !hasSh && 'needs sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fail-'));
  try {
    const bin = fakeDocker(dir, { failDump: true });
    const backups = path.join(dir, 'b'); const marks = path.join(dir, 'm');
    fs.mkdirSync(marks, { recursive: true });
    fs.writeFileSync(path.join(marks, 'backup-ok'), '20260101T000000Z earlier\n');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BACKUP_DIR: fwd(backups), MARK_DIR: fwd(marks) };
    const r = spawnSync('sh', [fwd(path.join(HOSTS, 'vulnmart-backup.sh')), 'run'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.deepEqual(fs.readdirSync(backups), []);
    assert.equal(fs.readFileSync(path.join(marks, 'backup-ok'), 'utf8'), '20260101T000000Z earlier\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the operations check: an alert file, a stale backup and a missing backup are failures; a fresh backup and no alert pass', () => {
  const now = new Date('2026-10-19T10:00:00Z');
  const ok = judge({ alertsP: '', alertsI: '', backupOk: '20261019T023000Z vulnmart-x.dump:10', now });
  assert.ok(ok.every((r) => r.ok), JSON.stringify(ok));
  const alert = judge({ alertsP: 'ALERT-vulnmart-backup.service\n', alertsI: '', backupOk: '20261019T023000Z a:1', now });
  assert.equal(alert.find((r) => r.name.includes('vm-p')).ok, false);
  const stale = judge({ backupOk: '20261017T023000Z a:1', now });
  assert.equal(stale.find((r) => r.name.includes('hours old')).ok, false);
  assert.ok(MAX_BACKUP_AGE_HOURS >= 24, 'a daily job must be allowed to be a little late');
  assert.equal(judge({ backupOk: '', now }).find((r) => r.name.includes('backup')).ok, false);
  assert.equal(judge({ backupOk: '20261020T023000Z a:1', now }).find((r) => r.name.includes('hours old')).ok, false, 'a backup dated in the future is not trusted');
});