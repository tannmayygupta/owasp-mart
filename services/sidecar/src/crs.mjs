// The request-side detection helper of the sidecar (story 6.5, D-70): the Go program crs-detect (Coraza v3 and the OWASP Core Rule Set, DETECTION ONLY)
// runs as a child process in the same image and listens on 127.0.0.1 only. The sidecar asks it one question per player request, AFTER the answer
// has been handed to the player, with a short timeout and a cap on calls in flight. The helper's answer is turned into one proxy.crs_match event.
// The helper never decides anything: a missing, slow, busy or crashed helper only means no crs_match event. Player traffic is never touched.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { blankSecrets, redactFlagLike, BODY_CAP_BYTES } from './capture.mjs';

export const DEFAULT_BINARY = '/app/crs-detect';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 9100;
export const CALL_TIMEOUT_MS = 300;
export const MAX_IN_FLIGHT = 8;
export const MAX_RESTARTS = 3; // in one minute
export const RESTART_WINDOW_MS = 60000;
export const MAX_ANSWER_BYTES = 64 * 1024;

const TAG_PREFIXES = ['attack-', 'language-', 'platform-'];
const NEVER_SENT_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const INTERNAL_HEADER = /^x-vm-/i;

// CRS tag -> the schema's class pattern ^[a-z0-9_]{1,32}$. Only attack-, language- and platform- tags; at most 20; no repeats.
export function mapTags(tags) {
  const out = [];
  if (!Array.isArray(tags)) return out;
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const lower = t.toLowerCase();
    if (!TAG_PREFIXES.some((p) => lower.startsWith(p))) continue;
    const mapped = lower.replace(/[^a-z0-9_]/g, '_').slice(0, 32);
    if (!/^[a-z0-9_]{1,32}$/.test(mapped) || out.includes(mapped)) continue;
    out.push(mapped);
    if (out.length >= 20) break;
  }
  return out;
}

// Numeric CRS rule ids, 3 to 9 digits, at most 50.
export function mapRuleIds(ids) {
  const out = [];
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    const s = typeof id === 'number' && Number.isInteger(id) ? String(id) : id;
    if (typeof s !== 'string' || !/^[0-9]{3,9}$/.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

export function mapScore(n) {
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), 10000) : 0;
}

// The document sent to the helper: no cookie or authorization header, no x-vm-* header, flag-like text and credentials blanked (same
// redaction as the evidence capture), body cut to 8 KiB. Nothing here is logged.
export function buildInspectDoc({ method, url, headers, bodyBuf }) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (NEVER_SENT_HEADERS.has(name) || INTERNAL_HEADER.test(name)) continue;
    h[name] = redactFlagLike(Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 1024);
  }
  const body = bodyBuf && bodyBuf.length ? redactFlagLike(blankSecrets(bodyBuf.subarray(0, BODY_CAP_BYTES).toString('utf8'))) : '';
  return { method: String(method).slice(0, 16), uri: redactFlagLike(blankSecrets(String(url).slice(0, 2048))), headers: h, body };
}

// The helper's answer -> the data of proxy.crs_match (without route_template), or null when there is no match.
export function matchData(answer) {
  if (answer === null || typeof answer !== 'object') return null;
  const rule_ids = mapRuleIds(answer.rule_ids);
  if (!rule_ids.length) return null;
  return { rule_ids, tags: mapTags(answer.tags), anomaly_score: mapScore(answer.anomaly_score) };
}

// createCrs: the supervisor and the caller. Returns { enabled, stats, inspect(info) (never throws, returns a promise that never rejects), stop() }.
//  binary: path of the helper, or null for none (then everything is off, no error: "--no-crs behaviour")
//  spawnFn / existsFn: tests only
export function createCrs({
  binary = DEFAULT_BINARY, enabled = true, host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = CALL_TIMEOUT_MS, maxInFlight = MAX_IN_FLIGHT,
  spawnFn = spawn, existsFn = fs.existsSync, manage = true, restartDelayMs = 200, alarm = () => {}, now = Date.now, extraArgs = [],
} = {}) {
  const stats = { crs_calls: 0, crs_matches: 0, crs_unavailable: 0, crs_timeouts: 0, crs_busy: 0, crs_errors: 0, crs_restarts: 0, crs_gave_up: 0 };
  const noop = { enabled: false, stats, inspect: async () => null, stop() {} };
  if (!enabled) return noop;
  if (manage && (!binary || !existsFn(binary))) return noop; // default on only when the binary exists

  let child = null;
  let stopped = false;
  let gaveUp = false;
  const starts = [];
  let timer = null;
  let alarmed = false;
  const alarmOnce = (m) => { if (alarmed) return; alarmed = true; try { alarm(m); } catch { /* the alarm sink must not matter */ } };

  function launch() {
    if (stopped || gaveUp) return;
    const t = now();
    while (starts.length && t - starts[0] >= RESTART_WINDOW_MS) starts.shift();
    if (starts.length > MAX_RESTARTS) { // the first start plus 3 restarts in a minute
      gaveUp = true; stats.crs_gave_up += 1; alarmOnce('alarm: crs helper stopped, not restarted any more'); return;
    }
    if (starts.length) stats.crs_restarts += 1;
    starts.push(t);
    try {
      child = spawnFn(binary, ['--listen', `${host}:${port}`, ...extraArgs], { stdio: 'ignore', shell: false, windowsHide: true });
    } catch { child = null; stats.crs_errors += 1; schedule(); return; }
    child.on('error', () => { stats.crs_errors += 1; child = null; schedule(); });
    child.on('exit', () => { child = null; schedule(); });
  }
  function schedule() {
    if (stopped || gaveUp) return;
    timer = setTimeout(launch, restartDelayMs);
    timer.unref?.();
  }
  if (manage) launch();

  let inFlight = 0;
  function call(doc) {
    return new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(doc));
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const req = http.request({ host, port, method: 'POST', path: '/inspect', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > MAX_ANSWER_BYTES) { stats.crs_errors += 1; req.destroy(); done(null); return; } chunks.push(c); });
        res.on('end', () => {
          if (res.statusCode !== 200) { stats.crs_errors += 1; return done(null); }
          try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { stats.crs_errors += 1; done(null); }
        });
        res.on('error', () => { stats.crs_errors += 1; done(null); });
      });
      const timeout = setTimeout(() => { stats.crs_timeouts += 1; req.destroy(); done(null); }, timeoutMs);
      const finish = () => clearTimeout(timeout);
      req.on('close', finish);
      req.on('error', () => { if (!settled) stats.crs_unavailable += 1; done(null); });
      req.end(body);
    });
  }

  // info: { method, url, headers, bodyBuf }. Resolves the proxy.crs_match data (no route_template) or null. Never rejects.
  async function inspect(info) {
    try {
      if (stopped) return null;
      if (inFlight >= maxInFlight) { stats.crs_busy += 1; return null; }
      inFlight += 1;
      stats.crs_calls += 1;
      try {
        const answer = await call(buildInspectDoc(info));
        const data = matchData(answer);
        if (data) stats.crs_matches += 1;
        return data;
      } finally { inFlight -= 1; }
    } catch { stats.crs_errors += 1; return null; }
  }

  return {
    enabled: true, stats, inspect,
    inFlight: () => inFlight,
    stop() { stopped = true; clearTimeout(timer); try { child?.kill(); } catch { /* gone */ } },
  };
}
