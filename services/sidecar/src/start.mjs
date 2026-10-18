// The start document (IF-6, sidecar-start.schema.json): read once from standard input and checked with the schema plus the rules a
// schema cannot express (same verdict as scripts/validate-contracts.mjs and the stub sidecar).
import { compile, readDocument, SCHEMAS } from './common.mjs';

// Rules JSON Schema cannot express: no repeated digest, no second real digest for one challenge key. Returns [{ path, message }].
export function semanticSidecarStart(d) {
  const out = [];
  const seen = new Set();
  d.flag_digests.forEach((x, i) => {
    if (seen.has(x.sha256)) out.push({ path: `/flag_digests/${i}/sha256`, message: `duplicate ${x.sha256}` });
    seen.add(x.sha256);
  });
  const realKeys = new Set();
  d.flag_digests.forEach((x, i) => {
    if (x.kind !== 'real') return;
    if (realKeys.has(x.challenge_key)) out.push({ path: `/flag_digests/${i}/challenge_key`, message: `duplicate real digest for ${x.challenge_key}` });
    realKeys.add(x.challenge_key);
  });
  return out;
}

let validateStart;
export function startDocumentOk(doc) {
  validateStart ??= compile(SCHEMAS.sidecarStart);
  return validateStart(doc) === true && semanticSidecarStart(doc).length === 0;
}

export async function readStartDocument(stream = process.stdin, readOptions) {
  const read = await readDocument(stream, 65536, readOptions);
  return read.ok && startDocumentOk(read.value) ? { ok: true, start: read.value } : { ok: false };
}
