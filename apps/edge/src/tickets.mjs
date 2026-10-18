// Gate ticket and cookie: sign and verify (contracts/edge/gate-ticket.md sections 2 and 3). No dependencies.
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(key, prefix + "\n" + payload_b64)).
// Every secret comparison goes through safeEqual (crypto.timingSafeEqual); there is no === on a signature, a key or a secret.
import crypto from 'node:crypto';

export const TICKET_PREFIX = 'vm-ticket-v1';
export const COOKIE_PREFIX = 'vm-cookie-v1';
export const COOKIE_NAME = '__Host-vm_gate';
export const TICKET_MAX_AHEAD_S = 60;
export const MIN_KEY_BYTES = 32;
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const INSTANCE_ID_RE = /^i-[A-Z2-7]{16}$/;
export const OWNER_RE = /^[0-9a-f]{64}$/;
export const JTI_RE = /^[A-Za-z0-9_-]{22}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;

export const isUint = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Constant-time equality of two strings (the length of a public value may leak; its content does not). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x); // keep the work the same
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

export const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Strict base64url: only the URL alphabet, no padding, and canonical (re-encoding gives the same text). Returns a Buffer or null. */
export function unb64u(s) {
  if (typeof s !== 'string' || !B64U_RE.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  return buf.toString('base64url') === s ? buf : null;
}

function mac(key, prefix, payloadB64) {
  return crypto.createHmac('sha256', key).update(`${prefix}\n${payloadB64}`).digest();
}

/** Keys: { current: Buffer, previous?: Buffer }, each at least 32 bytes. Throws on a bad key set (a gate must not start with one). */
export function checkKeys(keys) {
  if (!keys || !Buffer.isBuffer(keys.current) || keys.current.length < MIN_KEY_BYTES) throw new Error(`keys.current must be a Buffer of at least ${MIN_KEY_BYTES} bytes`);
  if (keys.previous !== undefined && keys.previous !== null && (!Buffer.isBuffer(keys.previous) || keys.previous.length < MIN_KEY_BYTES)) throw new Error(`keys.previous must be a Buffer of at least ${MIN_KEY_BYTES} bytes`);
  return keys;
}

function sign(keys, prefix, claims) {
  const payload = b64u(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payload}.${b64u(mac(checkKeys(keys).current, prefix, payload))}`;
}

// Splits "payload.sig", checks the signature against every accepted key (both are always tried), returns { payloadBuf } or { reason }.
function open(keys, prefix, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return { reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { reason: 'malformed' };
  const payloadBuf = unb64u(parts[0]);
  const sig = unb64u(parts[1]);
  if (!payloadBuf || !sig || sig.length !== 32) return { reason: 'malformed' };
  let ok = false;
  for (const key of [keys.current, keys.previous]) {
    if (!key) continue;
    const good = crypto.timingSafeEqual(mac(key, prefix, parts[0]), sig);
    ok = ok || good;
  }
  return ok ? { payloadBuf } : { reason: 'signature' };
}

function parseClaims(payloadBuf, shape) {
  let obj;
  try {
    obj = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const names = Object.keys(obj);
  if (names.length !== shape.length || !shape.every((k) => Object.hasOwn(obj, k))) return null;
  if (obj.v !== 1 || !INSTANCE_ID_RE.test(obj.inst ?? '') || !OWNER_RE.test(obj.own ?? '') || !isUint(obj.ae)) return null;
  return obj;
}

export function signTicket(keys, { inst, own, ae, exp, jti }) {
  return sign(keys, TICKET_PREFIX, { v: 1, inst, own, ae, exp, jti });
}

export function signCookie(keys, { inst, own, ae }) {
  return sign(keys, COOKIE_PREFIX, { v: 1, inst, own, ae });
}

/** @returns {{ok:true,claims:object}|{ok:false,reason:'malformed'|'signature'|'claims'|'expired'|'too-far'}}; nowS is unix seconds. */
export function verifyTicket(keys, token, nowS) {
  const r = open(checkKeys(keys), TICKET_PREFIX, token);
  if (!r.payloadBuf) return { ok: false, reason: r.reason };
  const c = parseClaims(r.payloadBuf, ['v', 'inst', 'own', 'ae', 'exp', 'jti']);
  if (!c || !isUint(c.exp) || !JTI_RE.test(c.jti ?? '')) return { ok: false, reason: 'claims' };
  if (c.exp <= nowS) return { ok: false, reason: 'expired' };
  if (c.exp - nowS > TICKET_MAX_AHEAD_S) return { ok: false, reason: 'too-far' };
  return { ok: true, claims: c };
}

/** @returns {{ok:true,claims:object}|{ok:false,reason:'malformed'|'signature'|'claims'}} */
export function verifyCookie(keys, value) {
  const r = open(checkKeys(keys), COOKIE_PREFIX, value);
  if (!r.payloadBuf) return { ok: false, reason: r.reason };
  const c = parseClaims(r.payloadBuf, ['v', 'inst', 'own', 'ae']);
  return c ? { ok: true, claims: c } : { ok: false, reason: 'claims' };
}

/** The Set-Cookie value of the gate cookie: Secure, HttpOnly, Path=/, no Domain, SameSite=Lax, session lifetime (no Max-Age). */
export const cookieHeader = (value) => `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`;

/** A fresh single-use ticket id: 16 random bytes, base64url. */
export const newJti = () => b64u(crypto.randomBytes(16));
