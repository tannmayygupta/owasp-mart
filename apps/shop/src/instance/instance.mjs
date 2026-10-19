// Instance integration for the shop (T-04, TB-3). The shop joins a VulnMart
// instance through the instance contract (IF-6) and the event contract (IF-4):
//
//   - Readiness: /readyz is 200 only after the injector has written the marker
//     /run/vm/injected (IF-6 section 5) AND the shop has copied the injected
//     snapshot to its own writable /data and opened it. Before that, 503.
//   - Planted flags: the injector writes /run/vm/flags.json (mode 0400). The
//     shop reads a flag from there only for sentinel logic on the intended
//     vulnerable path; it never exposes a general flag route (that would be a
//     flag-disclosure bug). This module only *reads* the file.
//   - App events: the shop POSTs an unsigned event to the sidecar
//     (VM_SIDECAR_EVENTS_URL + /v1/events); the sidecar stamps instance_id,
//     epoch and seq and signs (IF-4 section 3/4). Posting is best-effort and
//     must never block or fail a player request (a 503 from the sidecar is not
//     retried inline).
//
// The live docker-compose integration (real injector, runtime profile) is T-09;
// this module is the shop-side contract behaviour, proven by an integration test.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openDb } from '../db/index.mjs';

// The injector writes the marker next to the flags file (IF-6 section 5/6).
export function markerPath(flagsPath) {
  return path.join(path.dirname(flagsPath), 'injected');
}

// True once the injector has finished (the marker is written last).
export function isInjected(flagsPath) {
  try {
    return fs.existsSync(markerPath(flagsPath));
  } catch {
    return false;
  }
}

// Copy the injected snapshot to the shop's writable db path and open it. The
// snapshot volume is read-only (0444), and copyFileSync replicates that mode, so
// the /data copy is made writable (0644) before opening — the shop opens its own
// copy read-write (contract section 7). A partial/stale copy from an earlier try
// is removed first, and a copy that fails to open is removed too, so each attempt
// starts clean. Returns an open database (throws if the copy or open fails).
export function openSnapshot({ snapshotPath, dbPath, open = openDb } = {}) {
  fs.rmSync(dbPath, { force: true });
  fs.copyFileSync(snapshotPath, dbPath);
  fs.chmodSync(dbPath, 0o644);
  try {
    return open(dbPath);
  } catch (err) {
    try { fs.rmSync(dbPath, { force: true }); } catch { /* nothing to remove */ }
    throw err;
  }
}

// Read one planted flag from the flags file by challenge key, or null. Used for
// sentinel checks only; never wire this to a response in the correct shop.
export function readFlag(flagsPath, challengeKey) {
  const doc = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  const found = doc.flags.find((f) => f.challenge_key === challengeKey);
  return found ? found.flag : null;
}

// Which challenges are exploitable in THIS instance: those whose flag the injector planted (IF-6 section 5). Before the marker nothing is (the default build is the
// correct one), and a flags file that cannot be read means none. The object is read lazily on each use, so it is correct as soon as the shop is ready; the
// flags file never changes inside an epoch (a reset starts a new instance process set), so the answer is cached once it is read.
export function makeInstanceChallenges(flagsPath, { injected = isInjected, readFile = fs.readFileSync } = {}) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    if (!injected(flagsPath)) return {};
    try {
      const doc = JSON.parse(readFile(flagsPath, 'utf8'));
      // C03 has two parts that are switched separately in the code (C03A search, C03B ticket markup); one flag turns both on
      cache = Object.fromEntries(doc.flags.flatMap((f) => (f.challenge_key === 'C03' ? ['C03', 'C03A', 'C03B'] : [f.challenge_key]).map((k) => [k, 'vulnerable'])));
      return cache;
    } catch {
      return {};
    }
  };
  const challenges = new Proxy({}, {
    get: (_, key) => (typeof key === 'string' ? load()[key] : undefined),
    has: (_, key) => typeof key === 'string' && key in load(),
    ownKeys: () => Object.keys(load()),
    getOwnPropertyDescriptor: (_, key) => (typeof key === 'string' && key in load() ? { value: load()[key], enumerable: true, configurable: true } : undefined),
  });
  const flagOf = (key) => {
    try { return injected(flagsPath) ? readFlag(flagsPath, key) ?? undefined : undefined; } catch { return undefined; }
  };
  return { challenges, flagOf };
}

const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// Build a schema-valid posted event body (IF-4 section 3): the wire event WITHOUT
// instance_id, epoch or seq (the sidecar stamps those). `source` defaults to
// `shop`; it is a parameter because the shop also posts `import.job` with source
// `import` on the import service's behalf (IF-4 section 3, H-50). The sidecar
// refuses a body that carries instance_id/epoch/seq or a source/type mismatch.
export function shopEvent(type, data, { source = 'shop', session_kind = 'player', user_id = 'u-system' } = {}) {
  return { schema_version: '0.1', type, source, session_kind, user_id, ts: ts(), data };
}

// POST an event to the sidecar, best-effort. Resolves to the sidecar's status
// code, or 0 on any network error or timeout. Never throws and never blocks a
// caller beyond the timeout; a 503 (sidecar lane full) is reported, not retried.
export function postEvent(eventsUrl, event, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/v1/events', eventsUrl);
    } catch {
      return resolve(0);
    }
    const body = JSON.stringify(event);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        // A connection that aborts mid-response emits 'error' on the response;
        // without a listener that would throw. Best-effort: treat it as a 0.
        res.on('error', () => resolve(0));
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

// A db handle the marketplace can be mounted on before the real db exists. In an
// instance the snapshot db only opens after the injector marker (makeReadiness),
// but the routes capture `db` at mount time, so this forwards each call to the
// db resolved now. Before it is ready a call throws (the healthcheck keeps player
// traffic off /readyz until then, so this is a guard, not a hot path). Only the
// three methods the shop uses are exposed (prepare/exec/close).
export function lazyDb(getDb) {
  const resolve = () => {
    const db = getDb();
    if (!db) throw new Error('shop database is not ready');
    return db;
  };
  return {
    prepare: (sql) => resolve().prepare(sql),
    exec: (sql) => resolve().exec(sql),
    close: () => { const db = getDb(); if (db) db.close(); },
  };
}

// An event emitter bound to the sidecar. Returns `emit(type, data, opts)` which
// builds a posted event (shopEvent) and posts it best-effort: fire-and-forget, so
// it never blocks or fails a player request (IF-4 section 3). With no events URL
// (a local / non-instance run, no sidecar) it is a no-op. `post` is injectable for
// tests. Telemetry must never break a request, so a build/post error is swallowed.
// At most `maxInFlight` posts are outstanding at once: a burst against a slow or
// stuck sidecar drops events rather than opening unbounded sockets (events are
// best-effort and the sidecar/ingest are the source of truth, not the shop).
export function makeEmitter(eventsUrl, { post = postEvent, maxInFlight = 32 } = {}) {
  if (!eventsUrl) return () => {};
  let inFlight = 0;
  return (type, data, opts = {}) => {
    if (inFlight >= maxInFlight) return;
    try {
      const event = shopEvent(type, data, opts);
      inFlight += 1;
      const settle = () => { inFlight -= 1; };
      post(eventsUrl, event).then(settle, settle);
    } catch { /* never let telemetry break a player request */ }
  };
}

// A readiness gate for the instance: ready only when the marker exists and the
// snapshot has been copied to /data and opened. The open is lazy and cached, and
// retried on each call until it works, so the shop can start before the injector
// finishes (the healthcheck polls /readyz). Returns { ready, getDb }.
export function makeReadiness({ flagsPath, snapshotPath, dbPath, open = openDb } = {}) {
  let db = null;
  function ready() {
    if (!isInjected(flagsPath)) return false;
    if (db) return true;
    try {
      db = openSnapshot({ snapshotPath, dbPath, open });
      return true;
    } catch {
      db = null;
      return false;
    }
  }
  return { ready, getDb: () => db };
}
