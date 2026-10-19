// The live proof of withdraw and undo (story L-26, FR-SES-10). A candidate attempt cannot be made through the web yet (the invite routes of stream P are missing), so
// this script makes one the way the platform will: the lab runtime of the API container creates a candidate attempt for a throwaway learner, then everything else goes
// through the real HTTP routes of the deployed site. No flag, password or address is printed.
//   node scripts/e2e-live-withdraw.mjs --base https://<platform host> --mailpit-ssh ubuntu@<vm-p> [--json file]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Client, verificationToken } from './e2e-live.mjs';

const SSH = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
const MAKE_ATTEMPT = `import os, sys, json
from vulnmart.lab.runtime import build_lab_runtime
rt = build_lab_runtime(os.environ)
s = rt.start_attempt(sys.argv[1], org_id="o-live-proof")
print(json.dumps({"attempt_id": s.attempt_id, "instance_id": s.instance_id}))
`;

const rows = [];
const check = (name, ok, detail = '') => { rows.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); return !!ok; };

async function learner(base, mailbox, label) {
  const c = new Client(base);
  const email = `e2e-${label}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}@example.test`;
  const password = `Pw-${crypto.randomBytes(9).toString('base64url')}-x`;
  const s = await c.request('POST', '/api/v1/accounts', { body: { email, password, display_name: `E2E ${label}`, age_declaration: true } });
  if (s.status !== 202) throw new Error(`sign up answered ${s.status}`);
  const token = await verificationToken(mailbox, email);
  const v = await c.request('POST', '/api/v1/accounts/verify-email', { body: { token } });
  if (v.status !== 200) throw new Error(`verify answered ${v.status}`);
  const l = await c.request('POST', '/api/v1/session', { body: { email, password } });
  if (l.status !== 200 || !l.data?.csrf_token) throw new Error(`sign in answered ${l.status}`);
  c.csrf = l.data.csrf_token;
  return { c, userId: l.data.user?.user_id };
}

export async function main(argv = process.argv.slice(2)) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!o.base || !o['mailpit-ssh']) { console.error('--base and --mailpit-ssh are required'); return 2; }
  const base = new URL(o.base).origin;
  const { c, userId } = await learner(base, o['mailpit-ssh'], 'wd');
  const { c: other } = await learner(base, o['mailpit-ssh'], 'other');
  check('two throwaway learners signed in', !!userId && /^u-/.test(userId), 'ids not printed');
  const made = spawnSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', o['mailpit-ssh'], `sudo docker exec -i vulnmart-api python - ${userId}`], { input: MAKE_ATTEMPT, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  let ids; try { ids = JSON.parse(String(made.stdout).trim().split(/\r?\n/).at(-1)); } catch { ids = null; }
  if (!check('a candidate attempt with an instance was made by the lab runtime of the API container', made.status === 0 && /^a-/.test(ids?.attempt_id ?? ''), `exit ${made.status}`)) { console.error(String(made.stderr).split(/\r?\n/).slice(-3).join(' | ')); return finish(o); }
  const { attempt_id: aid, instance_id: iid } = ids;
  const url = `/api/v1/attempts/${aid}/withdraw`;
  const a0 = (await c.request('GET', `/api/v1/attempts/${aid}`)).data;
  check('the owner reads the candidate attempt (running)', a0?.mode === 'candidate' && a0?.state === 'running', `${a0?.mode}/${a0?.state}`);
  const bad = await c.request('POST', url, { body: { confirm: false } });
  check('a withdrawal without the confirmation is refused', bad.status === 422, `HTTP ${bad.status}`);
  const foreign = await other.request('POST', url, { body: { confirm: true } });
  check('another account cannot withdraw it (404, like a missing attempt)', foreign.status === 404, `HTTP ${foreign.status}`);
  const w = await c.request('POST', url, { body: { confirm: true } });
  check('the owner withdraws: state withdrawn and a deletion date is set', w.status === 200 && w.data?.state === 'withdrawn' && !!w.data?.delete_after, `HTTP ${w.status} ${w.data?.state}`);
  let inst; for (let i = 0; i < 30; i++) { inst = (await c.request('GET', `/api/v1/instances/${iid}`)); if (inst.status !== 200 || ['stopping', 'destroyed'].includes(inst.data?.state)) break; await sleep(2000); }
  check('the instance is destroyed', inst.status === 404 || ['stopping', 'destroyed'].includes(inst.data?.state), `HTTP ${inst.status} ${inst.data?.state ?? ''}`);
  const paste = await c.request('POST', `/api/v1/attempts/${aid}/flags`, { body: { challenge_key: 'C01', flag: 'VM{NOTAFLAGNOTAFLAGNOTAFLAG1}' } });
  check('nothing is accepted after the withdrawal', paste.status === 409 || paste.status === 410, `HTTP ${paste.status} ${paste.data?.code ?? ''}`);
  const again = await c.request('POST', url, { body: { confirm: true } });
  check('withdrawing again keeps the first deletion date', again.status === 200 && again.data?.delete_after === w.data?.delete_after);
  const undo = await c.request('POST', `${url}/undo`);
  check('the undo cancels the deletion and the attempt stays withdrawn', undo.status === 200 && undo.data?.state === 'withdrawn' && undo.data?.delete_after === null, `HTTP ${undo.status} ${undo.data?.state}`);
  const last = await c.request('POST', url, { body: { confirm: true } });
  check('withdrawn again so the lab erases the throwaway attempt after the window', last.status === 200 && !!last.data?.delete_after);
  return finish(o);
}

function finish(o) {
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length} PASS, ${failed.length} FAIL`);
  if (o.json) fs.writeFileSync(o.json, `${JSON.stringify({ at: new Date().toISOString(), base: o.base, rows }, null, 2)}\n`);
  return failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => process.exit(code), (e) => { console.error(`FAIL ${e.message}`); process.exit(1); });