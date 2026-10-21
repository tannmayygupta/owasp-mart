// Durable state of the gate (production hardening, ADR 0073): the access map and the used-ticket set survive a restart of the edge.
// Before this, a restart emptied both and every live lab answered "ended" (an unknown instance is closed) until the orchestrator pushed again, and a ticket
// that was already used could be used a second time inside its lifetime (replay protection started from nothing).
//
// One small JSON file on a volume that belongs to the edge only (EDGE_STATE_FILE, default none = memory only, as before). Rules, all fail closed:
//   - the file is an envelope { v, mac, payload }: payload is the JSON text of { written_at, instances, used }, mac is HMAC-SHA256 over it with a key derived from the
//     gate key (current or previous, so a key rotation does not lose the state). A file that does not verify is ignored and reported: nobody who can only write the volume can
//     open an instance or forget a used ticket.
//   - the state is trusted only while it is fresh: `written_at` is refreshed by a heartbeat, so a file older than EDGE_STATE_MAX_AGE_S (default 600) means the edge was down
//     long enough that the orchestrator may have closed instances meanwhile; it is ignored and the gate starts closed, as before, until the orchestrator pushes.
//   - every record passes the same strict validation as a push (state.mjs validateRecord); a bad record ends the whole load (all or nothing).
//   - the orchestrator stays the only writer of truth: its next push or full sync still wins (the epoch rules of IF-5 apply to restored records exactly as to pushed ones).
//   - writes are atomic (temp file, fsync, rename) and mode 0600; a failed write is counted and logged, never thrown into a request.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JTI_RE } from './tickets.mjs';
import { MAX_INSTANCES, validateRecord } from './state.mjs';

export const STATE_VERSION = 1;
export const DEFAULT_MAX_AGE_S = 600;
const MAX_USED = 10000; // the same bound as gate.mjs MAX_USED_TICKETS

const derive = (key) => crypto.createHmac('sha256', key).update('vulnmart-edge-state-v1').digest();
const macOf = (key, payload) => crypto.createHmac('sha256', derive(key)).update(payload).digest('hex');
const equalHex = (a, b) => a.length === b.length && /^[0-9a-f]+$/.test(a) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** @returns {{ load: () => object|null, save: (snapshot: object) => boolean, saveErrors: () => number, lastLoad: () => object }} */
export function createPersistence({ file, keys, zone, now = () => Date.now(), maxAgeS = DEFAULT_MAX_AGE_S, log = () => {}, fsImpl = fs }) {
  if (typeof file !== 'string' || !file) throw new Error('createPersistence needs a file');
  let saveErrors = 0;
  let lastLoad = { status: 'not tried', instances: 0, used: 0 };

  function reject(status, why) {
    lastLoad = { status, instances: 0, used: 0 };
    log(`edge-gate: saved state ignored (${status}${why ? `: ${why}` : ''})`);
    return null;
  }

  function load() {
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (e) {
      lastLoad = { status: e?.code === 'ENOENT' ? 'no saved state' : 'unreadable', instances: 0, used: 0 };
      if (e?.code !== 'ENOENT') log(`edge-gate: saved state ignored (unreadable: ${e?.code ?? 'error'})`);
      return null;
    }
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      return reject('corrupt', 'not JSON');
    }
    if (!env || env.v !== STATE_VERSION || typeof env.mac !== 'string' || typeof env.payload !== 'string') return reject('corrupt', 'not an envelope of this version');
    const candidates = [keys.current, keys.previous].filter(Boolean);
    if (!candidates.some((k) => equalHex(macOf(k, env.payload), env.mac))) return reject('forged', 'the signature does not match the gate key');
    let body;
    try {
      body = JSON.parse(env.payload);
    } catch {
      return reject('corrupt', 'payload is not JSON');
    }
    const t = Math.floor(now() / 1000);
    if (!Number.isInteger(body?.written_at) || body.written_at > t + 60) return reject('corrupt', 'written_at');
    if (t - body.written_at > maxAgeS) return reject('stale', `older than ${maxAgeS} s`);
    if (!Array.isArray(body.instances) || body.instances.length > MAX_INSTANCES || !Array.isArray(body.used) || body.used.length > MAX_USED) return reject('corrupt', 'shape');
    const seen = new Set();
    const instances = [];
    for (const item of body.instances) {
      const v = validateRecord(item, zone);
      if (v.error || seen.has(v.record.instance_id)) return reject('corrupt', 'a record is not valid');
      seen.add(v.record.instance_id);
      instances.push(v.record);
    }
    const used = [];
    for (const pair of body.used) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !JTI_RE.test(pair[0]) || !Number.isInteger(pair[1])) return reject('corrupt', 'a used ticket is not valid');
      if (pair[1] > t) used.push([pair[0], pair[1]]); // an expired ticket id is not needed any more
    }
    lastLoad = { status: 'restored', instances: instances.length, used: used.length };
    return { instances, used };
  }

  function save({ instances, used }) {
    const dir = path.dirname(file);
    const tmp = `${file}.tmp`;
    try {
      const payload = JSON.stringify({ written_at: Math.floor(now() / 1000), instances, used });
      const envelope = JSON.stringify({ v: STATE_VERSION, mac: macOf(keys.current, payload), payload });
      fsImpl.mkdirSync(dir, { recursive: true });
      const fd = fsImpl.openSync(tmp, 'w', 0o600);
      try {
        fsImpl.writeSync(fd, envelope);
        fsImpl.fsyncSync(fd);
      } finally {
        fsImpl.closeSync(fd);
      }
      fsImpl.renameSync(tmp, file);
      return true;
    } catch (e) {
      saveErrors += 1;
      log(`edge-gate: saving the state failed (${e?.code ?? e?.name ?? 'error'}); ${saveErrors} failure(s) so far`);
      return false;
    }
  }

  return { load, save, saveErrors: () => saveErrors, lastLoad: () => lastLoad };
}

/**
 * Saves on change, but not more often than every `delayMs`, and every `heartbeatMs` regardless (so `written_at` stays fresh while nothing changes).
 * `snapshot()` returns { instances, used }. `flush()` writes now (the stop of the process). Timers do not keep the process alive.
 */
export function createSaver({ persistence, snapshot, delayMs = 200, heartbeatMs = 60000, setTimer = setTimeout, clearTimer = clearTimeout, setTick = setInterval, clearTick = clearInterval }) {
  let timer = null;
  let tick = null;
  const flush = () => {
    if (timer) { clearTimer(timer); timer = null; }
    return persistence.save(snapshot());
  };
  return {
    schedule() {
      if (timer) return;
      timer = setTimer(() => { timer = null; persistence.save(snapshot()); }, delayMs);
      timer.unref?.();
    },
    start() {
      tick = setTick(() => { persistence.save(snapshot()); }, heartbeatMs);
      tick.unref?.();
    },
    flush,
    stop() {
      if (tick) { clearTick(tick); tick = null; }
      return flush();
    },
  };
}
