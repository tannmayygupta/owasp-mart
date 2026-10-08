#!/usr/bin/env node
// Verifies (or regenerates) the SHA-256 manifest of the installed BMAD skills.
//   node scripts/verify-skills.mjs          verify; exit code 1 on any difference
//   node scripts/verify-skills.mjs --write  regenerate docs/bmad/skills.sha256 (only after a REVIEWED update)
// Text files are hashed after converting CRLF to LF, so the result is the same on Windows, macOS and Linux.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const skillsDir = join(repo, '.claude', 'skills');
const manifestPath = join(repo, 'docs', 'bmad', 'skills.sha256');

function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function hashFile(path) {
  let buf = readFileSync(path);
  if (!buf.includes(0)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'); // text: normalise
  return createHash('sha256').update(buf).digest('hex');
}

if (!existsSync(skillsDir)) {
  console.error(`No skills folder at ${skillsDir}`);
  process.exit(1);
}

const files = walk(skillsDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const current = new Map(files.map((f) => [f, hashFile(join(skillsDir, f))]));

if (process.argv.includes('--write')) {
  const lines = [...current].map(([f, h]) => `${h}  ${f}`);
  writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${lines.length} entries to docs/bmad/skills.sha256`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error('Manifest docs/bmad/skills.sha256 is missing.');
  process.exit(1);
}
const expected = new Map();
for (const line of readFileSync(manifestPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
  if (m) expected.set(m[2], m[1]);
}

const changed = [], missing = [], extra = [];
for (const [f, h] of expected) {
  if (!current.has(f)) missing.push(f);
  else if (current.get(f) !== h) changed.push(f);
}
for (const f of current.keys()) if (!expected.has(f)) extra.push(f);

if (!changed.length && !missing.length && !extra.length) {
  console.log(`OK: all ${expected.size} installed skill files match the manifest.`);
  process.exit(0);
}
for (const [label, list] of [['CHANGED', changed], ['MISSING', missing], ['EXTRA (not in manifest)', extra]]) {
  if (list.length) console.error(`${label}:\n  ${list.join('\n  ')}`);
}
console.error('Skills differ from the reviewed manifest. Do not use them until a second developer has reviewed the difference.');
process.exit(1);
