// Password hashing for the shop (T-07, FR-SHP-09). Uses Node's built-in
// crypto.scrypt (ADR 0018): a strong, salted, memory-hard adaptive hash with no
// native dependency. No MD5, SHA-1, or unsalted hashing anywhere.
//
// Stored form is a self-describing PHC-style string so parameters can change
// over time without breaking old hashes:
//   scrypt$N=32768,r=8,p=1$<salt-base64>$<hash-base64>
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// OWASP-guided scrypt parameters (ADR 0018). Raise over time; old hashes still
// verify because each stored string carries the parameters it was made with.
export const PARAMS = { N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16 };
// A password longer than this is rejected before hashing, so a pathological
// multi-megabyte input cannot amplify scrypt cost (OWASP guidance).
export const MAX_PASSWORD_LENGTH = 1024;

// scrypt needs maxmem >= 128 * N * r; compute it from the ACTUAL params in play
// (not the module default) so a higher-cost stored hash still verifies.
function maxmemFor({ N, r }) {
  return 256 * N * r;
}

function derive(password, salt, { N, r, p, keylen }) {
  return scryptSync(Buffer.from(String(password), 'utf8'), salt, keylen, { N, r, p, maxmem: maxmemFor({ N, r }) });
}

// Hash a password into a PHC-style string with a fresh random salt.
export function hash(password, params = PARAMS) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new TypeError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(params.saltBytes);
  const key = derive(password, salt, params);
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const m = parts[1].match(/^N=(\d+),r=(\d+),p=(\d+)$/);
  if (!m) return null;
  let salt;
  let key;
  try {
    salt = Buffer.from(parts[2], 'base64');
    key = Buffer.from(parts[3], 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || key.length === 0) return null;
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), keylen: key.length, salt, key };
}

// Verify a password against a stored PHC-style string. Constant-time; never
// throws on a malformed stored value (returns false), so a corrupt row cannot
// crash a login or leak a difference.
export function verify(password, stored) {
  const parsed = parse(stored);
  if (!parsed || typeof password !== 'string') return false;
  let candidate;
  try {
    candidate = derive(password, parsed.salt, parsed);
  } catch {
    return false;
  }
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}

// True when a stored value is a scrypt hash this module produced AND its cost
// meets the current floor. A legacy/weak format (MD5, unsalted) or a
// cost-downgraded scrypt string (e.g. N=1) returns false, so this can gate
// against weak hashes (FR-SHP-09).
export function isStrongHash(stored) {
  const p = parse(stored);
  if (!p) return false;
  return p.N >= PARAMS.N && p.r >= PARAMS.r && p.keylen >= PARAMS.keylen && p.salt.length >= PARAMS.saltBytes;
}

// True when a stored hash verifies but was made with parameters weaker than the
// current PARAMS, so the login flow (T-14) can transparently re-hash on success.
export function needsRehash(stored) {
  const p = parse(stored);
  if (!p) return true; // unparseable or legacy => should be replaced
  return p.N < PARAMS.N || p.r < PARAMS.r || p.p < PARAMS.p || p.keylen < PARAMS.keylen || p.salt.length < PARAMS.saltBytes;
}
