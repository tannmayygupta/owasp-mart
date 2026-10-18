// The flag matcher (D-73). The sidecar holds digests, never a flag: it finds flag-shaped strings in a bounded copy of a response, hashes
// each distinct candidate with SHA-256 and looks the hash up in the digest set of the start document.
import crypto from 'node:crypto';
import { decodeBody, variants } from './decode.mjs';

// The flag format (FR-FLG-02): VM{ plus 24 Base32 characters plus }.
export const FLAG_SHAPE = /VM\{[A-Z2-7]{24}\}/g;
export const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export const SCAN_CAP_BYTES = 1024 * 1024; // the bounded copy of a response (1 MiB)
export const DECODED_CAP_BYTES = 4 * 1024 * 1024; // a decoded response above this is not scanned (expansion bomb guard)

// flagDigests: the flag_digests list of the start document ([{ challenge_key, kind, sha256 }]).
export function createMatcher(flagDigests) {
  const known = new Map(flagDigests.map((d) => [d.sha256, { kind: d.kind, challenge_key: d.challenge_key }]));

  // Distinct flag-shaped strings of a text and its decoded variants, as [{ sha256, kind, challenge_key? }] in order of first sight.
  function scanText(text) {
    const found = new Map();
    for (const v of variants(text)) {
      for (const m of v.matchAll(FLAG_SHAPE)) {
        const sha256 = sha256Hex(m[0]);
        if (found.has(sha256)) continue;
        const hit = known.get(sha256);
        found.set(sha256, hit ? { sha256, kind: hit.kind, challenge_key: hit.challenge_key } : { sha256, kind: 'foreign' });
      }
    }
    return [...found.values()];
  }

  // A response copy: undoes content-encoding, then scans. Resolves { candidates } or { skipped: reason } (counted by the caller, not an error).
  async function scanResponse(buf, contentEncoding, { decodedCap = DECODED_CAP_BYTES, wireCap = SCAN_CAP_BYTES } = {}) {
    if (buf.length > wireCap) return { skipped: 'too_big', candidates: [] };
    const d = await decodeBody(buf, contentEncoding, decodedCap);
    if (!d.ok) return { skipped: d.reason, candidates: [] };
    if (d.buf.length > decodedCap) return { skipped: 'too_big', candidates: [] };
    // read as UTF-8: a flag is ASCII, so it is found in any ASCII-compatible charset; a UTF-16 body is not seen (S-9 table)
    return { candidates: scanText(d.buf.toString('utf8')) };
  }

  return { scanText, scanResponse, size: known.size };
}
