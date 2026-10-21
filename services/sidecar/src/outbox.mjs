// The event outbox: gives each event its instance_id, epoch and seq, signs it (IF-4 section 4) and delivers it to the edge relay.
// Carried over from the tested stub sidecar (contracts/mocks/stub-instance/sidecar.mjs). Production hardening (ADR 0075) made it durable and gave the drops rules:
//   - DURABLE: every queued event is appended to a journal file (outboxPath) before it is acknowledged to the shop, and a delivered or dropped event is struck off in
//     the journal. A restart of the sidecar process loads the journal and goes on with what was not delivered (an event delivered just before a crash is sent again: the
//     ingest answers 200 for an identical duplicate, so nothing is counted twice). Without outboxPath it is in memory only, as before (unit tests).
//   - PRIORITY: three tiers. critical = a flag sighting (proxy.flag_seen), the evidence of a capture (evidence.capture) and every event of the shop or another instance
//     component (milestones, scoring facts); normal = anything else the sidecar builds; low = the proxy.request and proxy.crs_match summaries. When the buffer is full
//     (count: bufferMax; size: maxBytes) the OLDEST event of the LOWEST tier goes; an event of a higher tier is never evicted for one of a lower tier (the newcomer is the one
//     refused). Only when the buffer holds nothing but critical events does the oldest critical one go, with an alarm, and it is counted apart.
//   - SIZE: bounded by count and by bytes; every drop has its own counter in `stats` (metrics()), none is silent.
//   - DELIVERY: POST /internal/v1/events to the relay; an event is kept until 202 or 200. Only what can never succeed is dropped: 413 (too large), 422 (invalid) and 409
//     (another body for the same seq). 401 may be transient (the platform may not know this instance or epoch yet), so it is retried with backoff and dropped only after
//     authRetryMax tries in a row; no answer, 5xx and every other status are retried with backoff and never dropped for that reason.
//   - the seq counter is write-ahead: the next value is saved to a small state file BEFORE the event is queued, so a restart inside one epoch continues from the saved
//     value and never reuses a seq (a crash can leave a gap, which IF-4 allows); if the journal holds a higher seq than the state file the counter goes past it.
// It never prints a body, a key or a flag.
import fs from 'node:fs';
import http from 'node:http';
import { schemaErrors } from './common.mjs';
import { signBody, SIGNATURE_HEADER } from './sign.mjs';

// The sidecar lane of IF-4 (app-events.md section 6): seq 1 to 2^40-1. Higher values belong to the orchestrator and the platform.
export const SEQ_MAX = 2 ** 40 - 1;
export const DEFAULT_STATE_PATH = '/tmp/vm-sidecar-seq.json';
export const DEFAULT_OUTBOX_PATH = '/tmp/vm-sidecar-outbox.jsonl';
export const DROP_STATUSES = new Set([409, 413, 422]); // can never succeed: drop at once
export const AUTH_STATUSES = new Set([401]); // may be transient: retry, drop only after authRetryMax tries in a row
export const DONE_STATUSES = new Set([200, 202]);
export const TIER = { low: 0, normal: 1, critical: 2 };
const TIER_NAMES = ['low', 'normal', 'critical'];

/** The tier of a wire event (see the header). `low` is the caller's explicit mark for summaries. */
export function tierOf(event, low = false) {
  if (low) return TIER.low;
  if (event.type === 'proxy.flag_seen' || event.type === 'evidence.capture' || event.source !== 'sidecar') return TIER.critical;
  return String(event.type).startsWith('proxy.') ? TIER.normal : TIER.critical; // the other proxy.* facts are normal; anything else (shop.*, milestones) is critical
}

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

/**
 * The journal: one JSON object per line, `{"o":"a","s":seq,"t":tier,"b":"<body>"}` to add and `{"o":"d","s":seq}` to strike off. A torn last line (a crash in the middle of a
 * write) is ignored. `load` returns the events still owed, oldest first. Compaction rewrites the file with the live events only (temp file, then rename).
 */
function createJournal(file, { onError }) {
  let fd = null;
  let bytes = 0;
  const open = () => { fd = fs.openSync(file, 'a', 0o600); };
  const write = (obj, sync) => {
    const line = `${JSON.stringify(obj)}\n`;
    fs.writeSync(fd, line);
    if (sync) fs.fsyncSync(fd);
    bytes += line.length;
  };
  return {
    bytes: () => bytes,
    load(valid) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new Error('sidecar outbox file is unreadable'); }
      const live = new Map();
      for (const line of text.split('\n')) {
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; } // a torn line
        if (!r || !Number.isSafeInteger(r.s)) continue;
        if (r.o === 'a' && typeof r.b === 'string' && Number.isInteger(r.t) && r.t >= 0 && r.t <= 2) live.set(r.s, { seq: r.s, body: r.b, tier: r.t });
        else if (r.o === 'd') live.delete(r.s);
      }
      const items = [...live.values()].filter(valid).sort((a, b) => a.seq - b.seq);
      this.compact(items);
      return items;
    },
    compact(items) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; }
      const tmp = `${file}.tmp`;
      const text = items.map((i) => `${JSON.stringify({ o: 'a', s: i.seq, t: i.tier, b: i.body })}\n`).join('');
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, file);
      bytes = text.length;
      open();
    },
    add(item) { try { write({ o: 'a', s: item.seq, t: item.tier, b: item.body }, item.tier === TIER.critical); return true; } catch { onError(); return false; } },
    remove(seq) { try { write({ o: 'd', s: seq }, false); return true; } catch { onError(); return false; } },
    close() { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; } },
  };
}

export function createOutbox({
  start,
  relayUrl = 'http://edge:8081/internal/v1/events',
  bufferMax = 1000,
  maxBytes = 2 * 1024 * 1024,
  retryMinMs = 250,
  retryMaxMs = 4000,
  requestTimeoutMs = 3000,
  authRetryMax = 6,
  statePath = null,
  outboxPath = null,
  alarm = (m) => console.error(m),
  validateWire,
} = {}) {
  const relay = new URL(relayUrl);
  const key = start.event_key;
  let nextSeq = loadCounter(statePath, start);
  const queue = []; // { seq, body, low, tier }
  const stats = {
    accepted: 0, delivered: 0, dropped: 0, overflowed: 0, retries: 0,
    dropped_never_succeed: 0, dropped_auth: 0, dropped_overflow_low: 0, dropped_overflow_normal: 0, dropped_overflow_critical: 0,
    restored: 0, discarded_at_start: 0, journal_errors: 0,
  };
  let pumping = false;
  let stopped = false;
  let wake = null;
  let lowOverflowAlarms = 0;
  let queueBytes = 0;

  let journal = outboxPath ? createJournal(outboxPath, { onError: () => { stats.journal_errors += 1; if (stats.journal_errors <= 3 || stats.journal_errors % 100 === 0) alarm(`alarm: outbox journal write failed count=${stats.journal_errors}`); } }) : null;

  // A journal that cannot be opened (a folder that is not writable) must not stop the sidecar: it runs in memory, loudly.
  const restoredItems = [];
  if (journal) {
    try { restoredItems.push(...journal.load(() => true)); } catch { alarm('alarm: outbox journal unavailable, running in memory only'); journal = null; }
  }
  if (journal) {
    // An event of another instance or epoch cannot be signed with this start document's key: it is discarded (counted), never sent.
    const valid = (item) => {
      let w;
      try { w = JSON.parse(item.body); } catch { return false; }
      return w && w.instance_id === start.instance_id && w.epoch === start.epoch && w.seq === item.seq;
    };
    const total = restoredItems;
    const items = total.filter(valid);
    stats.discarded_at_start = total.length - items.length;
    for (const it of items) { queue.push({ seq: it.seq, body: it.body, low: it.tier === TIER.low, tier: it.tier }); queueBytes += it.body.length; }
    stats.restored = queue.length;
    if (items.length) nextSeq = Math.max(nextSeq, items[items.length - 1].seq + 1); // the state file may be older than the journal: never reuse a seq
    if (stats.discarded_at_start) journal.compact(queue);
    while (queue.length > bufferMax || queueBytes > maxBytes) { if (!evictOne(TIER.critical)) break; } // a limit that is lower than before
    if (queue.length) alarm(`outbox: ${queue.length} event(s) restored from the journal`);
  }

  // The lowest tier present, then the oldest of it; returns the index or -1. Never touches a tier above `maxTier`.
  function victim(maxTier) {
    let best = -1;
    for (let i = 0; i < queue.length; i += 1) if (queue[i].tier <= maxTier && (best < 0 || queue[i].tier < queue[best].tier)) best = i;
    return best;
  }

  // Removes one event to make room; true when something was removed. The reason is counted by tier.
  function evictOne(maxTier) {
    const i = victim(maxTier);
    if (i < 0) return false;
    const [gone] = queue.splice(i, 1);
    queueBytes -= gone.body.length;
    journal?.remove(gone.seq);
    stats.overflowed += 1;
    stats[`dropped_overflow_${TIER_NAMES[gone.tier]}`] += 1;
    if (gone.tier === TIER.low) { lowOverflowAlarms += 1; if (lowOverflowAlarms <= 3 || lowOverflowAlarms % 100 === 0) alarm(`alarm: buffer full, summaries dropped count=${lowOverflowAlarms}`); } else alarm(`alarm: buffer full, event seq=${gone.seq} dropped`);
    return true;
  }

  function finish(item) { // delivered or dropped: out of the queue and struck off in the journal
    const i = queue.indexOf(item);
    if (i >= 0) { queue.splice(i, 1); queueBytes -= item.body.length; }
    journal?.remove(item.seq);
    if (journal && journal.bytes() > 64 * 1024 && journal.bytes() > 2 * (queueBytes + 1024)) journal.compact(queue);
  }

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
    let authTries = 0;
    while (queue.length && !stopped) {
      const item = queue[0];
      const status = await post(item);
      if (DONE_STATUSES.has(status)) { finish(item); stats.delivered += 1; delay = retryMinMs; authTries = 0; continue; }
      if (DROP_STATUSES.has(status)) { // it can never succeed
        finish(item);
        stats.dropped += 1;
        stats.dropped_never_succeed += 1;
        alarm(`alarm: event seq=${item.seq} dropped, the ingest answered ${status}`);
        authTries = 0;
        continue;
      }
      if (AUTH_STATUSES.has(status)) {
        authTries += 1;
        if (authTries > authRetryMax) { // refused as many times as we are willing to try: the key is wrong, not late
          finish(item);
          stats.dropped += 1;
          stats.dropped_auth += 1;
          alarm(`alarm: event seq=${item.seq} dropped, the ingest answered ${status} ${authTries} times`);
          authTries = 0;
          continue;
        }
      } else authTries = 0;
      stats.retries += 1; // no answer, or an answer that retrying may fix (401 for a while, 5xx, ...)
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
    const tier = tierOf(wire, low);
    const body = JSON.stringify(wire);
    // make room: count first, then bytes; only events of this tier or lower may go for the newcomer (a summary never pushes out a flag)
    while (queue.length >= bufferMax || queueBytes + body.length > maxBytes) {
      if (queue.length === 0) break; // one event larger than the whole byte budget: let it in alone (the relay refuses what is really too large)
      if (victim(tier) < 0) { // nothing of this tier or lower is left to give way: the newcomer is the one that goes, before it takes a seq
        stats.overflowed += 1;
        stats[`dropped_overflow_${TIER_NAMES[tier]}`] += 1;
        if (tier === TIER.low) { lowOverflowAlarms += 1; if (lowOverflowAlarms <= 3 || lowOverflowAlarms % 100 === 0) alarm(`alarm: buffer full, summaries dropped count=${lowOverflowAlarms}`); } else alarm('alarm: buffer full, a new event dropped');
        return false;
      }
      evictOne(tier);
    }
    if (statePath) saveCounter(statePath, start, nextSeq + 1); // write-ahead: save the next value before the event exists
    nextSeq += 1;
    const item = { seq: wire.seq, body, low, tier };
    journal?.add(item); // on disk before the shop is told 202
    queue.push(item);
    queueBytes += body.length;
    stats.accepted += 1;
    pump();
    return true;
  }

  // The counters as one object (for a log line or a test). `queued` and `queued_bytes` are the present state, the rest only grow.
  const metrics = () => ({ ...stats, queued: queue.length, queued_bytes: queueBytes });

  if (queue.length) pump(); // what the journal held goes out at once

  return {
    queue, stats, submit, metrics,
    nextSeq: () => nextSeq,
    stop() { stopped = true; if (wake) wake(); journal?.close(); },
  };
}
