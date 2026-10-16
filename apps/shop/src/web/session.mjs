// Signed-cookie session for the shop (T-14). No dependency: an HMAC-signed,
// tamper-evident cookie carrying only the user id and a CSRF token. Not
// encrypted (it holds no secret); the signing key is per instance.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'vm_sess';
// Per-instance signing key. In an instance it comes from the environment; in
// dev a random key is generated per process (sessions reset on restart, and
// would not validate across a multi-process cluster — fine for a single-process
// instance, so warn loudly if we had to generate one inside an instance).
const KEY = process.env.VM_SESSION_SECRET || randomBytes(32).toString('hex');
if (!process.env.VM_SESSION_SECRET && process.env.VM_INSTANCE_ID) {
  console.warn('WARNING: VM_SESSION_SECRET is not set; using a random per-process key (sessions reset on restart).');
}
// Secure cookie by default; local HTTP dev can opt out with VM_INSECURE_COOKIES=1.
const SECURE = process.env.VM_INSECURE_COOKIES !== '1';
// Sessions expire (no challenge depends on a non-expiring cookie — C07 is reset +
// brute force, and its own fix ends sessions after a reset). Default 12 hours.
const SESSION_TTL_MS = Number(process.env.VM_SESSION_TTL_MS) || 12 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sign(payloadStr) {
  return b64url(createHmac('sha256', KEY).update(payloadStr).digest());
}

// Serialize + sign a session object into a cookie value.
export function serialize(obj) {
  const payload = b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
  return `${payload}.${sign(payload)}`;
}

// Verify and parse a cookie value; returns the object or null (never throws). An
// expired session (exp in the past) is treated as no session.
export function parse(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [payload, sig] = value.split('.', 2);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let obj;
  try {
    obj = JSON.parse(unb64url(payload).toString('utf8'));
  } catch {
    return null;
  }
  if (obj && typeof obj.exp === 'number' && Date.now() > obj.exp) return null;
  return obj;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const raw = v.join('=');
      // A malformed percent-escape (e.g. "vm_sess=%") makes decodeURIComponent
      // throw; fall back to the raw value (parse() rejects a bad cookie anyway)
      // rather than let a crafted cookie 500 every request.
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return undefined;
}

// Read the session object from the request, or null.
export function getSession(req) {
  return parse(readCookie(req, COOKIE));
}

// Write the session object as a signed HttpOnly cookie, stamping issued-at and
// expiry so a stolen or stale cookie does not live forever.
export function setSession(res, obj) {
  const now = Date.now();
  const stamped = { ...obj, iat: now, exp: now + SESSION_TTL_MS };
  res.cookie(COOKIE, serialize(stamped), { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/', maxAge: SESSION_TTL_MS });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function newCsrfToken() {
  return randomBytes(16).toString('hex');
}
