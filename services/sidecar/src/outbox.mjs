// The event outbox: gives each event its instance_id, epoch and seq, signs it (IF-4 section 4) and delivers it to the edge relay.
// Carried over from the tested stub sidecar (contracts/mocks/stub-instance/sidecar.mjs) with one addition: events the sidecar builds
// itself can be marked "low" (proxy.request summaries); when the buffer is full the oldest low event goes first and a flag, evidence or
// shop event is only dropped when nothing low is left (architecture 05 flow 4, IF-4 section 5).
//   - the seq counter is write-ahead: the next value is saved to a small state file BEFORE the event is queued, so a restart inside one
//     epoch continues from the saved value and never reuses a seq (a crash can leave a gap, which IF-4 allows)
//   - delivery: POST /internal/v1/events to the relay; keeps an event until 202 or 200; drops it on 401, 409, 413, 422 with a local
//     alarm (a line with seq and status only); retries on no answer or any other status; the buffer is bounded
// It never prints a body, a key or a flag.
import fs from 'node:fs';
import http from 'node:http';
import { schemaErrors } from './common.mjs';
import { signBody, SIGNATURE_HEADER } from './sign.mjs';

// The sidecar lane of IF-4 (app-events.md section 6): seq 1 to 2^40-1. Higher values belong to the orchestrator and the platform.
export const SEQ_MAX = 2 ** 40 - 1;
export const DEFAULT_STATE_PATH = '/tmp/vm-sidecar-seq.json';
export const DROP_STATUSES = new Set([401, 409, 413, 422]);
export const DONE_STATUSES = new Set([200, 202]);

// The next seq to use for this (instance, epoch): 1 when there is no state file or it is of an earlier epoch; the saved value when it is
// of this epoch. A state file that is unreadable, of another instance, or of a LATER epoch than the start document is an error (starting
// at 1 could reuse a seq), so the caller refuses to start.
export function loadCounter(statePath, start) {
  if (!statePath) return 1;
  let text;
  try { text = fs.readFileSync(statePath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return 1; throw new Error('sidecar state file is unreadable'); }
  let s;
  try { s = JSON.parse(text); } catch { throw new Error('sidecar state file is not JSON'); }
  if (s === null || typeof s !== 'object' || s.instance_id !== start.instance_id || !Number.isSafeInteger(s.epoch) || !Number.isSafeInteger(s.next_seq) || s.next_seq < 1) throw new Error('sidecar state file does not match this instance');
  if (s.epoch > start.epoch) throw new Error('sidecar state file is of a later epoch than the start document');
  return s.epoch === start.epoch ? s.next_seq : 1;
}

// Atomic save (write a temp file, then rename), so a crash never leaves a half-written counter.
function saveCounter(statePath, start, nextSeq) {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ instance_id: start.instance_id, epoch: start.epoch, next_seq: nextSeq }), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

export function createOutbox({
  start,
  relayUrl = 'http://edge:8081/internal/v1/events',
  bufferMax = 1000,
  retryMinMs = 250,
  retryMaxMs = 4000,
  requestTimeoutMs = 3000,
  statePath = null,
  alarm = (m) => console.error(m),
  validateWire,
} = {}) {
  const relay = new URL(relayUrl);
  const key = start.event_key;
  let nextSeq = loadCounter(statePath, start);
  const queue = []; // { seq, body, low }
  const stats = { accepted: 0, delivered: 0, dropped: 0, overflowed: 0, retries: 0 };
  let pumping = false;
  let stopped = false;
  let wake = null;
  let lowOverflowAlarms = 0;

  function post(item) {
    return new Promise((resolve) => {
      const body = Buffer.from(item.body, 'utf8');
      const req = http.request({
        hostname: relay.hostname, port: relay.port || 80, path: relay.pathname, method: 'POST', timeout: requestTimeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': body.length, [SIGNATURE_HEADER.toLowerCase()]: signBody(key, start.instance_id, start.epoch, item.seq, body) },
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

  // event: the fields of a posted event (schema_version, type, source, session_kind, user_id, ts, challenge_key?, data).
  // options.low: a summary that may be dropped first. options.check: validate the wire event first (events from the shop); the events
  // the sidecar builds itself are built to pass and are checked in the test suite.
  // Returns true when queued, false when refused (schema) or dropped (buffer full of events that must stay). Throws when the lane is full.
  function submit(event, { low = false, check = true } = {}) {
    const wire = { schema_version: event.schema_version, instance_id: start.instance_id, epoch: start.epoch, seq: nextSeq, type: event.type, source: event.source, session_kind: event.session_kind, user_id: event.user_id, ts: event.ts, ...(event.challenge_key !== undefined ? { challenge_key: event.challenge_key } : {}), data: event.data };
    if (nextSeq > SEQ_MAX) throw new Error('the sidecar seq lane is full');
    if (check && validateWire && schemaErrors(validateWire, wire).length) return false;
    let drop = -1;
    if (queue.length >= bufferMax) {
      drop = queue.findIndex((x) => x.low);
      if (drop < 0) {
        if (low) { // nothing low to give way, and this one is low itself: it is the one that goes, before it takes a seq
          stats.overflowed += 1;
          lowOverflowAlarms += 1;
          if (lowOverflowAlarms <= 3 || lowOverflowAlarms % 100 === 0) alarm(`alarm: buffer full, summaries dropped count=${lowOverflowAlarms}`);
          return false;
        }
        drop = 0;
      }
    }
    if (statePath) saveCounter(statePath, start, nextSeq + 1); // write-ahead: save the next value before the event exists
    nextSeq += 1;
    if (drop >= 0) {
      const [gone] = queue.splice(drop, 1);
      stats.overflowed += 1;
      if (gone.low) { lowOverflowAlarms += 1; if (lowOverflowAlarms <= 3 || lowOverflowAlarms % 100 === 0) alarm(`alarm: buffer full, summaries dropped count=${lowOverflowAlarms}`); } else alarm(`alarm: buffer full, event seq=${gone.seq} dropped`);
    }
    queue.push({ seq: wire.seq, body: JSON.stringify(wire), low });
    stats.accepted += 1;
    pump();
    return true;
  }

  return {
    queue, stats, submit,
    nextSeq: () => nextSeq,
    stop() { stopped = true; if (wake) wake(); },
  };
}
