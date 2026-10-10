// Stub sidecar (IF-4 sections 3 to 6, IF-6 section 6). Real behaviour only where the event contract needs it:
//   - reads ONE start document from standard input (schema sidecar-start.schema.json), once, at start; holds the event key in memory only
//   - 9000: POST /v1/events from the shop. Answers 202, 400, 405, 413, 415, 422 (IF-4 section 3). GET /healthz for the container check.
//     On accept it adds instance_id and the next seq (starting at first_seq), validates the wire event, signs it (X-VM-Signature) and queues it.
//   - delivery to the edge relay (POST /internal/v1/events): keeps the event until 202 or 200; drops it on 401, 409, 413, 422 with a local
//     alarm (a line with seq and status only); retries on no answer or any other status; the buffer is bounded (oldest dropped first)
//   - 8080: pass-through of player traffic to the shop (no proxy events in the stub)
// It never prints a body, a key or a flag.
import http from 'node:http';
import { compile, listen, passThrough, POSTED_CAP_BYTES, readDocument, sendJson, sendProblem, SCHEMAS, closeServer } from './common.mjs';
import { semanticSidecarStart } from './semantic.mjs';
import { compileEventSchema, schemaErrors } from '../fake-ingest/ingest.mjs';
import { signBody, SIGNATURE_HEADER } from '../fake-ingest/sign.mjs';

export const DROP_STATUSES = new Set([401, 409, 413, 422]);
export const DONE_STATUSES = new Set([200, 202]);

let validateStart;
// True when the document passes the schema and the shared semantic rules (the same verdict as scripts/validate-contracts.mjs).
export function startDocumentOk(doc) {
  validateStart ??= compile(SCHEMAS.sidecarStart);
  return validateStart(doc) === true && semanticSidecarStart(doc).length === 0;
}

export async function readStartDocument(stream = process.stdin, readOptions) {
  const read = await readDocument(stream, 65536, readOptions);
  return read.ok && startDocumentOk(read.value) ? { ok: true, start: read.value } : { ok: false };
}

export function createSidecar({
  start,
  relayUrl = 'http://edge:8081/internal/v1/events',
  upstreamUrl = 'http://shop:3000',
  bufferMax = 1000,
  retryMinMs = 250,
  retryMaxMs = 4000,
  requestTimeoutMs = 3000,
  alarm = (m) => console.error(m),
} = {}) {
  const validatePosted = compileEventSchema(SCHEMAS.posted);
  const validateWire = compileEventSchema(SCHEMAS.wire);
  const relay = new URL(relayUrl);
  const key = start.event_key;
  let nextSeq = start.first_seq;
  const queue = []; // { seq, body }
  const stats = { accepted: 0, delivered: 0, dropped: 0, overflowed: 0, retries: 0 };
  let pumping = false;
  let stopped = false;
  let wake = null;

  function post(item) {
    return new Promise((resolve) => {
      const body = Buffer.from(item.body, 'utf8');
      const req = http.request({
        hostname: relay.hostname, port: relay.port || 80, path: relay.pathname, method: 'POST', timeout: requestTimeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': body.length, [SIGNATURE_HEADER.toLowerCase()]: signBody(key, start.instance_id, item.seq, body) },
      }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(0));
      req.end(body);
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    let delay = retryMinMs;
    while (queue.length && !stopped) {
      const item = queue[0];
      const status = await post(item);
      const i = queue.indexOf(item);
      if (DONE_STATUSES.has(status)) { if (i >= 0) queue.splice(i, 1); stats.delivered += 1; delay = retryMinMs; continue; }
      if (DROP_STATUSES.has(status)) {
        if (i >= 0) queue.splice(i, 1);
        stats.dropped += 1;
        alarm(`alarm: event seq=${item.seq} dropped, the ingest answered ${status}`);
        continue;
      }
      stats.retries += 1; // no answer, or an answer that retrying may fix (for example 5xx)
      await new Promise((r) => { wake = r; setTimeout(r, delay).unref(); });
      wake = null;
      delay = Math.min(delay * 2, retryMaxMs);
    }
    pumping = false;
  }

  function enqueue(posted) {
    const event = { ...posted, instance_id: start.instance_id, seq: nextSeq };
    // Property order is fixed so the signed bytes are exactly what is sent.
    const wire = { schema_version: event.schema_version, instance_id: event.instance_id, seq: event.seq, type: event.type, source: event.source, session_kind: event.session_kind, user_id: event.user_id, ts: event.ts, ...(event.challenge_key !== undefined ? { challenge_key: event.challenge_key } : {}), data: event.data };
    if (schemaErrors(validateWire, wire).length) return false;
    nextSeq += 1;
    if (queue.length >= bufferMax) {
      const gone = queue.shift();
      stats.overflowed += 1;
      alarm(`alarm: buffer full, event seq=${gone.seq} dropped`);
    }
    queue.push({ seq: wire.seq, body: JSON.stringify(wire) });
    stats.accepted += 1;
    pump();
    return true;
  }

  // 9000: events from the shop
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
      if (errors.length || !enqueue(posted)) return sendProblem(res, 422, 'Event does not match the schema', { code: 'EVT-SCHEMA', errors: errors.length ? errors : [{ path: '', message: 'wire event does not match the schema' }] });
      return sendJson(res, 202, { status: 'queued' });
    });
  });

  // 8080: player traffic to the shop
  const player = http.createServer(passThrough(upstreamUrl));

  return {
    events, player, stats, queue,
    nextSeq: () => nextSeq,
    async listen({ eventsPort = 9000, playerPort = 8080, host = '0.0.0.0' } = {}) {
      return { eventsPort: await listen(events, eventsPort, host), playerPort: await listen(player, playerPort, host) };
    },
    async stop() { stopped = true; if (wake) wake(); await Promise.all([closeServer(events), closeServer(player)]); },
  };
}
