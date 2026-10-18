// Lets the developer's current address in and keeps the web ports as decided (audit blocker B3).
//   node scripts/allow-my-ip.mjs [--dry-run] [--public-web | --no-public-web]
// Why: SSH (port 22) is open only to the developer's own address, and a home or mobile connection changes address (three times on 2026-10-18), which locks the
// developer out and makes the hosts look down. This reads the current public address, writes it as `ssh_source_cidrs` in infra/terraform/aws/terraform.tfvars
// (a file that is not committed), and runs `terraform apply` there (only the network rules change). --public-web writes public_web_cidrs = ["0.0.0.0/0"]
// (ports 80 and 443 for everybody: the demo, the console and the lab players); --no-public-web removes it (80 and 443 follow the SSH list again).
// It needs AWS credentials for the profile in AWS_PROFILE (default vulnmart) and terraform on the PATH. Nothing secret is printed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TF_DIR = path.join(ROOT, 'infra', 'terraform', 'aws');
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function parseArgs(argv) {
  const o = { dryRun: false, publicWeb: null };
  for (const a of argv) {
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--public-web') o.publicWeb = true;
    else if (a === '--no-public-web') o.publicWeb = false;
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

/** Set `key = [ ... ]` in a tfvars text (replace the list, or append the line when the key is absent). A value that is not an IPv4 address or a /32 of one is refused. */
export function setList(text, key, values, { cidr = true } = {}) {
  for (const v of values) if (!IPV4.test(v.replace(/\/\d+$/, ''))) throw new Error(`${v} is not an IPv4 address`);
  const line = `${key} = [${values.map((v) => `"${cidr && !v.includes('/') ? `${v}/32` : v}"`).join(', ')}]`;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[[^\\]]*\\]\\s*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '\n')}${line}\n`;
}

export function removeKey(text, key) {
  return text.replace(new RegExp(`^\\s*${key}\\s*=\\s*\\[[^\\]]*\\]\\s*\\r?\\n?`, 'm'), '');
}

export async function currentIp(fetchImpl = fetch) {
  const r = await fetchImpl('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(15000) });
  const ip = (await r.text()).trim();
  if (!IPV4.test(ip)) throw new Error('the address service did not answer with an IPv4 address');
  return ip;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) { console.error(o.error); return 2; }
  const file = path.join(TF_DIR, 'terraform.tfvars');
  if (!fs.existsSync(file)) { console.error('infra/terraform/aws/terraform.tfvars does not exist (copy terraform.tfvars.example first)'); return 2; }
  const ip = await currentIp();
  let text = fs.readFileSync(file, 'utf8');
  text = setList(text, 'ssh_source_cidrs', [ip]);
  if (o.publicWeb === true) text = setList(text, 'public_web_cidrs', ['0.0.0.0/0'], { cidr: false });
  if (o.publicWeb === false) text = removeKey(text, 'public_web_cidrs');
  console.log(`ssh_source_cidrs becomes this PC's current address (${ip.replace(/\.\d+\.\d+$/, '.x.x')}); public web ports: ${o.publicWeb === null ? 'unchanged' : o.publicWeb ? 'open to everybody' : 'same as SSH'}`);
  if (o.dryRun) { console.log('dry run: nothing written, nothing applied'); return 0; }
  fs.writeFileSync(file, text);
  const env = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE ?? 'vulnmart' };
  const r = spawnSync('terraform', ['apply', '-auto-approve', '-input=false', '-no-color'], { cwd: TF_DIR, env, encoding: 'utf8' });
  const tail = String(r.stdout).split(/\r?\n/).filter((l) => /Apply complete|Error|error/.test(l)).slice(-3).join('\n');
  console.log(tail || String(r.stderr).split(/\r?\n/).slice(-3).join('\n'));
  if (r.status === 0) console.log('PASS network rules applied; allow about 30 seconds before the next ssh');
  return r.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());