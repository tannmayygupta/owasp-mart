// Makes every secret and certificate the two hosts need for the demo deployment (docs/runbooks/live-deploy.md). Writes OUTSIDE the repository, never prints a value.
//   node scripts/deploy-secrets.mjs --out <folder> --vmi-ip <vm-i private address> --vmp-ip <vm-p private address> [--days 60] [--force [--destroy-keys]]
// What it makes (file names are what the compose files and `scripts/live-deploy.mjs` expect):
//   pki/ca.pem ca.key          one private CA (the link between the two hosts is private; its certificates are checked all the same)
//   pki/orch.pem orch.key      server certificate of the orchestrator listener (subject alternative name: the private address of vm-i)
//   pki/ingest.pem ingest.key  server certificate of the one TLS listener on vm-p (events and state reports; the private address of vm-p)
//   pki/client.pem client.key  client certificate of the platform (the orchestrator admits only a certificate of this CA)
//   keys/platform_key report_key gate_key_current gate_admin_secret   64 hex characters each (the platform key signs IF-5, the report key signs state reports)
//   keys/origin_secret csrf_secret field_secret                        64 hex characters each (the field secret seals second-factor secrets)
//   keys/event_master flag_key owner_key                               base64 (URL-safe) of 32 random bytes each: the three masters of the key service (story P-17)
//   keys/kek                                                           one line `1:<base64 of 32 random bytes>`: the key-encryption key of the key service
//   keys/pg_owner_password pg_app_password keystore_password valkey_password   48 hex characters each
//   keys/brevo_api_key                                                 NOT made here: the Brevo API key is an external credential you put in this folder yourself (live-deploy.mjs platform reads it)
// The extensions are the ones Python 3.14 requires (a CA needs keyUsage keyCertSign). Run again with --force to replace everything (a new CA means new certificates everywhere).
// --force alone refuses when the folder holds a key-encryption key (`keys/kek`): replacing it makes every wrapped attempt key, every sealed evidence row and every
// second-factor secret unreadable, and changes every flag. Add --destroy-keys only when that is the intention (a fresh deployment with no data worth keeping).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function parseArgs(argv) {
  const o = { days: 60, force: false, destroyKeys: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--destroy-keys') o.destroyKeys = true;
    else if (['--out', '--vmi-ip', '--vmp-ip', '--days'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      o[{ '--out': 'out', '--vmi-ip': 'vmiIp', '--vmp-ip': 'vmpIp', '--days': 'days' }[a]] = a === '--days' ? Number(v) : v;
    } else return { error: `unknown argument ${a}` };
  }
  if (!o.out) return { error: '--out <folder> is required' };
  if (!IPV4.test(o.vmiIp ?? '') || !IPV4.test(o.vmpIp ?? '')) return { error: '--vmi-ip and --vmp-ip must be IPv4 addresses (the private addresses of the hosts)' };
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 825) return { error: '--days is a whole number from 1 to 825' };
  const rel = path.relative(ROOT, path.resolve(o.out));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { error: '--out must be outside the repository (keys must never be committed)' };
  return o;
}

export const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

function openssl(args, cwd) {
  const r = spawnSync('openssl', args, { cwd, encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: process.env.OPENSSL_CONF && fs.existsSync(process.env.OPENSSL_CONF) ? process.env.OPENSSL_CONF : path.join(cwd, 'openssl.cnf') } });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${String(r.stderr).split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}`);
}

export function make(o) {
  const out = path.resolve(o.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length && !o.force) throw new Error(`${out} is not empty; use --force to replace it`);
  if (fs.existsSync(path.join(out, 'keys', 'kek')) && !o.destroyKeys) throw new Error(`${out} holds the key-encryption key; replacing it makes all sealed data unreadable. Add --destroy-keys if that is the intention`);
  fs.rmSync(out, { recursive: true, force: true });
  const pki = path.join(out, 'pki');
  const keys = path.join(out, 'keys');
  fs.mkdirSync(pki, { recursive: true });
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(pki, 'openssl.cnf'), '[req]\ndistinguished_name = dn\n[dn]\n');
  const days = String(o.days);
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', days, '-subj', '/CN=vulnmart-private-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], pki);
  const leaf = (name, cn, usage, san) => {
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`], pki);
    let ext = `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n`;
    if (san) ext += `subjectAltName=${san}\n`;
    fs.writeFileSync(path.join(pki, `${name}.ext`), ext);
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', days, '-extfile', `${name}.ext`], pki);
    fs.rmSync(path.join(pki, `${name}.csr`));
    fs.rmSync(path.join(pki, `${name}.ext`));
  };
  leaf('orch', 'vulnmart-orchestrator', 'serverAuth', `IP:${o.vmiIp}`);
  leaf('ingest', 'vulnmart-ingest', 'serverAuth', `IP:${o.vmpIp}`);
  leaf('client', 'vulnmart-platform', 'clientAuth', '');
  for (const f of ['ca.srl', 'openssl.cnf']) fs.rmSync(path.join(pki, f), { force: true });
  for (const n of ['platform_key', 'report_key', 'gate_key_current', 'gate_admin_secret', 'origin_secret', 'csrf_secret', 'field_secret']) fs.writeFileSync(path.join(keys, n), hex(32));
  for (const n of ['event_master', 'flag_key', 'owner_key']) fs.writeFileSync(path.join(keys, n), crypto.randomBytes(32).toString('base64url'));
  fs.writeFileSync(path.join(keys, 'kek'), `1:${crypto.randomBytes(32).toString('base64url')}`);
  for (const n of ['pg_owner_password', 'pg_app_password', 'keystore_password', 'valkey_password']) fs.writeFileSync(path.join(keys, n), hex(24));
  fs.writeFileSync(path.join(keys, 'gate_key_previous'), '');
  return { out, pki: fs.readdirSync(pki).sort(), keys: fs.readdirSync(keys).sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) {
    console.error(o.error);
    process.exit(2);
  }
  try {
    const r = make(o);
    console.log(`made ${r.pki.length} pki files and ${r.keys.length} key files in the folder you named (names only: ${[...r.pki, ...r.keys].join(', ')})`);
  } catch (e) {
    console.error(`FAIL ${e.message}`);
    process.exit(1);
  }
}
