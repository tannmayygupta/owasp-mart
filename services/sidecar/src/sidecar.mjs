// The VulnMart sidecar (IF-4, IF-6 section 6, D-70, D-73, D-76).
//   9000: POST /v1/events from the shop (and the other instance services): answers 202, 400, 405, 413, 415, 422; adds instance_id, epoch and
//         the next seq, signs and delivers (outbox.mjs). GET /healthz for the container check. No other route.
//   8080: the player port. Requests and answers go through UNCHANGED (headers and body as received); only x-vm-* headers are removed. A bounded
//         copy of the answer (and of the first 8 KiB of the request) is kept on the side; after the bytes are written, the copy is decoded,
//         scanned for flags (matcher.mjs) and turned into proxy.flag_seen, evidence.capture and an aggregated proxy.request.
// The sidecar never blocks, delays on purpose, rewrites or drops player traffic: every step of the scan, the signing and the relay is
// caught, counted, alarmed with a fixed word and a counter (never a value) and ignored.
import http from 'node:http';
import { compile, closeServer, listen, schemaErrors, sendJson, sendProblem, POSTED_CAP_BYTES, SCHEMAS } from './common.mjs';
import { createOutbox } from './outbox.mjs';
import { createMatcher, SCAN_CAP_BYTES } from './matcher.mjs';
import { buildCapture, BODY_CAP_BYTES, requestRef } from './capture.mjs';
import { flagSeenEvent, evidenceCaptureEvent, proxyRequestEvent, crsMatchEvent, isoNow } from './events.mjs';
import { methodClass, routeTemplate } from './route.mjs';

export { SEQ_MAX, DEFAULT_STATE_PATH, loadCounter } from './outbox.mjs';
export { readStartDocument, startDocumentOk } from './start.mjs';

// Hop-by-hop headers and host: same handling as the stub's passThrough.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);
const INTERNAL_HEADER = /^x-vm-/i; // set by the platform's own parts; a player must not be able to send one, and none goes back out

// The hook for the request-side detection helper (story 6.5, Coraza and CRS, crs.mjs). The only place the helper is called. It is called
// after the player's answer has been handed to the socket, never throws, and resolves the proxy.crs_match data or null.
export function inspectRequest(crs, info) {
  if (!crs?.enabled) return undefined; // no helper: does nothing, as before story 6.5
  try { return crs.inspect(info).catch(() => null); } catch { return Promise.resolve(null); }
}

export function createSidecar({
  start,
  relayUrl = 'http://edge:8081/internal/v1/events',
  upstreamUrl = 'http://shop:3000',
  bufferMax = 1000,
  retryMinMs = 250,
  retryMaxMs = 4000,
  requestTimeoutMs = 3000,
  upstreamTimeoutMs = 10000,
  statePath = null, // main.mjs passes DEFAULT_STATE_PATH; a unit test passes a temp file or none
  alarm = (m) => console.error(m),
  scanCapBytes = SCAN_CAP_BYTES,
  aggregateMs = 10000,
  repeatWindowMs = 60000,
  maxAggregateKeys = 200,
  matcher: matcherOverride, // tests only: an object with scanResponse(buf, contentEncoding)
  crs = null, // the detection helper (crs.mjs createCrs), or null for none (--no-crs behaviour)
  now = Date.now,
} = {}) {
  const validatePosted = compile(SCHEMAS.posted);
  const validateWire = compile(SCHEMAS.wire);
  const outbox = createOutbox({ start, relayUrl, bufferMax, retryMinMs, retryMaxMs, requestTimeoutMs, statePath, alarm, validateWire });
  const { queue, stats } = outbox;
  Object.assign(stats, { requests: 0, scanned: 0, scan_skipped: 0, scan_errors: 0, flag_events: 0, evidence_events: 0, flag_repeats: 0, emit_errors: 0, aggregate_overflow: 0, crs_events: 0, crs_errors: 0 });

  // A counted alarm: the first few, then every hundredth. A fixed word and a counter, never a value.
  const counts = new Map();
  function alarmCounted(word) {
    const n = (counts.get(word) ?? 0) + 1;
    counts.set(word, n);
    if (n <= 3 || n % 100 === 0) { try { alarm(`alarm: ${word} count=${n}`); } catch { /* the alarm sink must not break traffic */ } }
  }

  let matcher = matcherOverride ?? null;
  if (!matcher) {
    try { matcher = createMatcher(start.flag_digests); } catch { matcher = null; alarmCounted('flag digest set unusable, matcher off'); }
  }

  // ---- emitting (never throws) ----
  function emit(event, options) {
    try { return outbox.submit(event, { check: false, ...options }); } catch { stats.emit_errors += 1; alarmCounted('event could not be queued'); return false; }
  }

  // ---- aggregated proxy.request: one event per (method, route, status) per window, with a count ----
  let agg = new Map();
  function record(method, route, status, respLen) {
    const k = `${method} ${status} ${route}`;
    const a = agg.get(k);
    if (a) { a.count += 1; a.respLen = Math.max(a.respLen, respLen); return; }
    if (agg.size >= maxAggregateKeys) { stats.aggregate_overflow += 1; return; }
    agg.set(k, { method, route, status, respLen, count: 1 });
  }
  function flushAggregate() {
    const batch = agg;
    agg = new Map();
    const ts = isoNow(now);
    for (const a of batch.values()) {
      emit(proxyRequestEvent({ method: a.method, routeTemplate: a.route, status: a.status, respLen: a.respLen, count: a.count, ts }), { low: true });
    }
  }
  const timer = setInterval(() => { try { flushAggregate(); } catch { alarmCounted('summary flush failed'); } }, aggregateMs);
  timer.unref();

  // ---- the same candidate on the same route is reported once per window ----
  const recent = new Map(); // `${sha}|${method}|${route}` -> time first sent
  function isRepeat(sha, method, route) {
    const t = now();
    const k = `${sha}|${method}|${route}`;
    const seen = recent.get(k);
    if (seen !== undefined && t - seen < repeatWindowMs) return true;
    if (recent.size > 5000) for (const [kk, v] of recent) if (t - v >= repeatWindowMs) recent.delete(kk);
    recent.set(k, t);
    return false;
  }

  // ---- the scan of one finished response; runs after the bytes were written, on the copy ----
  async function scanOne({ method, url, route, reqHeaders, reqBody, respBuf, respEncoding }) {
    if (!matcher) return;
    const result = await matcher.scanResponse(respBuf, respEncoding);
    if (result.skipped) { stats.scan_skipped += 1; return; }
    stats.scanned += 1;
    let ref = null;
    for (const c of result.candidates) {
      if (isRepeat(c.sha256, method, route)) { stats.flag_repeats += 1; continue; }
      ref ??= requestRef();
      const ts = isoNow(now);
      if (emit(flagSeenEvent({ candidate: c, routeTemplate: route, requestRef: ref, ts }))) stats.flag_events += 1;
      if (c.kind === 'real') {
        const capture = buildCapture({ method, url, headers: reqHeaders, bodyBuf: reqBody });
        if (emit(evidenceCaptureEvent({ challengeKey: c.challenge_key, requestRef: ref, capture, ts }))) stats.evidence_events += 1;
      }
    }
  }

  // The request, asked about after the answer was written; a match becomes one proxy.crs_match. Anything that goes wrong is ignored.
  async function crsOne(info) {
    const data = await inspectRequest(crs, { method: info.method, url: info.url, headers: info.reqHeaders, bodyBuf: info.reqBody });
    if (!data) return;
    if (emit(crsMatchEvent({ data, routeTemplate: info.route, ts: isoNow(now) }), { low: true })) stats.crs_events += 1;
  }

  function afterResponse(info) {
    try { record(info.method, info.route, info.status, info.respLen); } catch { alarmCounted('summary record failed'); }
    if (crs?.enabled) setImmediate(() => { crsOne(info).catch(() => { stats.crs_errors += 1; alarmCounted('crs call failed'); }); });
    if (info.skipScan) { stats.scan_skipped += 1; return; }
    if (!info.respBuf.length) return;
    // a macrotask later: the answer has been handed to the socket before any scan work starts
    setImmediate(() => { scanOne(info).catch(() => { stats.scan_errors += 1; alarmCounted('scan failed'); }); });
  }

  // ---- 9000: events from the shop ----
  const events = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/healthz' && req.method === 'GET') return sendJson(res, 200, { status: 'ok' });
    if (path !== '/v1/events') return sendProblem(res, 404, 'Not found');
    if (req.method !== 'POST') return sendProblem(res, 405, 'Method not allowed');
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return sendProblem(res, 415, 'Unsupported media type');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > POSTED_CAP_BYTES) {
        chunks.length = 0;
        sendProblem(res, 413, 'Event too large', { code: 'EVT-TOO-LARGE' });
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let posted;
      try { posted = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendProblem(res, 400, 'The body is not JSON'); }
      const errors = posted !== null && typeof posted === 'object' && !Array.isArray(posted) ? schemaErrors(validatePosted, posted) : [{ path: '', message: 'must be object' }];
      let queued = false;
      try { queued = !errors.length && outbox.submit(posted, { check: true }); } catch { return sendProblem(res, 503, 'The sidecar cannot give this event a sequence number'); }
      if (errors.length || !queued) return sendProblem(res, 422, 'Event does not match the schema', { code: 'EVT-SCHEMA', errors: errors.length ? errors : [{ path: '', message: 'wire event does not match the schema' }] });
      return sendJson(res, 202, { status: 'queued' });
    });
  });

  // ---- 8080: the player port ----
  const target = new URL(upstreamUrl);
  const player = http.createServer((req, res) => {
    stats.requests += 1;
    // the request copy: the first 8 KiB of the body, for the evidence of a flag-capturing request
    const reqChunks = [];
    let reqLen = 0;
    req.on('data', (c) => {
      try { if (reqLen < BODY_CAP_BYTES) { const part = c.subarray(0, BODY_CAP_BYTES - reqLen); reqChunks.push(part); reqLen += part.length; } } catch { /* the copy is best effort */ }
    });

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !INTERNAL_HEADER.test(k)) headers[k] = v;
    const method = req.method;
    const url = req.url;
    const up = http.request({ hostname: target.hostname, port: target.port || 80, method, path: url, headers, timeout: upstreamTimeoutMs }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) && !INTERNAL_HEADER.test(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      // The upstream broke off after the headers were sent: the client must not be left waiting for the rest of the body.
      r.on('error', () => res.destroy());
      r.on('close', () => { if (!r.complete) res.destroy(); });
      // the answer copy, bounded; the pipe above is the only path the bytes take to the player
      const copy = [];
      let total = 0;
      let over = false;
      r.on('data', (c) => {
        try {
          total += c.length;
          if (over) return;
          if (total > scanCapBytes) { over = true; copy.length = 0; return; }
          copy.push(c);
        } catch { over = true; }
      });
      r.on('end', () => {
        try {
          afterResponse({
            method: methodClass(method), url, route: routeTemplate(url), reqHeaders: req.headers, reqBody: Buffer.concat(reqChunks),
            status: Math.min(Math.max(r.statusCode || 502, 100), 599), respLen: total,
            respBuf: over ? Buffer.alloc(0) : Buffer.concat(copy), respEncoding: r.headers['content-encoding'], skipScan: over,
          });
        } catch { stats.scan_errors += 1; alarmCounted('response bookkeeping failed'); }
      });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (res.headersSent) res.destroy(); else sendProblem(res, 502, 'Bad gateway'); });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  });

  return {
    events, player, stats, queue, flushAggregate, crs,
    nextSeq: outbox.nextSeq,
    async listen({ eventsPort = 9000, playerPort = 8080, host = '0.0.0.0' } = {}) {
      return { eventsPort: await listen(events, eventsPort, host), playerPort: await listen(player, playerPort, host) };
    },
    async stop() { clearInterval(timer); try { crs?.stop(); } catch { /* gone */ } outbox.stop(); await Promise.all([closeServer(events), closeServer(player)]); },
  };
}
