// Fake orchestrator (IF-5): a stateful, dependency-free Node service that answers the calls of
// contracts/orchestrator/orchestrator.openapi.yaml, so the platform side can be built and tested without
// Docker or the real orchestrator. It is NOT the real orchestrator: it builds nothing.
//
// What it does: the seven calls, the instance state machine, request signing (HMAC, timestamp, nonce),
// a memory capacity limit, a step delay, and optional signed state reports to the platform.
// What it never does: answer a flag, decoy, digest, seed or event key. A create or reset body is checked and
// then reduced to a SHA-256 fingerprint (owner_hash is part of it); the secrets and the owner hash
// are dropped, never stored and never returned.
//
// Wire rules (ADR 0028, contract section 2a and 6): every integer of the contract must be an integer token in the body (no `1.0`,
// no `1e0`, no boolean, at most 2^53 - 1), so the body is read by the small strict parser below and not by JSON.parse, which cannot tell
// `1` from `1.0`. Every error answer is the closed IF-8 body (`application/problem+json`, contracts/errors/problem.schema.json: type, title, status,
// code, request_id and, for a 422, field), with the title and the status taken from the registry. The one non-integer number, limits.cpu_limit, is compared by value (2 equals 2.0).
//
// Not part of the contract (test aids): the template name shop-fail-v0, which ends in `failed` with the
// placeholder code INST-HEALTH-TIMEOUT, and POST /_fake/v1/instances/{id}/activity (unsigned, loopback only).
//
// Usage: node server.mjs [--port 0] [--host 127.0.0.1] [--key <platform signing key>] [--capacity-mb 8192]
//        [--step-delay-ms 0] [--host-id fake-host-1] [--report-url <platform base url>] [--report-key <orchestrator key>]
//        [--tls-cert <server cert PEM> --tls-key <server key PEM> --tls-ca <client CA PEM>]
// The key can also come from VM_FAKE_PLATFORM_KEY and VM_FAKE_ORCH_KEY. Prints {"listening":true,"port":N} when ready.
// The three --tls-* flags go together (all or none). With them the fake speaks HTTPS and requires a client certificate signed
// by the given CA (mutual TLS, a deployment matter that is not part of the OpenAPI file); without them it speaks plain HTTP.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_TYPE, pointer, problemBody } from '../shared/problem.mjs';

export const MAX_BODY = 64 * 1024;
export const MAX_SKEW_MS = 60 * 1000;
export const NONCE_TTL_MS = 5 * 60 * 1000;
export const TEMPLATES = new Set(['shop-v0', 'shop-fail-v0']);
const COMPONENTS = new Set(['bot-controller', 'import-service', 'injector', 'mock-services', 'shop', 'sidecar']);
// The same names as FORBIDDEN_FIELDS of apps/orchestrator/src/vulnmart_orchestrator/builder.py (a test compares the two lists).
const FORBIDDEN = new Set([
  'image', 'images', 'command', 'cmd', 'entrypoint', 'args', 'env', 'environment', 'volumes', 'volume', 'mounts', 'mount',
  'ports', 'port', 'network', 'networks', 'network_mode', 'privileged', 'user', 'cap_add', 'cap_drop', 'devices', 'labels',
  'security_opt', 'binds', 'tmpfs', 'components', 'healthcheck', 'restart', 'pid', 'ipc', 'extra_hosts', 'dns',
]);
const LABELS = new Set(['instance', 'epoch', 'component', 'template', 'kind']);
const RESETTABLE = new Set(['ready', 'active', 'idle']);
const TRANSITIONAL = new Set(['requested', 'provisioning', 'starting', 'resetting', 'stopping']);

const RE = {
  instanceId: /^i-[A-Z2-7]{16}$/,
  template: /^[a-z][a-z0-9-]{2,31}$/,
  challenge: /^C(0[1-9]|10|11)$/,
  flag: /^VM\{[A-Z2-7]{24}\}$/,
  hex64: /^[0-9a-f]{64}$/,
  secret: /^[A-Za-z0-9_-]{32,128}$/,
  hostname: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
  ts: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  nonce: /^[0-9a-f]{32}$/,
  sig: /^v1=[0-9a-f]{64}$/,
  cursor: /^[A-Za-z0-9_-]{24}$/, // base64url, no padding, of an 18-character instance id
};

export const MAX_INT = Number.MAX_SAFE_INTEGER; // 2^53 - 1, the largest integer of the contract (RFC 7493 section 2.2)
const JSON_TYPE = /^application\/json\s*(;.*)?$/i;

// A number token that is not a plain integer in the safe range: a fraction, an exponent, or too large. Never an integer.
export class Num {
  constructor(raw, value) { this.raw = raw; this.value = value; }
}
const isInt = (v, min, max = MAX_INT) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Num);

const NUM_RE = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
// JSON (RFC 8259) read so that an integer token becomes a JS number and every other number token becomes a Num. Throws SyntaxError.
export function parseJsonStrict(text) {
  let i = 0;
  const fail = (msg) => { throw new SyntaxError(`${msg} at ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    const start = i;
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') i += 2;
      else if (ch === '"') { i++; return JSON.parse(text.slice(start, i)); } // JSON.parse checks the escapes and control characters
      else i++;
    }
    return fail('unterminated string');
  };
  const value = (depth) => {
    if (depth > 64) fail('nested too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      const entries = [];
      if (text[i] === '}') { i++; return {}; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a member name');
        const k = str();
        ws();
        if (text[i] !== ':') fail('expected a colon');
        i++;
        entries.push([k, value(depth + 1)]);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('expected a comma or a closing brace');
      }
      return Object.fromEntries(entries); // defines own properties, so a member named __proto__ is data
    }
    if (c === '[') {
      i++;
      ws();
      const items = [];
      if (text[i] === ']') { i++; return items; }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('expected a comma or a closing bracket');
      }
      return items;
    }
    if (c === '"') return str();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(text);
    if (!m || m.index !== i) return fail('unexpected character');
    i += m[0].length;
    const n = Number(m[0]);
    if (m[1] === undefined && m[2] === undefined && Number.isSafeInteger(n)) return n === 0 ? 0 : n; // -0 is the integer 0
    return new Num(m[0], n);
  };
  const out = value(0);
  ws();
  if (i !== text.length) fail('unexpected text after the value');
  return out;
}
const numberValue = (v) => (v instanceof Num ? v.value : v);
const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function canonical(v) {
  if (v instanceof Num) return JSON.stringify(numberValue(v)); // by value: 2.0 and 2 are one number
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const fingerprint = (body) => crypto.createHash('sha256').update(canonical(body)).digest('hex');

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export function signingString(method, target, timestamp, nonce, bodySha256) {
  return ['v1', method.toUpperCase(), target, timestamp, nonce, bodySha256].join('\n');
}
export function sign(key, method, target, timestamp, nonce, bodySha256) {
  return 'v1=' + crypto.createHmac('sha256', key).update(signingString(method, target, timestamp, nonce, bodySha256)).digest('hex');
}

// ---- body validation: returns null or { code, field, message } ----
const bad = (field, message, code = 'ORCH-VALIDATION') => ({ code, field, message });

function checkKeys(body, allowed) {
  if (!isObj(body)) return bad('', 'the body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (FORBIDDEN.has(k.toLowerCase())) return bad(pointer(k.slice(0, 64)), `the orchestrator accepts no ${k}`, 'ORCH-FIELD-FORBIDDEN');
  }
  // An unknown key is echoed back, so it is cut to 64 characters first.
  for (const k of Object.keys(body)) if (!allowed.includes(k)) return bad(pointer(k.slice(0, 64)), `unknown field ${k.slice(0, 64)}`);
  for (const k of allowed) if (!(k in body)) return bad('/' + k, `${k} is required`);
  return null;
}

function checkMaterial(b) {
  if (!Array.isArray(b.flags) || b.flags.length < 1 || b.flags.length > 11) return bad('/flags', 'flags: 1 to 11 entries');
  for (const [i, f] of b.flags.entries()) {
    if (!isObj(f) || Object.keys(f).some((k) => !['challenge_key', 'flag'].includes(k))) return bad(`/flags/${i}`, 'bad flag entry');
    if (!RE.challenge.test(f.challenge_key ?? '')) return bad(`/flags/${i}/challenge_key`, 'bad challenge key');
    if (!RE.flag.test(f.flag ?? '')) return bad(`/flags/${i}/flag`, 'bad flag format');
  }
  if (!Array.isArray(b.decoys) || b.decoys.length > 64) return bad('/decoys', 'decoys: at most 64 entries');
  for (const [i, d] of b.decoys.entries()) {
    if (!isObj(d) || Object.keys(d).some((k) => !['challenge_key', 'index', 'value'].includes(k))) return bad(`/decoys/${i}`, 'bad decoy entry');
    if (!RE.challenge.test(d.challenge_key ?? '')) return bad(`/decoys/${i}/challenge_key`, 'bad challenge key');
    if (!isInt(d.index, 0)) return bad(`/decoys/${i}/index`, 'bad decoy index');
    if (!RE.flag.test(d.value ?? '')) return bad(`/decoys/${i}/value`, 'bad decoy format');
  }
  if (!Array.isArray(b.flag_digests) || b.flag_digests.length < 1 || b.flag_digests.length > 11) return bad('/flag_digests', 'flag_digests: 1 to 11 entries');
  for (const [i, d] of b.flag_digests.entries()) {
    if (!isObj(d) || Object.keys(d).some((k) => !['challenge_key', 'sha256'].includes(k))) return bad(`/flag_digests/${i}`, 'bad digest entry');
    if (!RE.challenge.test(d.challenge_key ?? '')) return bad(`/flag_digests/${i}/challenge_key`, 'bad challenge key');
    if (!RE.hex64.test(d.sha256 ?? '')) return bad(`/flag_digests/${i}/sha256`, 'bad digest');
  }
  if (!RE.secret.test(b.event_key ?? '')) return bad('/event_key', 'bad event key shape');
  if (!RE.secret.test(b.seed ?? '')) return bad('/seed', 'bad seed shape');
  return null;
}

export function validateCreate(b) {
  const keys = ['instance_id', 'template_id', 'epoch', 'flags', 'decoys', 'flag_digests', 'event_key', 'seed', 'owner_hash', 'hostname', 'limits'];
  const e = checkKeys(b, keys);
  if (e) return e;
  if (typeof b.instance_id !== 'string' || !RE.instanceId.test(b.instance_id)) return bad('/instance_id', 'bad instance id');
  if (typeof b.template_id !== 'string' || !RE.template.test(b.template_id)) return bad('/template_id', 'bad template name');
  if (!isInt(b.epoch, 1)) return bad('/epoch', 'epoch is an integer of at least 1');
  if (typeof b.owner_hash !== 'string' || !RE.hex64.test(b.owner_hash)) return bad('/owner_hash', 'owner_hash is 64 lowercase hex characters');
  const m = checkMaterial(b);
  if (m) return m;
  if (typeof b.hostname !== 'string' || b.hostname.length > 253 || !RE.hostname.test(b.hostname)) return bad('/hostname', 'bad host name');
  const l = b.limits;
  if (!isObj(l)) return bad('/limits', 'limits is an object');
  const lk = ['memory_mb', 'cpu_limit', 'pids_limit', 'idle_minutes', 'max_minutes'];
  for (const k of Object.keys(l)) if (!lk.includes(k)) return bad(`/limits/${k}`, 'unknown limit');
  for (const k of lk) if (!(k in l)) return bad(`/limits/${k}`, `${k} is required`);
  if (!isInt(l.memory_mb, 64, 8192)) return bad('/limits/memory_mb', 'memory_mb is 64 to 8192');
  const cpu = numberValue(l.cpu_limit);
  if (typeof cpu !== 'number' || !(cpu > 0 && cpu <= 8)) return bad('/limits/cpu_limit', 'cpu_limit is over 0 up to 8');
  if (!isInt(l.pids_limit, 16, 4096)) return bad('/limits/pids_limit', 'pids_limit is 16 to 4096');
  if (!isInt(l.idle_minutes, 1, 1440)) return bad('/limits/idle_minutes', 'idle_minutes is 1 to 1440');
  if (!isInt(l.max_minutes, 1, 1440)) return bad('/limits/max_minutes', 'max_minutes is 1 to 1440');
  return null;
}

export function validateReset(b) {
  const e = checkKeys(b, ['epoch', 'flags', 'decoys', 'flag_digests', 'event_key', 'seed']);
  if (e) return e;
  if (!isInt(b.epoch, 2)) return bad('/epoch', 'epoch is an integer of at least 2');
  return checkMaterial(b);
}

export function validateActivity(b) {
  const e = checkKeys(b, ['at']);
  if (e) return e;
  if (typeof b.at !== 'string' || b.at.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(b.at) || Number.isNaN(Date.parse(b.at))) return bad('/at', 'at is an RFC 3339 time with a time zone');
  return null;
}

export function validateAccess(b) {
  const e = checkKeys(b, ['access', 'access_epoch']);
  if (e) return e;
  if (!['open', 'frozen', 'closed'].includes(b.access)) return bad('/access', 'access is open, frozen or closed');
  if (!isInt(b.access_epoch, 0)) return bad('/access_epoch', 'access_epoch is an integer of at least 0');
  return null;
}

// A cursor is the base64url of the last instance id of the page. Anything else (any length, any bytes that are not an instance id,
// a non-canonical spelling) is not a cursor this service handed out: null.
const encodeCursor = (id) => Buffer.from(id).toString('base64url');
function decodeCursor(c) {
  if (!RE.cursor.test(c)) return null;
  const text = Buffer.from(c, 'base64url').toString('utf8');
  return RE.instanceId.test(text) && encodeCursor(text) === c ? text : null;
}

// ---- the service ----
export function createFakeOrchestrator(options = {}) {
  const cfg = {
    host: '127.0.0.1',
    port: 0,
    platformKey: process.env.VM_FAKE_PLATFORM_KEY || 'FAKE-SIGNING-KEY-NOT-REAL-0000000000',
    orchestratorKey: process.env.VM_FAKE_ORCH_KEY || 'FAKE-ORCHESTRATOR-KEY-NOT-REAL-0000000',
    capacityMb: 8192,
    stepDelayMs: 0,
    hostId: 'fake-host-1',
    reportUrl: null,
    reportTimeoutMs: 5000,
    ...options,
  };
  const records = new Map();
  const nonces = new Map();
  let reportQueue = Promise.resolve();

  // The IF-8 error body (shared/problem.mjs): the title and the status come from the registry, there is no `detail` and no `instance`.
  // The `detail` argument is only a note for the reader of this file; it never reaches the answer (no free text reaches a client).
  const problem = (res, status, code, detail, field, extra = {}) => {
    const requestId = 'req-' + crypto.randomBytes(6).toString('hex');
    const body = problemBody(code, requestId, { field });
    send(res, body.status, body, MEDIA_TYPE, { ...(body.status === 429 ? { 'retry-after': '5' } : {}), ...extra });
  };
  const send = (res, status, body, type = 'application/json', extra = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...extra });
    res.end(text);
  };
  const fail = (res, status, e) => problem(res, status, e.code, e.message, e.field);

  const view = (r) => ({
    instance_id: r.id, template_id: r.templateId, epoch: r.epoch, state: r.state, access: r.access,
    access_epoch: r.accessEpoch, health: r.health, error_code: r.errorCode, host_id: cfg.hostId,
    hostname: r.hostname, created_at: r.createdAt, updated_at: r.updatedAt,
  });
  const usedMb = () => [...records.values()].filter((r) => r.state !== 'destroyed').reduce((n, r) => n + r.memoryMb, 0);

  // `transition` is the number of this state change inside (instance, epoch): 1, 2, 3 ... A reset starts the count again at 1 with
  // its new epoch. It is counted whether or not a report URL is set, so the numbers do not depend on delivery.
  function report(r, from, to, reason) {
    const number = ++r.transition;
    if (!cfg.reportUrl) return;
    const body = Buffer.from(JSON.stringify({
      instance_id: r.id, epoch: r.epoch, transition: number, from_state: from, to_state: to, at: r.updatedAt, reason,
      error_code: r.errorCode, health: r.health,
    }));
    const target = '/internal/v1/orch/state';
    reportQueue = reportQueue.then(async () => {
      const ts = stamp();
      const nonce = crypto.randomBytes(16).toString('hex');
      try {
        const resp = await fetch(cfg.reportUrl.replace(/\/$/, '') + target, {
          method: 'POST', body, signal: AbortSignal.timeout(cfg.reportTimeoutMs),
          headers: {
            'content-type': 'application/json', 'x-vm-timestamp': ts, 'x-vm-nonce': nonce,
            'x-vm-signature': sign(cfg.orchestratorKey, 'POST', target, ts, nonce, sha256Hex(body)),
          },
        });
        if (!resp.ok) process.stderr.write(`state report refused: HTTP ${resp.status}\n`);
        await resp.arrayBuffer().catch(() => {});
      } catch (err) {
        process.stderr.write(`state report failed: ${err.message}\n`);
      }
    });
  }

  function transition(r, to, reason, extra = {}) {
    const from = r.state;
    r.state = to;
    Object.assign(r, extra);
    r.updatedAt = stamp();
    report(r, from, to, reason);
  }

  function nextStep(r) {
    switch (r.state) {
      case 'requested': case 'resetting': return ['provisioning', 'orchestrator started work', {}];
      case 'provisioning': return ['starting', 'networks and containers created', {}];
      case 'starting':
        return r.templateId === 'shop-fail-v0'
          ? ['failed', 'health check timed out', { health: 'unhealthy', errorCode: 'INST-HEALTH-TIMEOUT' }]
          : ['ready', 'health ok and flags injected', { health: 'healthy', errorCode: null }];
      case 'stopping': return ['destroyed', 'everything removed', {}];
      default: return null;
    }
  }

  function schedule(r) {
    clearTimeout(r.timer);
    r.timer = null;
    if (!TRANSITIONAL.has(r.state)) return;
    r.timer = setTimeout(() => {
      r.timer = null;
      const step = nextStep(r);
      if (!step) return;
      transition(r, step[0], step[1], step[2]);
      schedule(r);
    }, cfg.stepDelayMs);
    r.timer.unref?.();
  }

  function verify(req, bodySha256) {
    const h = req.headers;
    const ts = h['x-vm-timestamp'] ?? '', nonce = h['x-vm-nonce'] ?? '', sig = h['x-vm-signature'] ?? '';
    if (!RE.ts.test(ts) || !RE.nonce.test(nonce) || !RE.sig.test(sig)) return false;
    const expected = Buffer.from(sign(cfg.platformKey, req.method, req.url, ts, nonce, bodySha256));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;
    const skew = Math.abs(Date.now() - Date.parse(ts)); // NaN for a date that does not exist, which must fail
    if (!(skew <= MAX_SKEW_MS)) return false;
    const now = Date.now();
    for (const [n, t] of nonces) if (now - t > NONCE_TTL_MS) nonces.delete(n);
    if (nonces.has(nonce)) return false;
    nonces.set(nonce, now);
    return true;
  }

  // Reads at most MAX_BODY bytes. A longer body is never read further or hashed: the caller answers 413 and drops
  // the connection (so an oversize body is refused before the signature is looked at).
  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length']) > MAX_BODY) {
        resolve({ buf: Buffer.alloc(0), tooLarge: true, sha256: '' });
        return;
      }
      const chunks = [];
      const hash = crypto.createHash('sha256');
      let size = 0;
      const onData = (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.off('data', onData);
          req.pause();
          resolve({ buf: Buffer.alloc(0), tooLarge: true, sha256: '' });
          return;
        }
        hash.update(c);
        chunks.push(c);
      };
      req.on('data', onData);
      req.on('end', () => resolve({ buf: Buffer.concat(chunks), tooLarge: false, sha256: hash.digest('hex') }));
      req.on('error', reject);
    });
  }

  function parseJson(buf) {
    try { return [parseJsonStrict(buf.toString('utf8')), null]; } catch { return [null, bad('', 'the body is not valid JSON')]; }
  }

  function getRecord(res, id) {
    if (!RE.instanceId.test(id)) { fail(res, 422, bad('/instance_id', 'bad instance id')); return null; }
    const r = records.get(id);
    if (!r) { problem(res, 404, 'ORCH-INSTANCE-NOT-FOUND', `unknown instance ${id}`); return null; }
    return r;
  }

  function create(res, body) {
    const e = validateCreate(body);
    if (e) return fail(res, 422, e);
    if (!TEMPLATES.has(body.template_id)) return problem(res, 422, 'ORCH-TEMPLATE-UNKNOWN', `template ${body.template_id} is not on the allow-list`, '/template_id');
    const fp = fingerprint(body);
    const r = records.get(body.instance_id);
    if (r) {
      if (r.state === 'destroyed') return problem(res, 409, 'ORCH-INSTANCE-EXISTS', 'the instance id was used and destroyed; it cannot be created again');
      if (body.epoch < r.epoch) return problem(res, 409, 'ORCH-STALE-EPOCH', 'the epoch is older than the current epoch of the instance');
      const known = r.prints.get(`${body.epoch}:create`);
      if (known === undefined) return problem(res, 409, 'ORCH-INSTANCE-EXISTS', 'the instance exists with another epoch; use reset');
      if (known !== fp) return problem(res, 409, 'ORCH-REQUEST-MISMATCH', 'same instance and epoch with a different body');
      return send(res, 200, view(r));
    }
    if (usedMb() + body.limits.memory_mb > cfg.capacityMb) return problem(res, 429, 'ORCH-BUSY', 'the host has no capacity');
    const now = stamp();
    const rec = {
      id: body.instance_id, templateId: body.template_id, epoch: body.epoch, state: 'requested', access: 'closed',
      accessEpoch: 0, health: 'unknown', errorCode: null, hostname: body.hostname, createdAt: now, updatedAt: now,
      memoryMb: body.limits.memory_mb, prints: new Map([[`${body.epoch}:create`, fp]]), timer: null, transition: 0,
    };
    records.set(rec.id, rec);
    report(rec, null, 'requested', 'create accepted');
    const answer = view(rec);
    schedule(rec);
    send(res, 202, answer);
  }

  function reset(res, r, body) {
    const fp = fingerprint(body);
    const known = r.prints.get(`${body.epoch}:reset`);
    if (known !== undefined && body.epoch <= r.epoch) {
      if (known !== fp) return problem(res, 409, 'ORCH-REQUEST-MISMATCH', 'same new epoch with a different body');
      return send(res, 200, view(r));
    }
    if (!RESETTABLE.has(r.state)) return problem(res, 409, 'ORCH-INVALID-STATE', `reset is not allowed in state ${r.state}`);
    if (body.epoch !== r.epoch + 1) return problem(res, 409, 'ORCH-STALE-EPOCH', 'the new epoch must be the current epoch plus one');
    r.prints.set(`${body.epoch}:reset`, fp);
    r.epoch = body.epoch;
    r.transition = 0;
    transition(r, 'resetting', 'reset accepted', { health: 'unknown', errorCode: null });
    const answer = view(r);
    schedule(r);
    send(res, 202, answer);
  }

  function activity(res, r, body) {
    if (!RESETTABLE.has(r.state)) return problem(res, 409, 'ORCH-INVALID-STATE', 'activity is not allowed in this state');
    const at = Math.min(Date.parse(body.at), Date.now());
    r.lastActivity = Math.max(r.lastActivity ?? 0, at);
    if (r.state !== 'active') transition(r, 'active', 'player activity');
    return send(res, 200, view(r));
  }

  function access(res, r, body) {
    if (r.state === 'destroyed') return problem(res, 409, 'ORCH-INVALID-STATE', 'the instance is destroyed');
    if (body.access_epoch < r.accessEpoch || (body.access_epoch === r.accessEpoch && body.access !== r.access)) {
      return problem(res, 409, 'ORCH-STALE-ACCESS-EPOCH', 'the access epoch is older, or equal with another value');
    }
    if (body.access_epoch > r.accessEpoch || body.access !== r.access) {
      r.access = body.access;
      r.accessEpoch = body.access_epoch;
      r.updatedAt = stamp();
    }
    send(res, 200, view(r));
  }

  function destroy(res, r) {
    if (r.state === 'destroyed' || r.state === 'stopping') return send(res, 200, view(r));
    transition(r, 'stopping', 'destroy accepted');
    const answer = view(r);
    schedule(r);
    send(res, 202, answer);
  }

  function list(res, url) {
    const q = url.searchParams;
    for (const name of q.keys()) {
      if (!LABELS.has(name) && name !== 'cursor' && name !== 'limit') return problem(res, 422, 'ORCH-LABEL-UNKNOWN', 'not a label filter', pointer('query', name.slice(0, 64)));
    }
    for (const name of new Set(q.keys())) {
      if (q.getAll(name).length > 1) return problem(res, 422, 'ORCH-VALIDATION', 'given more than once', pointer('query', name.slice(0, 64)));
    }
    let limit = 100;
    if (q.has('limit')) {
      if (!/^[1-9][0-9]{0,2}$/.test(q.get('limit'))) return problem(res, 422, 'ORCH-VALIDATION', 'limit is 1 to 500', '/query/limit');
      limit = Number(q.get('limit'));
      if (limit > 500) return problem(res, 422, 'ORCH-VALIDATION', 'limit is 1 to 500', '/query/limit');
    }
    if (q.has('epoch') && !/^[1-9]\d*$/.test(q.get('epoch'))) return problem(res, 422, 'ORCH-VALIDATION', 'epoch is a positive integer', '/query/epoch');
    if (q.has('instance') && !RE.instanceId.test(q.get('instance'))) return problem(res, 422, 'ORCH-VALIDATION', 'bad instance id', '/query/instance');
    let after = null;
    if (q.has('cursor')) {
      after = decodeCursor(q.get('cursor'));
      if (after === null) return problem(res, 422, 'ORCH-CURSOR-INVALID', 'the cursor is not one this orchestrator handed out', '/query/cursor');
    }
    const items = [...records.keys()].sort().filter((id) => {
      const r = records.get(id);
      if (after !== null && id <= after) return false;
      if (q.has('instance') && id !== q.get('instance')) return false;
      if (q.has('epoch') && r.epoch !== Number(q.get('epoch'))) return false;
      if (q.has('template') && r.templateId !== q.get('template')) return false;
      if (q.has('component') && !COMPONENTS.has(q.get('component'))) return false;
      if (q.has('kind') && q.get('kind') !== 'inst') return false;
      return true;
    });
    const page = items.slice(0, limit);
    const next = items.length > limit ? encodeCursor(page[page.length - 1]) : null;
    send(res, 200, { items: page.map((id) => view(records.get(id))), next_cursor: next });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake.invalid');
    const method = req.method;

    // Test control, not part of the contract: unsigned, loopback only.
    const ctl = url.pathname.match(/^\/_fake\/v1\/instances\/([^/]+)\/activity$/);
    if (ctl) {
      const { buf } = await readBody(req);
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!local || method !== 'POST') return problem(res, 404, 'ORCH-ROUTE-UNKNOWN', 'not available');
      const r = records.get(ctl[1]);
      const [body] = parseJson(buf);
      if (!r) return problem(res, 404, 'ORCH-INSTANCE-NOT-FOUND', 'unknown instance');
      if (!body || !['ready', 'active', 'idle'].includes(body.state) || !RESETTABLE.has(r.state)) return problem(res, 409, 'ORCH-INVALID-STATE', 'activity only moves between ready, active and idle');
      if (body.state !== r.state) transition(r, body.state, 'player activity (fake control)'); // no change, no report
      return send(res, 200, view(r));
    }

    const { buf, tooLarge, sha256 } = await readBody(req);
    // 1. body size: a body over the limit is not read or hashed; answer 413 and drop the connection
    if (tooLarge) {
      res.setHeader('connection', 'close');
      res.on('finish', () => req.socket.destroy());
      return problem(res, 413, 'ORCH-BODY-TOO-LARGE', `the body is larger than ${MAX_BODY} bytes`);
    }
    // 2. signature
    if (!verify(req, sha256)) return problem(res, 401, 'ORCH-BAD-SIGNATURE', 'bad signature');

    // Order of checks after the signature (contract section 6): the call exists (404 / 405), the media type of a body (415), the shape of
    // the path id and of the body (422), the template (422), then the instance exists (404), its state and epoch (409), capacity (429).
    // So an unsupported media type is answered before an unknown instance, and a malformed body before an unknown instance.
    const route = (m, re) => (method === m ? url.pathname.match(re) : null);
    const isCreate = route('POST', /^\/v1\/instances$/);
    const isList = route('GET', /^\/v1\/instances$/);
    const isHost = route('GET', /^\/v1\/host$/);
    const isGet = route('GET', /^\/v1\/instances\/([^/]+)$/);
    const isAct = route('POST', /^\/v1\/instances\/([^/]+)\/(reset|access|destroy|activity)$/);
    if (!(isCreate || isList || isHost || isGet || isAct)) {
      const known = [
        [/^\/v1\/instances$/, 'GET, POST'], [/^\/v1\/host$/, 'GET'], [/^\/v1\/instances\/[^/]+$/, 'GET'],
        [/^\/v1\/instances\/[^/]+\/(reset|access|destroy|activity)$/, 'POST'],
      ].find(([re]) => re.test(url.pathname));
      if (known) return problem(res, 405, 'ORCH-METHOD-NOT-ALLOWED', `${method.slice(0, 16)} is not allowed here`, undefined, { allow: known[1] });
      return problem(res, 404, 'ORCH-ROUTE-UNKNOWN', 'no such call (fake orchestrator)');
    }
    if (buf.length > 0 && !JSON_TYPE.test(req.headers['content-type'] ?? '')) {
      return problem(res, 415, 'ORCH-UNSUPPORTED-MEDIA-TYPE', 'the body must be sent as application/json');
    }
    if (isCreate) {
      const [body, err] = parseJson(buf);
      return err ? fail(res, 422, err) : create(res, body);
    }
    if (isList) return list(res, url);
    if (isHost) {
      const live = [...records.values()].filter((r) => r.state !== 'destroyed').length;
      return send(res, 200, { host_id: cfg.hostId, kind: 'fake', capacity_memory_mb: cfg.capacityMb, used_memory_mb: usedMb(), instances: live, health: 'ok' });
    }
    if (isGet) {
      const r = getRecord(res, isGet[1]);
      return r && send(res, 200, view(r));
    }
    const [, id, action] = isAct;
    if (!RE.instanceId.test(id)) return fail(res, 422, bad('/instance_id', 'bad instance id'));
    if (action === 'destroy') {
      const r = getRecord(res, id);
      return r && destroy(res, r);
    }
    const [body, err] = parseJson(buf);
    if (err) return fail(res, 422, err);
    const e = action === 'reset' ? validateReset(body) : action === 'activity' ? validateActivity(body) : validateAccess(body);
    if (e) return fail(res, 422, e);
    const r = getRecord(res, id);
    if (!r) return undefined;
    return action === 'reset' ? reset(res, r, body) : action === 'activity' ? activity(res, r, body) : access(res, r, body);
  }
  const onRequest = (req, res) => {
    handle(req, res).catch((err) => {
      process.stderr.write(`fake orchestrator error: ${err.stack}\n`);
      if (!res.headersSent) problem(res, 500, 'ORCH-INTERNAL', 'internal error');
    });
  };
  const tlsGiven = [cfg.tlsCert, cfg.tlsKey, cfg.tlsCa].filter((v) => v !== undefined).length;
  if (tlsGiven !== 0 && tlsGiven !== 3) throw new Error('--tls-cert, --tls-key and --tls-ca must be given together');
  const server = tlsGiven
    ? https.createServer({
      cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey), ca: readFileSync(cfg.tlsCa),
      requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    }, onRequest)
    : http.createServer(onRequest);

  return {
    server,
    config: cfg,
    records,
    listen: () => new Promise((resolve) => server.listen(cfg.port, cfg.host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      for (const r of records.values()) clearTimeout(r.timer);
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
    flushReports: () => reportQueue,
  };
}

// ---- command line ----
function parseArgs(argv) {
  const map = { '--port': 'port', '--host': 'host', '--key': 'platformKey', '--capacity-mb': 'capacityMb', '--step-delay-ms': 'stepDelayMs', '--host-id': 'hostId', '--report-url': 'reportUrl', '--report-key': 'orchestratorKey', '--report-timeout-ms': 'reportTimeoutMs', '--tls-cert': 'tlsCert', '--tls-key': 'tlsKey', '--tls-ca': 'tlsCa' };
  const numeric = ['port', 'capacityMb', 'stepDelayMs', 'reportTimeoutMs'];
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = map[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    if (numeric.includes(name)) {
      const n = Number(argv[i + 1]);
      if (argv[i + 1].trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`${argv[i]} must be a finite number of 0 or more`);
      out[name] = n;
    } else out[name] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(err.message + '\n'); process.exit(2); }
  let svc;
  try { svc = createFakeOrchestrator(opts); } catch (err) { process.stderr.write(err.message + '\n'); process.exit(2); }
  const port = await svc.listen();
  process.stdout.write(JSON.stringify({ listening: true, port }) + '\n');
  const stop = () => svc.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
