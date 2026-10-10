// Stub injector (IF-6 section 5). One-shot: reads one JSON document on standard input, then writes, in this order:
//   1. snapshot  (exit 11 on failure)      2. placement files (exit 12)      3. flags file, then the marker last (exit 13)
// A bad document stops at exit 10. Nothing from the document is ever printed: the only output is one fixed line.
// Paths come from the environment names the contract allows (VM_SNAPSHOT_PATH, VM_FLAGS_PATH); the marker sits next to the flags file.
import fs from 'node:fs';
import path from 'node:path';
import { compile, readDocument, SCHEMAS } from './common.mjs';
import { semanticInjection } from './semantic.mjs'; // the same rules as scripts/validate-contracts.mjs

export const EXIT = { OK: 0, BAD_DOCUMENT: 10, SNAPSHOT: 11, PLACEMENT: 12, MARKER: 13 };
const NAMES = { 10: 'bad document', 11: 'snapshot patch failed', 12: 'placement write failed', 13: 'flags file or marker write failed' };
export const PLACEMENT_KINDS = [
  { challenge_key: 'C06', dir: '/run/placement/import', file: 'C06.placement' }, // kind "file in import service"
  { challenge_key: 'C10', dir: '/run/placement/mock', file: 'C10.placement' }, // kind "file in mock-services"
];

let validateInjection;
// True when the document passes the schema and the shared semantic rules (the same verdict as scripts/validate-contracts.mjs).
export function documentOk(doc) {
  validateInjection ??= compile(SCHEMAS.injection);
  return validateInjection(doc) === true && semanticInjection(doc).length === 0;
}

function writeFile(file, data, mode) {
  fs.writeFileSync(file, data, { mode, flag: 'wx' });
  fs.chmodSync(file, mode);
}

export async function runInject({
  stdin = process.stdin,
  env = process.env,
  placements = PLACEMENT_KINDS,
  maxBytes = 65536,
  log = (m) => console.log(m),
} = {}) {
  const fail = (code) => { log(`inject: exit ${code} (${NAMES[code]})`); return code; };
  const snapshotPath = env.VM_SNAPSHOT_PATH || '/run/vm/snapshot.db';
  const flagsPath = env.VM_FLAGS_PATH || '/run/vm/flags.json';
  const markerPath = path.join(path.dirname(flagsPath), 'injected');

  // 1. read and validate
  const read = await readDocument(stdin, maxBytes);
  if (!read.ok) return fail(EXIT.BAD_DOCUMENT);
  if (!documentOk(read.value)) return fail(EXIT.BAD_DOCUMENT);
  const doc = read.value;

  // 2a. snapshot: a small stand-in for the patched shop database. It holds no flag and no seed.
  try {
    writeFile(snapshotPath, JSON.stringify({ stub_snapshot: true, instance_id: doc.instance_id, epoch: doc.epoch, users: ['u-1001'] }), 0o444);
  } catch { return fail(EXIT.SNAPSHOT); }

  // 2b. placement files (only for the challenge keys the document carries)
  try {
    for (const p of placements) {
      const f = doc.flags.find((x) => x.challenge_key === p.challenge_key);
      if (f) writeFile(path.join(p.dir, p.file), f.flag, 0o400);
    }
  } catch { return fail(EXIT.PLACEMENT); }

  // 3. flags file, then the marker last
  try {
    writeFile(flagsPath, JSON.stringify({ schema_version: '0.1', instance_id: doc.instance_id, epoch: doc.epoch, flags: doc.flags }), 0o400);
    writeFile(markerPath, '', 0o444);
  } catch { return fail(EXIT.MARKER); }
  log('inject: done');
  return EXIT.OK;
}
