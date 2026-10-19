// Frees the instances that the end-to-end and load checks left running on the live lab (they use throwaway accounts whose address starts with "e2e-").
// Only attempts of those accounts, only in state ready or running; it cancels them, which destroys the instance at once. A real account is never touched.
//   node scripts/live-free-test-instances.mjs --ssh ubuntu@<vm-p>            list what it would free (changes nothing)
//   node scripts/live-free-test-instances.mjs --ssh ubuntu@<vm-p> --apply    free them
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SSH = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
export const PYTHON = `import os, sys
from sqlalchemy import select
from vulnmart.accounts.models import User
from vulnmart.kernel.settings import get_settings
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.kernel.services import build_ports
from vulnmart_attempts import AttemptState as S
apply = sys.argv[1] == "apply"
rt = build_lab_runtime(os.environ)
ports = build_ports(get_settings())
with ports.sessions() as session:
    ids = [u.id for u in session.scalars(select(User).where(User.email_ci.like("e2e-%")))]
found = 0
for uid in ids:
    for rec in rt.engine.for_user(uid):
        if rec.state in (S.READY, S.RUNNING):
            found += 1
            if apply:
                rt.engine.cancel(rec.id, "system:test-cleanup", "instances left by a test run")
print(("freed" if apply else "would free"), found, "attempt(s) of", len(ids), "test account(s)")
`;

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--ssh');
  const target = i >= 0 ? argv[i + 1] : '';
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(target ?? '')) { console.error('--ssh ubuntu@<vm-p address> is required'); return 2; }
  const apply = argv.includes('--apply');
  const r = spawnSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, `sudo docker exec -i vulnmart-api python - ${apply ? 'apply' : 'list'}`], { input: PYTHON, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  process.stdout.write(String(r.stdout));
  if (r.status !== 0) { process.stderr.write(`${String(r.stderr).split(/\r?\n/).slice(-4).join('\n')}\n`); return 1; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());