// Scans the tracked files for things that must never be committed for the Oracle setup:
// OCIDs, private key blocks, API key fingerprints, local Terraform files, and public IPv4 addresses
// (the address scan covers infra/, docs/runbooks, docs/assets, docs/dev-log and the Oracle study notes only).
// Usage: node scripts/scan-secrets.mjs   (exit 1 with the file and line of each hit; the matched value is never printed)
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OCID = /ocid1\.[a-z0-9_]+\.oc[0-9]\.[a-z0-9-]*\.[a-z0-9]{20,}/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const FINGERPRINT = /\b(?:[0-9a-f]{2}:){15}[0-9a-f]{2}\b/i;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)(?!\.\d)/g;
const BAD_NAMES = [
  /\.pem$/i, /\.key$/i, /\.tfstate(\.|$)/i, /\.tfvars$/i, /\.tfvars\.json$/i, /(^|\/)tfplan[^/]*$/i, /\.tfplan$/i,
  /\.local\.json$/i, /(^|\/)\.oci\//, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/,
];
const SKIP_CONTENT = /(^|\/)(pnpm-lock\.yaml|uv\.lock|\.terraform\.lock\.hcl|package-lock\.json)$|\.(xlsx|png|jpg|jpeg|gif|ico|pdf|woff2?|zip|gz)$/i;
const IP_SCOPE = [/^infra\//, /^docs\/runbooks\//, /^docs\/assets\//, /^docs\/dev-log\//, /^docs\/research\/s-1[17]/, /^docs\/adr\/0021/];

// Test files that write a fake key header on purpose (to prove the contract validator rejects it).
const KEY_BLOCK_FIXTURES = new Set(['scripts/validate-contracts.test.mjs']);

export function isPublicIPv4(a, b, c, d) {
  const o = [a, b, c, d].map(Number);
  if (o.some((n) => n > 255)) return false;
  const [w, x, y] = o;
  if (w === 0 || w === 10 || w === 127 || w >= 224) return false;
  if (w === 172 && x >= 16 && x <= 31) return false;
  if (w === 192 && x === 168) return false;
  if (w === 169 && x === 254) return false;
  if (w === 100 && x >= 64 && x <= 127) return false;
  if (w === 192 && x === 0 && y === 2) return false;
  if (w === 198 && x === 51 && y === 100) return false;
  if (w === 203 && x === 0 && y === 113) return false;
  return true;
}

/** @returns {{file:string,line:number,kind:string}[]} */
export function scanText(file, text, { ips = IP_SCOPE.some((re) => re.test(file)) } = {}) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const hit = (kind) => hits.push({ file, line: i + 1, kind });
    if (OCID.test(line)) hit('OCID');
    if (PRIVATE_KEY.test(line) && !KEY_BLOCK_FIXTURES.has(file)) hit('private key block');
    if (FINGERPRINT.test(line)) hit('API key fingerprint');
    if (ips) {
      for (const m of line.matchAll(IPV4)) if (isPublicIPv4(m[1], m[2], m[3], m[4])) hit('public IPv4 address');
    }
  });
  return hits;
}

export function scanFiles(files, read = (f) => readFileSync(path.join(ROOT, f), 'utf8'), size = (f) => statSync(path.join(ROOT, f)).size) {
  const hits = [];
  for (const f of files) {
    if (BAD_NAMES.some((re) => re.test(f))) hits.push({ file: f, line: 0, kind: 'file that must stay local' });
    if (SKIP_CONTENT.test(f)) continue;
    try {
      if (size(f) > 2_000_000) continue;
      hits.push(...scanText(f, read(f)));
    } catch {
      // deleted or unreadable file: nothing to scan
    }
  }
  return hits;
}

export function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = scanFiles(trackedFiles());
  if (hits.length) {
    for (const h of hits) console.error(`FAIL ${h.file}:${h.line} ${h.kind}`);
    process.exit(1);
  }
  console.log('PASS no OCID, key, fingerprint, local file or public address in the tree');
}
