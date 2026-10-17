// Event relay of the edge (story edge-2, decision D-64). It only SHAPES traffic; it holds no event key and checks no signature (the ingest does).
//   Listener: POST /internal/v1/events only, one JSON object per request, at most 16 KiB, Content-Type application/json, a per-peer rate limit,
//   a 10 s limit for the whole request. The bytes are forwarded unchanged (same body, same X-VM-Signature) to the configured ingest URL.
//   Everything else is refused here and never reaches the ingest: 404 (path), 405 (method), 415 (content type), 413 (size), 401 (no signature header
//   of the right shape), 422 (not JSON, an array, a scalar), 429 (rate), 500 (the ingest cannot be reached).
// Errors use the IF-8 body (contracts/errors/problem.schema.json). The titles below are copied from the registry; a test compares them to it.
// Node built-ins only (the production image has no dependencies).
import crypto from 'node:crypto';
import http from 'node:http';

export const RELAY_PATH = '/internal/v1/events';
export const MAX_EVENT_BYTES = 16 * 1024;
export const SIGNATURE_HEADER = 'x-vm-signature';
const SIGNATURE_RE = /^v1=[0-9a-f]{64}$/;
const MAX_PEERS = 5000;
const MAX_ANSWER_BYTES = 65536;

export const PROBLEMS = {
  'REQ-ROUTE-UNKNOWN': [404, 'Route not found.'],
  'REQ-METHOD-NOT-ALLOWED': [405, 'Method not allowed.'],
  'REQ-UNSUPPORTED-MEDIA-TYPE': [415, 'The request must be JSON.'],
  'REQ-RATE-LIMITED': [429, 'Too many requests. Try again later.'],
  'REQ-INTERNAL': [500, 'Something went wrong. Try again later.'],
  'EVT-BAD-SIGNATURE': [401, 'The event could not be authenticated.'],
  'EVT-SCHEMA': [422, 'The event is not valid.'],
  'EVT-TOO-LARGE': [413, 'The event is too large.'],
};

/** What the instance side hears of an ingest answer: only a short fixed word (`status` of a 2xx) or a registry code, never the rest of the body. */
export function minimalAnswer(raw, statusCode) {
  const out = {};
  try {
    const b = JSON.parse(raw.toString('utf8'));
    if (b && typeof b === 'object') {
      if (typeof b.code === 'string' && b.code.length <= 40 && /^[A-Z]+(-[A-Z0-9]+)+$/.test(b.code)) out.code = b.code;
      else if (statusCode < 400 && typeof b.status === 'string' && /^[a-z]{1,16}$/.test(b.status)) out.status = b.status;
    }
  } catch { /* not JSON: the status code alone */ }
  return Buffer.from(JSON.stringify(out));
}

/** Fixed-window limit per key: at most `max` calls in `windowMs`. The table is bounded (an unknown peer is refused when it is full of live entries). */
export function createRateLimiter({ max = 120, windowMs = 10000, now = () => Date.now() } = {}) {
  const peers = new Map(); // key -> { start, count }
  return {
    allow(key) {
      const t = now();
      const cur = peers.get(key);
      if (cur && t - cur.start < windowMs) {
        cur.count += 1;
        return cur.count <= max;
      }
      if (!cur && peers.size >= MAX_PEERS) {
        for (const [k, v] of peers) if (t - v.start >= windowMs) peers.delete(k);
        if (peers.size >= MAX_PEERS) return false;
      }
      peers.set(key, { start: t, count: 1 });
      return true;
    },
    size: () => peers.size,
  };
}

/** The ingest origin of the configuration: http or https, no path, no credentials. Returns a URL or throws. */
export function parseIngestUrl(text) {
  let u;
  try { u = new URL(text); } catch { throw new Error('the ingest URL is not a URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error('the ingest URL must be an http(s) origin with no path, query or credentials');
  }
  return u;
}

export function createRelay({ ingestUrl, rateMax = 120, rateWindowMs = 10000, timeoutMs = 10000, now = () => Date.now(), maxBytes = MAX_EVENT_BYTES, log = () => {} } = {}) {
  const target = parseIngestUrl(ingestUrl);
  const limiter = createRateLimiter({ max: rateMax, windowMs: rateWindowMs, now });
  const client = target.protocol === 'https:' ? null : http; // https is not needed in the lab (private link); refuse rather than guess
  if (client === null) throw new Error('only an http ingest URL is supported (a private link; TLS belongs to the link)');

  function problem(res, code, extra = {}, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    const [status, title] = PROBLEMS[code];
    const body = JSON.stringify({ type: `urn:vulnmart:error:${code}`, title, status, code, request_id: crypto.randomBytes(8).toString('hex'), ...extra });
    res.writeHead(status, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers });
    res.end(body);
    log(`relay ${status} ${code}`);
  }

  function forward(req, res, body) {
    let finished = false;
    const done = (fn) => { if (!finished) { finished = true; clearTimeout(timer); fn(); } };
    const up = client.request({
      hostname: target.hostname, port: target.port || 80, method: 'POST', path: RELAY_PATH,
      headers: { 'content-type': 'application/json', 'content-length': body.length, [SIGNATURE_HEADER]: req.headers[SIGNATURE_HEADER] },
    }, (r) => {
      const chunks = [];
      let size = 0;
      r.on('data', (c) => { size += c.length; if (size <= MAX_ANSWER_BYTES) chunks.push(c); });
      r.on('end', () => done(() => {
        const out = minimalAnswer(Buffer.concat(chunks), r.statusCode);
        const headers = { 'content-length': out.length, 'cache-control': 'no-store', 'content-type': r.statusCode >= 400 ? 'application/problem+json' : 'application/json' };
        res.writeHead(r.statusCode, headers);
        res.end(out);
        log(`relay ${r.statusCode} forwarded`);
      }));
      r.on('error', () => done(() => problem(res, 'REQ-INTERNAL')));
    });
    const timer = setTimeout(() => up.destroy(new Error('timeout')), timeoutMs);
    timer.unref?.();
    up.on('error', () => done(() => problem(res, 'REQ-INTERNAL')));
    up.end(body);
  }

  function handle(req, res) {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.allow(peer)) {
      req.resume();
      return problem(res, 'REQ-RATE-LIMITED', {}, { 'retry-after': String(Math.ceil(rateWindowMs / 1000)) });
    }
    const url = req.url ?? '';
    if (url.split('?')[0] !== RELAY_PATH || url.includes('?')) { req.resume(); return problem(res, 'REQ-ROUTE-UNKNOWN'); }
    if (req.method !== 'POST') { req.resume(); return problem(res, 'REQ-METHOD-NOT-ALLOWED', {}, { allow: 'POST' }); }
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) { req.resume(); return problem(res, 'REQ-UNSUPPORTED-MEDIA-TYPE'); }
    const sig = req.headers[SIGNATURE_HEADER];
    if (typeof sig !== 'string' || !SIGNATURE_RE.test(sig)) { req.resume(); return problem(res, 'EVT-BAD-SIGNATURE'); }
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) > maxBytes)) {
      problem(res, 'EVT-TOO-LARGE', {}, { connection: 'close' });
      res.once('finish', () => req.destroy());
      return req.resume();
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > maxBytes) {
        over = true;
        chunks.length = 0;
        problem(res, 'EVT-TOO-LARGE', {}, { connection: 'close' });
        res.once('finish', () => req.destroy());
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (over) return;
      const body = Buffer.concat(chunks);
      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch {
        return problem(res, 'EVT-SCHEMA', { errors: [{ pointer: '', detail: 'The body is not JSON.' }] });
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return problem(res, 'EVT-SCHEMA', { errors: [{ pointer: '', detail: 'The body must be one event object.' }] });
      }
      return forward(req, res, body);
    });
    return undefined;
  }

  const server = http.createServer(handle);
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  return { server, handle, limiter };
}
