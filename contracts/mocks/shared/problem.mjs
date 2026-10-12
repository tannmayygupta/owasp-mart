// The IF-8 error body for the mocks (contracts/errors/problem.schema.json). One place builds it, so a mock cannot invent a
// shape: `type`, `title`, `status`, `code`, `request_id` and, for a 422, `field` or `errors`. The title and the status come
// from the registry (contracts/errors/error-codes.yaml), never from the mock. No `detail`, no `instance`.
// Node and js-yaml only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_FILE = path.resolve(HERE, '..', '..', 'errors', 'error-codes.yaml');
export const TYPE_PREFIX = 'urn:vulnmart:error:';
export const MEDIA_TYPE = 'application/problem+json';

let cached = null;
export function registry() {
  if (cached === null) {
    const doc = yaml.load(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    cached = new Map(doc.codes.map((c) => [c.code, c]));
  }
  return cached;
}

const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

// A JSON Pointer from segments (names from the request, never values). Longer than 200 characters: the whole body ("").
export function pointer(...segments) {
  const p = segments.map((s) => '/' + esc(s)).join('');
  return p.length > 200 ? '' : p;
}

// The status of a code, from the registry (a code that never travels as an HTTP answer has none).
export function statusOf(code) {
  const c = registry().get(code);
  if (!c || c.status === null) throw new Error(`${code} is not a registered HTTP error code`);
  return c.status;
}

// `errors` is a list of { pointer, detail }; `field` and `errors` are 422 only and never together.
export function problemBody(code, requestId, { field, errors } = {}) {
  const c = registry().get(code);
  if (!c || c.status === null) throw new Error(`${code} is not a registered HTTP error code`);
  const body = { type: TYPE_PREFIX + code, title: c.title, status: c.status, code, request_id: requestId };
  if (c.status === 422) {
    if (errors && errors.length) body.errors = errors.slice(0, 50).map((e) => ({ pointer: String(e.pointer).length > 200 ? '' : String(e.pointer), detail: String(e.detail).slice(0, 200) }));
    else if (field !== undefined && field !== null) body.field = String(field).length > 200 ? '' : String(field);
  }
  return body;
}
