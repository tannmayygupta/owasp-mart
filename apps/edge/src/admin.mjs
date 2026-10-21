// Admin handlers of the gate (contracts/edge/gate-ticket.md section 5): the orchestrator pushes the access state here.
//   PUT    /internal/v1/gate/instances/{id}   one record          DELETE /internal/v1/gate/instances/{id}   remove it
//   PUT    /internal/v1/gate/sync             {"instances": [...]} the full list, all or nothing
//   GET    /internal/v1/gate/status           counts only (instances, used tickets, decide errors, the saved state): no ids, no owners
// Every call needs the header X-VM-Gate-Admin equal to the secret in a file (constant-time comparison). The secret is read from the file on each call
// (so a rotated file takes effect) and is never logged or returned. No sockets here: handle() takes a parsed request and returns { status, headers, body }.
import fs from 'node:fs';
import { INSTANCE_ID_RE, safeEqual } from './tickets.mjs';

export const ADMIN_HEADER = 'x-vm-gate-admin';
export const MIN_SECRET_CHARS = 16;
export const MAX_BODY_BYTES = { instance: 4096, sync: 1024 * 1024 };
const PREFIX = '/internal/v1/gate/';

const TITLES = { 400: 'Malformed request', 401: 'Unauthorized', 404: 'Not found', 405: 'Method not allowed', 409: 'Conflict', 413: 'Body too large', 415: 'Unsupported media type', 422: 'Invalid body' };
const problem = (status, detail, extra = {}) => ({
  status,
  headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...extra },
  body: JSON.stringify({ type: 'about:blank', title: TITLES[status] ?? 'Error', status, ...(detail ? { detail } : {}) }),
});
const noContent = () => ({ status: 204, headers: { 'cache-control': 'no-store' }, body: '' });

export function createAdmin({ store, secretFile, readFile = (f) => fs.readFileSync(f, 'utf8'), status = null }) {
  if (!store || typeof secretFile !== 'string' || !secretFile) throw new Error('createAdmin needs a store and a secretFile');

  function secret() {
    try {
      const s = readFile(secretFile).trim();
      return s.length >= MIN_SECRET_CHARS ? s : null; // a missing, empty or short secret refuses every call
    } catch {
      return null;
    }
  }

  function parseBody(req, limit) {
    const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return { fail: problem(415) };
    const raw = req.body === undefined || req.body === null ? '' : Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body), 'utf8');
    if (raw.length > limit) return { fail: problem(413) };
    try {
      return { json: JSON.parse(raw.toString('utf8')) };
    } catch {
      return { fail: problem(400, 'the body is not JSON') };
    }
  }

  return {
    handle(req) {
      try {
        const given = req?.headers?.[ADMIN_HEADER];
        const expected = secret();
        if (typeof given !== 'string' || expected === null || !safeEqual(given, expected)) return problem(401);
        const url = String(req.url ?? '');
        if (url.includes('?') || url.includes('#') || !url.startsWith(PREFIX)) return problem(404);
        const rest = url.slice(PREFIX.length);
        const method = req.method;
        if (rest === 'status' && status) {
          if (method !== 'GET') return problem(405, null, { allow: 'GET' });
          return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(status()) };
        }
        if (rest === 'sync') {
          if (method !== 'PUT') return problem(405, null, { allow: 'PUT' });
          const b = parseBody(req, MAX_BODY_BYTES.sync);
          if (b.fail) return b.fail;
          const r = store.sync(b.json);
          return r.status === 204 ? noContent() : problem(r.status, r.error);
        }
        if (rest.startsWith('instances/')) {
          const id = rest.slice('instances/'.length);
          if (!INSTANCE_ID_RE.test(id)) return problem(404);
          if (method === 'DELETE') return noContent(store.remove(id));
          if (method !== 'PUT') return problem(405, null, { allow: 'PUT, DELETE' });
          const b = parseBody(req, MAX_BODY_BYTES.instance);
          if (b.fail) return b.fail;
          const r = store.put(id, b.json);
          return r.status === 204 ? noContent() : problem(r.status, r.error);
        }
        return problem(404);
      } catch {
        return problem(400);
      }
    },
  };
}
