// Shared helpers of the sidecar: schema loading, the one-document reader for standard input, small HTTP answers, flag parsing.
// Behaviour is carried over from the tested stub sidecar helpers (contracts/mocks/stub-instance/common.mjs); nothing here prints a flag,
// a digest or a key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The schemas are copies of the contract files (scripts/sync-schemas.mjs); a test compares them byte for byte.
export const SCHEMA_DIR = path.resolve(HERE, '..', 'schemas');
export const SCHEMAS = {
  sidecarStart: path.join(SCHEMA_DIR, 'sidecar-start.schema.json'),
  wire: path.join(SCHEMA_DIR, 'instance-events.schema.json'),
  posted: path.join(SCHEMA_DIR, 'instance-events.posted.schema.json'),
};

export const POSTED_CAP_BYTES = 4096; // IF-4 section 3: body posted to the sidecar

// A schema the contract says is strict; strictRequired is off because "required" inside if/then refers to properties of the parent.
export function compile(file) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Rules that compare two fields of a wire event and so cannot be written in JSON Schema (same as the fake ingest).
function semanticEvent(event) {
  const out = [];
  if (event && event.type === 'proxy.flag_seen' && event.data && typeof event.data === 'object'
    && event.challenge_key !== undefined && event.data.challenge_key !== undefined && event.challenge_key !== event.data.challenge_key) {
    out.push({ path: '/challenge_key', message: 'must equal data.challenge_key when both are present' });
  }
  return out;
}

const FLAG_NAME = /[Vv][Mm](?:\{|%7[Bb]|｛)[^/]*/g;
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
function errorPath(e) {
  let p = e.instancePath || '';
  if (e.params && e.params.missingProperty !== undefined) p += '/' + esc(e.params.missingProperty);
  else if (e.params && e.params.additionalProperty !== undefined) p += '/' + esc(e.params.additionalProperty);
  else if (e.propertyName !== undefined) p += '/' + esc(e.propertyName);
  return p.replace(FLAG_NAME, '<redacted>');
}

// Errors as { path, message }. A message never holds the offending value, so a flag-like string is never echoed.
export function schemaErrors(validate, data) {
  const seen = new Set();
  const out = [];
  const add = (p, m) => { const k = `${p}|${m}`; if (!seen.has(k)) { seen.add(k); out.push({ path: p, message: m }); } };
  if (!validate(data)) {
    for (const e of validate.errors) {
      if (e.keyword === 'if') continue;
      add(errorPath(e), e.message);
    }
  } else {
    for (const s of semanticEvent(data)) add(s.path, s.message);
  }
  return out;
}

function parse(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { return { ok: false, reason: 'not-utf8' }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, reason: 'not-json' }; }
}

// Reads the one document on standard input. Resolves { ok: true, value } or { ok: false, reason } where reason is a fixed word
// (never a part of the document). The document is one JSON object. It ends at the end of the input OR as soon as the object is complete
// (a container made by Compose has no "stdin once" flag, so Docker does not close its input). Anything but white space after the object
// is a bad document. Input that never completes is a bad document after deadlineMs.
export function readDocument(stream = process.stdin, maxBytes = 65536, { deadlineMs = 10000, graceMs = 100 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let started = false; let depth = 0; let inStr = false; let esc2 = false; let end = -1; let pos = 0;
    let grace = null;
    const deadline = setTimeout(() => finish({ ok: false, reason: 'timeout' }), deadlineMs);
    deadline.unref?.();
    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(deadline); clearTimeout(grace);
      stream.removeAllListeners('data');
      stream.resume?.();
      resolve(r);
    }
    const whole = () => Buffer.concat(chunks);
    const white = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
    const complete = () => {
      const buf = whole();
      if (buf.subarray(end).some((b) => !white(b))) return finish({ ok: false, reason: 'trailing-data' });
      return finish(parse(buf.subarray(0, end)));
    };
    stream.on('data', (chunk) => {
      if (done) return;
      const c = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += c.length;
      if (size > maxBytes) return finish({ ok: false, reason: 'too-large' });
      chunks.push(c);
      if (end >= 0) { if (c.some((b) => !white(b))) finish({ ok: false, reason: 'trailing-data' }); return; }
      for (let i = 0; i < c.length; i++, pos++) {
        const b = c[i];
        if (!started) {
          if (white(b)) continue;
          if (b !== 0x7b) return finish({ ok: false, reason: 'not-object' });
          started = true; depth = 1; continue;
        }
        if (inStr) { if (esc2) esc2 = false; else if (b === 0x5c) esc2 = true; else if (b === 0x22) inStr = false; continue; }
        if (b === 0x22) inStr = true;
        else if (b === 0x7b || b === 0x5b) depth++;
        else if (b === 0x7d || b === 0x5d) { depth--; if (depth === 0) { end = pos + 1; break; } }
      }
      if (end >= 0) {
        const buf = whole();
        if (buf.length > end) return complete();
        grace = setTimeout(complete, graceMs);
        grace.unref?.();
      }
    });
    stream.on('error', () => finish({ ok: false, reason: 'empty' }));
    stream.on('end', () => {
      if (done) return;
      if (end >= 0) return complete();
      finish(chunks.length ? { ok: false, reason: started ? 'not-json' : 'empty' } : { ok: false, reason: 'empty' });
    });
  });
}

export function parseFlags(argv, defaults) {
  const o = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${a}`);
    o[a.slice(2)] = argv[++i];
  }
  return o;
}

let counter = 0;
export function sendProblem(res, status, title, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  counter += 1;
  const body = JSON.stringify({ type: 'about:blank', title, status, request_id: `sidecar-${counter}`, ...extra });
  res.writeHead(status, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(body), ...(status === 405 ? { allow: 'POST' } : {}) });
  res.end(body);
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

export function listen(server, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}

export const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
