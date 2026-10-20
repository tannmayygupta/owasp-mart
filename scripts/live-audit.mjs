// Repeatable live audit of the labs host (vm-i): collects the read-only facts over SSH, redacts them, saves them as the input folder of scripts/vmi-audit.mjs and
// runs that audit. Read-only on the host. Needs the SSH key in the agent, AWS credentials (profile vulnmart) for the IMDS facts, and terraform for the addresses.
//   node scripts/live-audit.mjs --out <folder> [--instances N] [--expect-runtime runsc|runc]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SECTIONS = ['docker-info.json', 'daemon.json', 'iptables-docker-user.txt', 'iptables-input.txt', 'iptables-vulnmart-labs.txt', 'inspect.json', 'ss.txt'];

export const REMOTE = `set -u
p() { printf '\\n=====%s=====\\n' "$1"; }
p docker-info.json; sudo docker info --format '{{json .}}'
p daemon.json; sudo cat /etc/docker/daemon.json
p iptables-docker-user.txt; sudo iptables -S DOCKER-USER
p iptables-input.txt; sudo iptables -S INPUT
p iptables-vulnmart-labs.txt; sudo iptables -S VULNMART-LABS
p inspect.json; sudo docker inspect $(sudo docker ps -q)
p ss.txt; ss -ltnH
`;

/** Split the remote output at the =====name===== markers. Returns {name: text}; a missing section is an error. */
export function splitSections(text) {
  const out = {};
  const parts = String(text).replace(/\r/g, '').split(/^=====([A-Za-z0-9._-]+)=====$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1].replace(/^\n/, '');
  for (const n of SECTIONS) if (!(n in out) || !out[n].trim()) throw new Error(`the host gave no ${n}`);
  return out;
}

const ADDR = /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Environment values of every container become <redacted>, addresses (not loopback) become <addr>. The audit reads neither. */
export function redactInspect(text) {
  const flat = JSON.parse(text.replace(/^\uFEFF/, '')).flat(Infinity);
  for (const c of flat) if (c?.Config?.Env) c.Config.Env = c.Config.Env.map((e) => `${String(e).split('=')[0]}=<redacted>`);
  return JSON.stringify(flat, null, 1).replace(ADDR, '<addr>');
}

function run(cmd, args, opts = {}) { return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }); }

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--out');
  if (i < 0 || !argv[i + 1]) { console.error('usage: node scripts/live-audit.mjs --out <folder> [--instances N]'); return 2; }
  const out = path.resolve(argv[i + 1]);
  const n = argv.includes('--instances') ? argv[argv.indexOf('--instances') + 1] : '1';
  const rt = argv.includes('--expect-runtime') ? argv[argv.indexOf('--expect-runtime') + 1] : null;
  if (rt !== null && !['runc', 'runsc'].includes(rt)) { console.error('--expect-runtime is runc or runsc'); return 2; }
  const tfDir = path.join(ROOT, 'infra', 'terraform', 'aws');
  const env = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE ?? 'vulnmart' };
  const host = run('terraform', ['output', '-raw', 'vm_i_public_ip'], { cwd: tfDir, env }).stdout.trim();
  const ssh = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
  const scp = process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\scp.exe' : 'scp';
  const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new'];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  try {
    fs.writeFileSync(path.join(tmp, 'collect.sh'), REMOTE);
    let r = run(scp, [...opts, '-q', path.join(tmp, 'collect.sh'), `ubuntu@${host}:/tmp/collect.sh`]);
    if (r.status !== 0) throw new Error('could not copy the collector (is your address allowed? node scripts/allow-my-ip.mjs)');
    r = run(ssh, [...opts, `ubuntu@${host}`, 'bash /tmp/collect.sh; rm -f /tmp/collect.sh']);
    if (r.status !== 0) throw new Error(`the collector failed: ${String(r.stderr).split(/\r?\n/).slice(-2).join(' ')}`);
    const sections = splitSections(r.stdout);
    fs.mkdirSync(out, { recursive: true });
    for (const name of SECTIONS) fs.writeFileSync(path.join(out, name), name === 'inspect.json' ? redactInspect(sections[name]) : sections[name]);
    const imds = run('aws', ['ec2', 'describe-instances', '--filters', 'Name=instance-state-name,Values=running', '--query', 'Reservations[].Instances[].MetadataOptions.HttpTokens', '--output', 'json'], { env });
    fs.writeFileSync(path.join(out, 'imds.json'), imds.status === 0 ? imds.stdout : '');
  } catch (e) { console.error(`FAIL ${e.message}`); return 1; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const a = run('node', [path.join(ROOT, 'scripts', 'vmi-audit.mjs'), '--from', out, '--instances', n, ...(rt ? ['--expect-runtime', rt] : [])], { encoding: 'utf8' });
  console.log(a.stdout.trimEnd());
  return a.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());