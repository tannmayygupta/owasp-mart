// Account identity for the shop (T-07, FR-SHP-01). Create and authenticate
// users over the T-06 `users` table, with passwords hashed by password.mjs.
// Sessions, routes and the reset flow are later (T-14/T-15; reset is C07).
import { hash, verify } from './password.mjs';
import { isRole } from '../domain/roles.mjs';

export class DuplicateEmailError extends Error {
  constructor(email) {
    super(`an account already exists for ${email}`);
    this.name = 'DuplicateEmailError';
  }
}

// Normalize an email for storage and lookup: trim and lowercase, so
// `Alice@x` and `alice@x ` are one account and login is case-insensitive.
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null;
}

// Fields safe to return to callers — never the password hash.
const PUBLIC_COLUMNS = 'id, email, role, store_id, status';

// Create a user with a hashed password. Returns { id, email, role, store_id }.
export function createUser(db, { email, password, role, store_id = null }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) throw new TypeError('a valid email is required');
  if (!isRole(role)) throw new TypeError(`unknown role "${role}"`);
  const password_hash = hash(password);
  let info;
  try {
    info = db
      .prepare('INSERT INTO users (email, password_hash, role, store_id) VALUES (?, ?, ?, ?)')
      .run(normalized, password_hash, role, store_id);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new DuplicateEmailError(normalized);
    throw err;
  }
  return { id: Number(info.lastInsertRowid), email: normalized, role, store_id };
}

// Return the user row on a correct email+password, else null. The password is
// always verified (even when the email is unknown, against a dummy hash) so the
// timing does not reveal whether an email exists.
const DUMMY_HASH = hash('vm-dummy-password-not-used');

export function authenticate(db, email, password) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    verify(String(password ?? ''), DUMMY_HASH); // keep timing similar
    return null;
  }
  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = ?`).get(normalized);
  if (!row) {
    verify(String(password ?? ''), DUMMY_HASH); // keep timing similar for unknown emails
    return null;
  }
  if (!verify(password, row.password_hash)) return null;
  // Never hand the password hash back to callers.
  const { password_hash, ...safe } = row;
  void password_hash;
  return safe;
}
