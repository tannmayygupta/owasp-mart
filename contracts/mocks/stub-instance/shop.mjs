// Stub shop (IF-6 section 3, IF-4 section 3). A tiny HTTP program, not a shop.
//   GET /healthz  200 when the process is up
//   GET /readyz   200 only when the injector marker exists AND the database is open (the snapshot copied to /data and read); else 503
//   GET /version  build id and catalogue version, no secret
// Test-only routes under /_stub/ (not part of IF-6, never in a product; they exist so the conformance check can see the behaviour):
//   GET  /_stub/planted-flag?key=C01   the flag of that challenge, read from the flags file at request time (only when ready)
//   POST /_stub/emit                   body {"kind": "valid" | "too-big" | "wrong-type" | "bad-json" | "forbidden-source" | "get"}:
//                                      posts that event to the sidecar and returns the sidecar's status (the IF-4 answer rows)
// It logs method, path (no query) and status only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sendJson, sendProblem, STUB_BUILD_ID, ts } from './common.mjs';

export function postedEvent(overrides = {}) {
  return {
    schema_version: '0.1',
    type: 'shop.catalog_query_error',
    source: 'shop',
    session_kind: 'player',
    user_id: 'u-1001',
    ts: ts(),
    data: { route: '/api/products/search', error_class: 'sql_syntax' },
    ...overrides,
  };
}

// What each "kind" sends to the sidecar. method, content type and body are exactly what IF-4 section 3 says the sidecar must refuse (or accept).
export function emitRequest(kind) {
  const json = { 'content-type': 'application/json' };
  switch (kind) {
    case 'valid': return { method: 'POST', headers: json, body: JSON.stringify(postedEvent()) };
    case 'too-big': return { method: 'POST', headers: json, body: JSON.stringify(postedEvent({ data: { route: '/api/products/search', error_class: 'sql_syntax', pad: 'x'.repeat(5000) } })) };
    case 'wrong-type': return { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(postedEvent()) };
    case 'bad-json': return { method: 'POST', headers: json, body: '{"type": ' };
    case 'forbidden-source': return { method: 'POST', headers: json, body: JSON.stringify(postedEvent({ source: 'sidecar' })) };
    case 'get': return { method: 'GET', headers: {}, body: undefined };
    default: return null;
  }
}

function sendToSidecar(eventsUrl, spec, timeoutMs = 3000) {
  const u = new URL('/v1/events', eventsUrl);
  return new Promise((resolve) => {
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: spec.method, headers: { ...spec.headers, ...(spec.body !== undefined ? { 'content-length': Buffer.byteLength(spec.body) } : {}) }, timeout: timeoutMs }, (r) => {
      r.resume();
      r.on('end', () => resolve(r.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    req.end(spec.body);
  });
}

export function createShop({
  flagsPath = '/run/vm/flags.json',
  snapshotPath = '/run/vm/snapshot.db',
  dbPath = '/data/shop.db',
  eventsUrl = 'http://sidecar:9000',
  log = (m) => console.log(m),
} = {}) {
  const markerPath = path.join(path.dirname(flagsPath), 'injected');
  let db = null; // the opened database (parsed stub snapshot)

  // The database is "open" when the snapshot has been copied to dbPath and read. Retried on every call until it works.
  function openDb() {
    if (db) return true;
    try {
      fs.rmSync(dbPath, { force: true }); // a partial copy from an earlier try is read-only (the snapshot is 0444) and would block the next copy
      fs.copyFileSync(snapshotPath, dbPath);
      db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      return true;
    } catch { db = null; try { fs.rmSync(dbPath, { force: true }); } catch { /* nothing to remove */ } return false; }
  }
  const ready = () => fs.existsSync(markerPath) && openDb();

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return sendProblem(res, 400, 'Bad request target'); }
    const done = (status) => log(`${req.method} ${url.pathname} ${status}`);
    res.on('finish', () => done(res.statusCode));
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/readyz') {
      return ready() ? sendJson(res, 200, { status: 'ready' }) : sendJson(res, 503, { status: 'not ready' });
    }
    if (req.method === 'GET' && url.pathname === '/version') return sendJson(res, 200, { build_id: STUB_BUILD_ID, catalogue_version: 'stub-0' });
    if (req.method === 'GET' && url.pathname === '/_stub/planted-flag') {
      if (!ready()) return sendProblem(res, 503, 'Not ready');
      try {
        const doc = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
        const f = doc.flags.find((x) => x.challenge_key === url.searchParams.get('key'));
        return f ? sendJson(res, 200, { challenge_key: f.challenge_key, flag: f.flag }) : sendProblem(res, 404, 'No such challenge');
      } catch { return sendProblem(res, 503, 'Not ready'); }
    }
    if (req.method === 'POST' && url.pathname === '/_stub/emit') {
      const chunks = [];
      for await (const c of req) { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 1024) return sendProblem(res, 413, 'Too large'); }
      let kind = 'valid';
      try { kind = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').kind || 'valid'; } catch { return sendProblem(res, 400, 'Bad JSON'); }
      const spec = emitRequest(kind);
      if (!spec) return sendProblem(res, 422, 'Unknown kind');
      return sendJson(res, 200, { kind, sidecar_status: await sendToSidecar(eventsUrl, spec) });
    }
    return sendProblem(res, 404, 'Not found');
  });
  return { server, isReady: ready };
}
