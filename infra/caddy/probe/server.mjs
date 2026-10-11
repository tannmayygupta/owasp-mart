// Throwaway probe upstream for spike S-14 (story LE-3, ADR 0031): runs behind the platform Caddy on vm-p and answers what scripts/check-sse-rewrite.mjs asks.
// Node built-ins only. It never prints or returns the origin secret: it only says whether the header was present.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A number from a query value or setting: null, empty or non-numeric gives the default; everything else is cut to [min, max]. */
export function numberParam(v, def, min, max) {
  if (v === null || v === undefined || String(v).trim() === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
};
// Header names that are never echoed (the secret and credentials); the others are echoed so the check can see what Vercel and Caddy add.
const HIDDEN = new Set(['x-origin-secret', 'authorization', 'cookie']);
const MAX_BODY = 64 * 1024;
const DEFAULT_MAX_STREAM_S = 600;
const CEILING_MAX_STREAM_S = 3600;

/** @param {{heartbeatMs?: number}} [o] */
export function createProbe({ heartbeatMs = 15000 } = {}) {
  let hits = 0; // requests that reached the probe (the gate test reads it to prove a refused request never got here)
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://probe');
    const p = url.pathname;
    if (p === '/api/v1/hits') return json(res, 200, { hits });
    hits += 1;
    if (p === '/api/v1/healthz') return json(res, 200, { ok: true });
    if (p === '/api/v1/echo') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      req.on('end', () => {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HIDDEN.has(k)) headers[k] = v;
        json(res, 200, {
          method: req.method, path: req.url, host: req.headers.host ?? null,
          secretPresent: typeof req.headers['x-origin-secret'] === 'string' && req.headers['x-origin-secret'] !== '',
          bodyLength: size, body: size <= MAX_BODY ? Buffer.concat(chunks).toString('utf8') : null, headers,
        });
      });
      return undefined;
    }
    if (p === '/api/v1/cookie') {
      const seen = /(?:^|;\s*)probe=/.test(req.headers.cookie ?? '');
      return json(res, 200, { cookieSeen: seen }, { 'set-cookie': 'probe=s14; Path=/; HttpOnly; Secure; SameSite=Lax' });
    }
    if (p === '/api/v1/cacheable') {
      // A response that a shared cache MAY keep (public, max-age=60) with a fresh random body per request: if two different callers get the same body,
      // something in between cached it (the failure the check looks for, architecture 03 section 1.3).
      return json(res, 200, { rand: randomUUID(), user: req.headers['x-probe-user'] ?? null }, { 'cache-control': 'public, max-age=60' });
    }
    if (p === '/api/v1/stream') {
      const interval = numberParam(url.searchParams.get('interval'), 1000, 10, 60000);
      const count = numberParam(url.searchParams.get('count'), 0, 0, 100000); // 0 = until the client leaves or the maximum age
      const heartbeat = numberParam(url.searchParams.get('heartbeat'), heartbeatMs, 10, 600000);
      const maxS = numberParam(url.searchParams.get('max'), DEFAULT_MAX_STREAM_S, 1, CEILING_MAX_STREAM_S);
      let id = numberParam(req.headers['last-event-id'], 0, 0, Number.MAX_SAFE_INTEGER);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      let sent = 0;
      const stop = () => { clearInterval(ev); clearInterval(hb); clearTimeout(age); };
      const ev = setInterval(() => {
        id += 1; sent += 1;
        res.write(`id: ${id}\nevent: tick\ndata: ${JSON.stringify({ n: id, t: Date.now() })}\n\n`);
        if (count && sent >= count) { stop(); res.end(); }
      }, interval);
      const hb = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), heartbeat);
      const age = setTimeout(() => { stop(); res.end(); }, maxS * 1000); // a stream never lives longer than its maximum age
      req.on('close', stop);
      return undefined;
    }
    return json(res, 404, { error: 'not found' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = numberParam(process.env.PORT, 8080, 1, 65535);
  createProbe({ heartbeatMs: numberParam(process.env.HEARTBEAT_MS, 15000, 10, 600000) }).listen(port, '0.0.0.0', () => console.log(`probe listening on ${port}`));
}
