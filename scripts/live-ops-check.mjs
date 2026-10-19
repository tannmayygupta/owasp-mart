// The operations check of the live hosts (L-10, L-24): read-only. Does what a person on call would do every morning, in one command.
//   node scripts/live-ops-check.mjs --p ubuntu@<vm-p> --i ubuntu@<vm-i> --platform <name> --labs <name>
// PASS lines and a FAIL line for: no alert file (a failed certificate renewal or backup leaves ALERT-<unit> in /var/lib/vulnmart), a backup on vm-p not older than 26
// hours, and both certificates (platform name, a name under the labs zone) with at least MIN_DAYS days left. Exit 0 when every check passes, 1 otherwise, 2 usage.
import { spawnSync } from 'node:child_process';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const SSH = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
export const MIN_DAYS = 20;
export const MAX_BACKUP_AGE_HOURS = 26;
const TARGET = /^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/;
const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Pure: the alert files listed by `ls` and the content of backup-ok -> check rows. `now` is a Date. */
export function judge({ alertsP = '', alertsI = '', backupOk = '', now = new Date() }) {
  const rows = [];
  const files = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^ALERT-/.test(l));
  for (const [host, text] of [['vm-p', alertsP], ['vm-i', alertsI]]) {
    const f = files(text);
    rows.push({ name: `no alert file on ${host}`, ok: f.length === 0, detail: f.length ? f.join(', ') : 'none' });
  }
  const m = /^(\d{8}T\d{6}Z)\b/.exec(String(backupOk).trim());
  if (!m) rows.push({ name: 'a backup of the platform databases exists on vm-p', ok: false, detail: 'no backup-ok marker' });
  else {
    const s = m[1];
    const at = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
    const hours = (now - at) / 3600000;
    rows.push({ name: `the newest backup is at most ${MAX_BACKUP_AGE_HOURS} hours old`, ok: hours >= 0 && hours <= MAX_BACKUP_AGE_HOURS, detail: `${hours.toFixed(1)} hours` });
  }
  return rows;
}

/** Days until the certificate that a TLS server answers for `servername` expires (the real handshake, nothing is sent). */
export function certDays(host, servername, now = Date.now()) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername, rejectUnauthorized: true, timeout: 15000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(Math.floor((Date.parse(c.valid_to) - now) / 86400000));
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
  });
}

function ssh(target, command) {
  const r = spawnSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, command], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(`ssh to ${target.split('@')[0]}@host failed: ${String(r.stderr).split(/\r?\n/)[0]}`);
  return r.stdout;
}

export async function main(argv = process.argv.slice(2)) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!TARGET.test(a.p ?? '') || !TARGET.test(a.i ?? '') || !NAME.test(a.platform ?? '') || !NAME.test(a.labs ?? '')) {
    console.error('usage: node scripts/live-ops-check.mjs --p ubuntu@<vm-p> --i ubuntu@<vm-i> --platform <platform name> --labs <labs zone>');
    return 2;
  }
  let rows;
  try {
    const list = "sudo sh -c 'ls /var/lib/vulnmart 2>/dev/null | grep ^ALERT- || true'";
    rows = judge({ alertsP: ssh(a.p, list), alertsI: ssh(a.i, list), backupOk: ssh(a.p, "sudo cat /var/lib/vulnmart/backup-ok 2>/dev/null || true") });
    for (const [label, host] of [['platform certificate', a.platform], ['labs certificate', `i-check.${a.labs}`]]) {
      const d = await certDays(host, host); // the labs wildcard name resolves to vm-i, whose gate answers the handshake with the wildcard certificate
      rows.push({ name: `the ${label} has at least ${MIN_DAYS} days left`, ok: d >= MIN_DAYS, detail: `${d} days` });
    }
  } catch (e) { console.error(`FAIL ${e.message}`); return 1; }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
  return rows.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());