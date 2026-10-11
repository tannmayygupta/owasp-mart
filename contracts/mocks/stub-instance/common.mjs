// Shared helpers of the stub instance (story L-06). The stub exists only for tests; it is never a product image.
// Node built-ins plus Ajv (already a dev dependency of the repository). Nothing here prints a flag, a seed or a key.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// In the repository this is the repository root; in the image it is /app (same layout, see Dockerfile).
export const ROOT = path.resolve(HERE, '..', '..', '..');
export const SCHEMAS = {
  injection: path.join(ROOT, 'contracts', 'instance', 'injection-document.schema.json'),
  flags: path.join(ROOT, 'contracts', 'instance', 'flags-file.schema.json'),
  sidecarStart: path.join(ROOT, 'contracts', 'instance', 'sidecar-start.schema.json'),
  wire: path.join(ROOT, 'contracts', 'events', 'instance-events.schema.json'),
  posted: path.join(ROOT, 'contracts', 'events', 'instance-events.posted.schema.json'),
};

export const STUB_BUILD_ID = 'stub-l06';
export const POSTED_CAP_BYTES = 4096; // IF-4 section 3: body posted to the sidecar

export function compile(file) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function parse(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { return { ok: false, reason: 'not-utf8' }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, reason: 'not-json' }; }
}

// Reads the one document on standard input. Resolves { ok: true, value } or { ok: false, reason } where reason is a fixed word
// (never a part of the document): "too-large", "not-utf8", "empty", "not-json", "not-object", "trailing-data", "timeout".
// The document must be one JSON object. It ends at the end of the input OR as soon as the object is complete (a container made by
// Compose has no "stdin once" flag, so Docker does not close its input). Anything but white space after the object is a bad document
// (data that arrives within graceMs of the end of the object is seen; later data cannot be). Input that never completes is a bad
// document after deadlineMs.
export function readDocument(stream = process.stdin, maxBytes = 65536, { deadlineMs = 10000, graceMs = 100 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    // scanner state: first byte seen, brace depth, inside a string, after a backslash, index just past the object
    let started = false; let depth = 0; let inStr = false; let esc = false; let end = -1; let pos = 0;
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
    const complete = () => {
      const buf = whole();
      if (buf.subarray(end).some((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)) return finish({ ok: false, reason: 'trailing-data' });
      return finish(parse(buf.subarray(0, end)));
    };
    stream.on('data', (chunk) => {
      if (done) return;
      const c = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += c.length;
      if (size > maxBytes) return finish({ ok: false, reason: 'too-large' });
      chunks.push(c);
      if (end >= 0) { if (c.some((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)) finish({ ok: false, reason: 'trailing-data' }); return; }
      for (let i = 0; i < c.length; i++, pos++) {
        const b = c[i];
        if (!started) {
          if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) continue;
          if (b !== 0x7b) return finish({ ok: false, reason: 'not-object' }); // an array, a number, a string, a byte-order mark, text
          started = true; depth = 1; continue;
        }
        if (inStr) { if (esc) esc = false; else if (b === 0x5c) esc = true; else if (b === 0x22) inStr = false; continue; }
        if (b === 0x22) inStr = true;
        else if (b === 0x7b || b === 0x5b) depth++;
        else if (b === 0x7d || b === 0x5d) { depth--; if (depth === 0) { end = pos + 1; break; } }
      }
      if (end >= 0) {
        const buf = whole();
        if (buf.length > end) return complete(); // the rest arrived with the object
        grace = setTimeout(complete, graceMs); // wait briefly for more data or the end of the input
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
  const body = JSON.stringify({ type: 'about:blank', title, status, request_id: `stub-${counter}`, ...extra });
  res.writeHead(status, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(body), ...(status === 405 ? { allow: 'POST' } : {}) });
  res.end(body);
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

// Pass-through: forwards the request and the answer unchanged (method, path with query, headers, body bytes).
export function passThrough(upstream, { timeoutMs = 10000 } = {}) {
  const target = new URL(upstream);
  return (req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const up = http.request({ hostname: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers, timeout: timeoutMs }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      // The upstream broke off after the headers were sent: the client must not be left waiting for the rest of the body.
      r.on('error', () => res.destroy());
      r.on('close', () => { if (!r.complete) res.destroy(); });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (res.headersSent) res.destroy(); else sendProblem(res, 502, 'Bad gateway'); });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  };
}

export function listen(server, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}

export const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
export const logLine = (...parts) => console.log(parts.join(' '));
export const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
