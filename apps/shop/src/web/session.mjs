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

// Verify and parse a cookie value; returns the object or null (never throws).
export function parse(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [payload, sig] = value.split('.', 2);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(unb64url(payload).toString('utf8'));
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

// Read the session object from the request, or null.
export function getSession(req) {
  return parse(readCookie(req, COOKIE));
}

// Write the session object as a signed HttpOnly cookie.
export function setSession(res, obj) {
  res.cookie(COOKIE, serialize(obj), { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/' });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function newCsrfToken() {
  return randomBytes(16).toString('hex');
}
