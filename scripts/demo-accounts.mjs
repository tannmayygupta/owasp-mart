// Confirmed demo accounts for the live site (the lab on vm-p and vm-i), for people who must sign in without a mailbox.
//   node scripts/demo-accounts.mjs --base https://<platform host> --mailpit-ssh ubuntu@<vm-p address> --out <file outside the repository> [--count 3] [--prefix demo]
// Why: the platform sends its confirmation mail to Mailpit on vm-p (private; there is no mail provider key yet), so a person who signs up by themselves never receives it.
// This signs the accounts up the normal way, reads the confirmation mail over ssh, confirms them and writes `email password` lines to the file (mode 0600). It prints the
// e-mail addresses and the file name, never a password. Run it again with another --prefix for more accounts; an address that exists is reported and skipped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, verificationToken } from './e2e-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const o = { count: 3, prefix: 'demo' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--base') o.base = need().replace(/\/$/, '');
    else if (a === '--mailpit-ssh') o.mailpit = need();
    else if (a === '--out') o.out = need();
    else if (a === '--count') o.count = Number(need());
    else if (a === '--prefix') o.prefix = need();
    else return { error: `unknown argument ${a}` };
  }
  if (!o.base || !/^https:\/\//.test(o.base)) return { error: '--base <https address of the platform> is required' };
  if (!o.mailpit) return { error: '--mailpit-ssh <user@vm-p address> is required' };
  if (!o.out) return { error: '--out <file> is required' };
  const rel = path.relative(ROOT, path.resolve(o.out));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { error: '--out must be outside the repository (passwords must never be committed)' };
  if (!Number.isInteger(o.count) || o.count < 1 || o.count > 20) return { error: '--count is a whole number from 1 to 20' };
  if (!/^[a-z][a-z0-9]{1,15}$/.test(o.prefix)) return { error: '--prefix is 2 to 16 lowercase letters or digits, starting with a letter' };
  return o;
}

export const makePassword = () => `Vm-${crypto.randomBytes(12).toString('base64url')}-${crypto.randomInt(10, 99)}`;

export async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); } catch (e) { o = { error: e.message }; }
  if (o.error) { console.error(o.error); return 2; }
  const lines = [];
  for (let n = 1; n <= o.count; n++) {
    const email = `${o.prefix}${n}@vulnmart.example`;
    const password = makePassword();
    const c = new Client(o.base);
    const s = await c.request('POST', '/api/v1/accounts', { body: { email, password, display_name: `Demo ${o.prefix} ${n}`, age_declaration: true } });
    if (s.status !== 202) { console.log(`skipped ${email}: sign up answered ${s.status}`); continue; }
    const token = await verificationToken(o.mailpit, email);
    const v = await c.request('POST', '/api/v1/accounts/verify-email', { body: { token } });
    if (v.status !== 200) { console.log(`FAIL ${email}: confirmation answered ${v.status}`); return 1; }
    const l = await c.request('POST', '/api/v1/session', { body: { email, password } });
    if (l.status !== 200) { console.log(`FAIL ${email}: sign in answered ${l.status}`); return 1; }
    lines.push(`${email} ${password}`);
    console.log(`ready ${email}`);
  }
  if (lines.length) {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.appendFileSync(o.out, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.log(`${lines.length} account(s): e-mail and password are in ${o.out} (not printed here)`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());