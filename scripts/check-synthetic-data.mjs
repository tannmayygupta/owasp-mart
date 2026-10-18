#!/usr/bin/env node
// Synthetic data only (story P-24, FR-PRV-17): the seed files of the test shop hold no real email addresses, no card numbers and no real-looking secrets.
//
//   node scripts/check-synthetic-data.mjs          scan the seed folders, exit 1 and name every finding (file, line, kind), never the value
//
// What it can and cannot see (stated plainly, because a clean run is not a proof):
// - an email address is accepted only on a reserved domain (RFC 2606 and 6761: .test, .example, .invalid, .localhost, example.com, example.org, example.net, and their
//   subdomains); anything else is a finding;
// - a run of 13 to 19 digits (spaces and dashes allowed) that passes the Luhn check is a card-number finding, whatever it is meant to be;
// - a secret is found only in the formats of well-known providers (AWS access keys, private key blocks, GitHub, Slack, Stripe live and Google API keys); a weak made-up
//   password is not a finding, because the challenge accounts have deliberately weak ones;
// - a real person's NAME in a seed cannot be told from an invented one by a program: the seed names are for a human to review, and the contributors of the shop
//   streams promise to invent them (docs/dev-log of this story).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_FOLDERS = ['apps/shop/seed', 'apps/shop/migrations', 'challenges'];
const TEXT = /\.(mjs|js|json|sql|csv|txt|md|yaml|yml)$/i;
const SKIP = new Set(['node_modules', '.git']);

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const RESERVED = [/\.test$/i, /\.example$/i, /\.invalid$/i, /\.localhost$/i, /(^|\.)example\.(com|org|net)$/i];
const DIGITS = /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/g;
const SECRETS = [
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['a Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

export function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Findings of one text: [{ file, line, kind }]. The matched value is never part of a finding. */
export function scanText(text, file = '(text)') {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const at = i + 1;
    for (const m of line.matchAll(EMAIL)) {
      if (!RESERVED.some((r) => r.test(m[1]))) found.push({ file, line: at, kind: 'an email address on a domain that is not reserved for examples' });
    }
    for (const m of line.matchAll(DIGITS)) {
      const digits = m[0].replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.push({ file, line: at, kind: 'a number that passes the card-number check' });
    }
    for (const [kind, re] of SECRETS) if (re.test(line)) found.push({ file, line: at, kind: `${kind}` });
  });
  return found;
}

function* files(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* files(full);
    else if (TEXT.test(name) && stat.size < 2_000_000) yield full;
  }
}

export function scanTree(root = ROOT, folders = SEED_FOLDERS) {
  const found = [];
  let scanned = 0;
  for (const folder of folders) {
    for (const file of files(path.join(root, folder))) {
      scanned += 1;
      found.push(...scanText(readFileSync(file, 'utf8'), path.relative(root, file).split(path.sep).join('/')));
    }
  }
  return { found, scanned };
}

export function main(log = console.log) {
  const { found, scanned } = scanTree();
  for (const f of found) log(`FAIL ${f.file}:${f.line}: ${f.kind}`);
  log(found.length ? `${found.length} finding(s) in ${scanned} seed file(s)` : `PASS ${scanned} seed file(s): only reserved email domains, no card numbers, no well-known secret formats`);
  return found.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
