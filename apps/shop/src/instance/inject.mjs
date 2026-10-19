#!/usr/bin/env node
// The injector of the shop image (IF-6 section 5; handoff H-26): the one-shot container with no network that makes an instance's shop.
//
// It reads one JSON document on standard input, then writes, in this order:
//   1. the snapshot  (exit 11 on failure): a copy of the seeded snapshot baked into the image, with this instance's flags and challenge data planted (placements.mjs)
//   2. the placement files for the import service and the mock services (exit 12)
//   3. the flags file, then the marker last (exit 13). The shop is ready only after the marker.
// A bad document stops at exit 10. Nothing from the document is ever printed: the only output is one fixed line.
// Paths come from the environment names the contract allows (VM_SNAPSHOT_PATH, VM_FLAGS_PATH); the marker sits next to the flags file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/index.mjs';
import { FILE_PLACEMENTS, flagMap, plantDatabase } from './placements.mjs';
import { readDocument } from './read-document.mjs';

export const EXIT = { OK: 0, BAD_DOCUMENT: 10, SNAPSHOT: 11, PLACEMENT: 12, MARKER: 13 };
const NAMES = { 10: 'bad document', 11: 'snapshot patch failed', 12: 'placement write failed', 13: 'flags file or marker write failed' };
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE_SNAPSHOT = path.resolve(HERE, '..', '..', 'snapshot', 'base.db');

const FLAG = /^VM\{[A-Z2-7]{24}\}$/;
const KEY = /^C(0[1-9]|10|11)$/;
const exact = (o, allowed, required) => o !== null && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o);
const wholeNumber = (n, min) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;

/** The reasons a document is refused (JSON pointers only, never a value). The schema of contracts/instance/injection-document.schema.json plus the shared semantic rules. */
export function documentProblems(d) {
  const p = [];
  if (!exact(d, ['schema_version', 'instance_id', 'epoch', 'issued_at', 'seed', 'flags', 'decoys'], ['schema_version', 'instance_id', 'epoch', 'seed', 'flags', 'decoys'])) return ['/'];
  if (d.schema_version !== '0.1') p.push('/schema_version');
  if (typeof d.instance_id !== 'string' || !/^i-[A-Z2-7]{16}$/.test(d.instance_id)) p.push('/instance_id');
  if (!wholeNumber(d.epoch, 1)) p.push('/epoch');
  if ('issued_at' in d && (typeof d.issued_at !== 'string' || Number.isNaN(Date.parse(d.issued_at)))) p.push('/issued_at');
  if (typeof d.seed !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(d.seed)) p.push('/seed');
  if (!Array.isArray(d.flags) || d.flags.length < 1 || d.flags.length > 11) return [...p, '/flags'];
  if (!Array.isArray(d.decoys)) return [...p, '/decoys'];
  d.flags.forEach((f, i) => { if (!exact(f, ['challenge_key', 'flag'], ['challenge_key', 'flag']) || !KEY.test(f.challenge_key) || !FLAG.test(f.flag)) p.push(`/flags/${i}`); });
  d.decoys.forEach((x, i) => {
    if (!exact(x, ['challenge_key', 'index', 'value', 'decoy_placement'], ['challenge_key', 'index', 'value']) || !KEY.test(x.challenge_key) || !wholeNumber(x.index, 0) || !FLAG.test(x.value)
      || ('decoy_placement' in x && (typeof x.decoy_placement !== 'string' || x.decoy_placement.length < 1 || x.decoy_placement.length > 128))) p.push(`/decoys/${i}`);
  });
  if (p.length) return p;
  const dup = (items, key) => new Set(items.map(key)).size !== items.length;
  if (dup(d.flags, (f) => f.challenge_key) || dup(d.flags, (f) => f.flag)) p.push('/flags');
  if (dup(d.decoys, (x) => `${x.challenge_key}#${x.index}`) || dup(d.decoys, (x) => x.value)) p.push('/decoys');
  const values = new Set(d.flags.map((f) => f.flag));
  const keys = new Set(d.flags.map((f) => f.challenge_key));
  d.decoys.forEach((x, i) => { if (values.has(x.value) || !keys.has(x.challenge_key)) p.push(`/decoys/${i}`); });
  return p;
}

function writeFile(file, data, mode) {
  fs.writeFileSync(file, data, { mode, flag: 'wx' });
  fs.chmodSync(file, mode);
}

/** Copy the baked snapshot, plant the instance's data, and publish it read-only. Returns the keys planted. */
export function buildInstanceSnapshot({ base = BASE_SNAPSHOT, target, flags }) {
  const tmp = `${target}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.copyFileSync(base, tmp);
  fs.chmodSync(tmp, 0o600);
  let planted;
  const db = openDb(tmp);
  try {
    db.exec('BEGIN');
    planted = plantDatabase(db, flags);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  } finally {
    db.close();
  }
  for (const suffix of ['-journal', '-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o444);
  return planted;
}

export async function runInject({
  stdin = process.stdin,
  env = process.env,
  placements = FILE_PLACEMENTS,
  base = env.VM_BASE_SNAPSHOT_PATH || BASE_SNAPSHOT,
  maxBytes = 65536,
  log = (m) => console.log(m),
} = {}) {
  const fail = (code) => { log(`inject: exit ${code} (${NAMES[code]})`); return code; };
  const snapshotPath = env.VM_SNAPSHOT_PATH || '/run/vm/snapshot.db';
  const flagsPath = env.VM_FLAGS_PATH || '/run/vm/flags.json';
  const markerPath = path.join(path.dirname(flagsPath), 'injected');

  const read = await readDocument(stdin, maxBytes);
  if (!read.ok || documentProblems(read.value).length) return fail(EXIT.BAD_DOCUMENT);
  const doc = read.value;
  const flags = flagMap(doc);

  try { buildInstanceSnapshot({ base, target: snapshotPath, flags }); } catch { return fail(EXIT.SNAPSHOT); }

  try {
    for (const p of placements) if (flags[p.challenge_key]) writeFile(path.join(p.dir, p.file), flags[p.challenge_key], 0o400);
  } catch { return fail(EXIT.PLACEMENT); }

  try {
    writeFile(flagsPath, JSON.stringify({ schema_version: '0.1', instance_id: doc.instance_id, epoch: doc.epoch, flags: doc.flags }), 0o400);
    writeFile(markerPath, '', 0o444);
  } catch { return fail(EXIT.MARKER); }
  log('inject: done');
  return EXIT.OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await runInject());
}