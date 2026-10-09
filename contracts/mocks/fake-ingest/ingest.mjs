// Fake ingest for instance events (IF-4). Verifies the signature, the size, the schema and duplicates, and stores
// accepted events in memory. It answers exactly as contracts/events/app-events.md section 5 says. It is a stand-in for the real
// ingest (stream L); it never writes to disk and never prints event data. Node, Ajv and node:crypto only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { verifySignature } from './sign.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCHEMA = path.resolve(HERE, '..', '..', 'events', 'instance-events.schema.json');
export const LIMITS = { maxBodyBytes: 16 * 1024, evidenceBodyBytes: 8 * 1024, skewMs: 10 * 60 * 1000, maxStored: 100000 };
const INSTANCE_ID = /^i-[A-Z2-7]{16}$/;
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
// Used for unknown instances so that both branches do the same HMAC work (no timing difference). Not a real key.
const DUMMY_KEY = 'FAKE-DUMMY-KEY-FOR-UNKNOWN-INSTANCES-0000';
const FLAG_NAME = /[Vv][Mm](?:\{|%7[Bb]|｛)[^/]*/g;

// JSON Pointer of the thing a validation error is about. A property name that looks like a flag is never echoed.
export function errorPath(e) {
  let p = e.instancePath || '';
  if (e.params && e.params.missingProperty !== undefined) p += '/' + esc(e.params.missingProperty);
  else if (e.params && e.params.additionalProperty !== undefined) p += '/' + esc(e.params.additionalProperty);
  else if (e.propertyName !== undefined) p += '/' + esc(e.propertyName);
  return redactPath(p);
}

export function redactPath(p) {
  return String(p).replace(FLAG_NAME, '<redacted>');
}

// Compile a wire-event schema. strictRequired is off because "required" inside if/then refers to properties declared in the parent.
export function compileEventSchema(file = DEFAULT_SCHEMA) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Rules that compare two fields and so cannot be written in JSON Schema. Returns [{ path, message }].
export function semanticEvent(event) {
  const out = [];
  if (event && event.type === 'proxy.flag_seen' && event.data && typeof event.data === 'object'
    && event.challenge_key !== undefined && event.data.challenge_key !== undefined && event.challenge_key !== event.data.challenge_key) {
    out.push({ path: '/challenge_key', message: 'must equal data.challenge_key when both are present' });
  }
  return out;
}

// Errors as { path, message } pairs. The message never holds the offending value, so a flag-like string is never echoed.
export function schemaErrors(validate, data) {
  const seen = new Set();
  const out = [];
  const add = (p, m) => { const k = `${p}|${m}`; if (!seen.has(k)) { seen.add(k); out.push({ path: p, message: m }); } };
  if (!validate(data)) {
    for (const e of validate.errors) {
      if (e.keyword === 'if') continue; // the "must match then schema" wrapper adds no information
      add(errorPath(e), e.message);
    }
  } else {
    for (const s of semanticEvent(data)) add(s.path, s.message);
  }
  return out;
}

const PROBLEM = {
  signature: { status: 401, code: 'EVT-BAD-SIGNATURE', title: 'Signature check failed' },
  schema: { status: 422, code: 'EVT-SCHEMA', title: 'Event does not match the schema' },
  large: { status: 413, code: 'EVT-TOO-LARGE', title: 'Event too large' },
  mismatch: { status: 409, code: 'EVT-DUPLICATE-MISMATCH', title: 'Same (instance_id, seq) with a different body' },
  full: { status: 503, code: 'EVT-STORE-FULL', title: 'Fake ingest store is full' },
};

// keys: Map or object { instance_id: key }, the per-instance event key of each instance this ingest knows.
export function createIngest({ keys, schemaFile = DEFAULT_SCHEMA, now = () => Date.now(), limits = {} } = {}) {
  const cfg = { ...LIMITS, ...limits };
  const keyOf = keys instanceof Map ? keys : new Map(Object.entries(keys || {}));
  const validate = compileEventSchema(schemaFile);
  const stored = [];
  const seen = new Map(); // "instance_id#seq" -> SHA-256 hex of the body that was stored
  const security = []; // security events raised on 401 (kind, claimed instance, seq); never the body
  let requestCounter = 0;

  const reply = (status, body, problem = false) => ({
    status,
    headers: { 'content-type': problem ? 'application/problem+json' : 'application/json' },
    body,
  });
  const problem = (kind, message, errors) => {
    const p = PROBLEM[kind];
    requestCounter += 1;
    return reply(p.status, { type: 'about:blank', title: p.title, status: p.status, code: p.code, message, request_id: `fake-${requestCounter}`, ...(errors ? { errors } : {}) }, true);
  };
  const header = (headers, name) => {
    for (const k of Object.keys(headers || {})) if (k.toLowerCase() === name) return headers[k];
    return undefined;
  };

  function handle({ headers = {}, body = '' } = {}) {
    // The signature covers the raw bytes, so everything below that needs the bytes uses `raw`.
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (raw.length > cfg.maxBodyBytes) return problem('large', `the body is above ${cfg.maxBodyBytes} bytes`);
    // Invalid UTF-8 bytes decode to U+FFFD for parsing; the answer then depends on the schema (accepted or 422) and the signature still covers the original bytes.
    const text = raw.toString('utf8');

    const ctype = String(header(headers, 'content-type') || '');
    if (!/^application\/json(\s*;|$)/i.test(ctype)) return problem('schema', 'content type must be application/json', [{ path: '', message: 'content type must be application/json' }]);
    let event;
    try { event = JSON.parse(text); } catch { return problem('schema', 'the body is not valid JSON', [{ path: '', message: 'the body is not valid JSON' }]); }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return problem('schema', 'the body must be a JSON object', [{ path: '', message: 'must be object' }]);

    // The signature covers instance_id and seq, so both must be usable before it can be checked.
    const bad = [];
    if (typeof event.instance_id !== 'string' || !INSTANCE_ID.test(event.instance_id)) bad.push({ path: '/instance_id', message: 'must be a string like i-<16 Base32 characters>' });
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) bad.push({ path: '/seq', message: 'must be an integer of at least 1' });
    if (bad.length) return problem('schema', 'instance_id and seq are needed to check the signature', bad);

    const key = keyOf.get(event.instance_id);
    const sig = header(headers, 'x-vm-signature');
    // Both branches do one HMAC, so an unknown instance costs the same time as a wrong signature.
    const signatureOk = verifySignature(key === undefined ? DUMMY_KEY : key, event.instance_id, event.seq, raw, sig);
    if (key === undefined) {
      security.push({ kind: 'unknown_instance', instance_id: event.instance_id, seq: event.seq });
      return problem('signature', 'the signature does not verify');
    }
    if (!signatureOk) {
      security.push({ kind: 'bad_signature', instance_id: event.instance_id, seq: event.seq });
      return problem('signature', 'the signature does not verify');
    }

    if (event.type === 'evidence.capture' && event.data && typeof event.data.body === 'string' && Buffer.byteLength(event.data.body, 'utf8') > cfg.evidenceBodyBytes) {
      return problem('large', `evidence.capture body is above ${cfg.evidenceBodyBytes} bytes`);
    }
    const errors = schemaErrors(validate, event);
    if (errors.length) return problem('schema', 'the event does not match the schema', errors);
    const t = Date.parse(event.ts);
    if (Number.isNaN(t)) return problem('schema', 'ts is not a usable time', [{ path: '/ts', message: 'ts is not a usable time' }]);
    if (t > now() + cfg.skewMs) return problem('schema', `ts is more than ${cfg.skewMs / 60000} minutes in the future`, [{ path: '/ts', message: 'is too far in the future' }]);

    const id = `${event.instance_id}#${event.seq}`;
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    if (seen.has(id)) {
      if (seen.get(id) === digest) return reply(200, { status: 'duplicate', instance_id: event.instance_id, seq: event.seq });
      return problem('mismatch', 'this (instance_id, seq) was already accepted with a different body');
    }
    if (stored.length >= cfg.maxStored) return problem('full', `the fake ingest keeps at most ${cfg.maxStored} events`);
    seen.set(id, digest);
    stored.push({ received_at: new Date(now()).toISOString(), event });
    return reply(202, { status: 'accepted', instance_id: event.instance_id, seq: event.seq });
  }

  return { handle, stored, security };
}
