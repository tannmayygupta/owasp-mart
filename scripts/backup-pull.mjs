// The off-host copy of the platform backups (L-24): pulls the newest dump of each database from vm-p to this computer, over SSH. The copy goes to a folder OUTSIDE the
// repository (default ~/.vulnmart-deploy/<env>/backups); each file is checked (non-empty, starts with the PostgreSQL custom-format magic PGDMP) before it is kept.
// The key store dump holds only wrapped keys: keep it apart from the secrets folder that holds the key encryption key.
//   node scripts/backup-pull.mjs --ssh ubuntu@<vm-p> [--to <folder>] [--keep 14]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SSH = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
export const DATABASES = ['vulnmart', 'vm_keystore'];
const FILE = /^(vulnmart|vm_keystore)-(\d{8}T\d{6}Z)\.dump$/;

/** Pure: from a listing of file names, the newest dump of each database (the stamp sorts as text). */
export function newest(names) {
  const best = {};
  for (const n of names) {
    const m = FILE.exec(n.trim());
    if (m && (!best[m[1]] || m[2] > best[m[1]].stamp)) best[m[1]] = { name: n.trim(), stamp: m[2] };
  }
  return DATABASES.map((d) => best[d]?.name).filter(Boolean);
}

/** Pure: a dump is kept only when it has content and the PostgreSQL custom-format header. */
export function looksLikeDump(buf) { return Buffer.isBuffer(buf) && buf.length > 64 && buf.subarray(0, 5).toString('latin1') === 'PGDMP'; }

/** Pure: which local files to delete so that only the newest `keep` of each database stay. */
export function toPrune(names, keep) {
  const out = [];
  for (const d of DATABASES) {
    const mine = names.filter((n) => n.startsWith(`${d}-`) && FILE.test(n)).sort().reverse();
    out.push(...mine.slice(keep));
  }
  return out;
}

function run(target, command) {
  const r = spawnSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, command], { encoding: null, maxBuffer: 512 * 1024 * 1024, windowsHide: true, timeout: 600000 });
  if (r.status !== 0) throw new Error(`ssh failed: ${String(r.stderr).split(/\r?\n/)[0]}`);
  return r.stdout;
}

export function main(argv = process.argv.slice(2)) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(a.ssh ?? '')) { console.error('--ssh ubuntu@<vm-p address> is required'); return 2; }
  const keep = Number(a.keep ?? 14);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) { console.error('--keep is a whole number from 1 to 365'); return 2; }
  const to = path.resolve(a.to ?? path.join(os.homedir(), '.vulnmart-deploy', 'prod', 'backups'));
  fs.mkdirSync(to, { recursive: true });
  try {
    const listing = run(a.ssh, 'sudo ls /var/backups/vulnmart').toString('utf8').split(/\r?\n/);
    const wanted = newest(listing);
    if (wanted.length !== DATABASES.length) throw new Error(`the host has no dump of every database (found: ${wanted.join(', ') || 'none'})`);
    for (const name of wanted) {
      const dest = path.join(to, name);
      if (fs.existsSync(dest)) { console.log(`have  ${name}`); continue; }
      const data = run(a.ssh, `sudo cat /var/backups/vulnmart/${name}`);
      if (!looksLikeDump(data)) throw new Error(`${name} does not look like a PostgreSQL dump (${data.length} bytes); nothing was kept`);
      fs.writeFileSync(`${dest}.part`, data, { mode: 0o600 });
      fs.renameSync(`${dest}.part`, dest);
      console.log(`PASS  copied ${name} (${data.length} bytes)`);
    }
    for (const n of toPrune(fs.readdirSync(to), keep)) { fs.rmSync(path.join(to, n)); console.log(`pruned ${n}`); }
  } catch (e) { console.error(`FAIL ${e.message}`); return 1; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());