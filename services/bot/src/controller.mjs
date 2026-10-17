// Support-agent bot controller (T-13, FR-SHP-11). The bot visits support pages so
// that stored content (a future C03 stored-XSS payload in a ticket/dispute) is
// rendered under the support-agent role. Safety rules this story enforces:
//   - it opens ONLY pages of its OWN instance (same origin as its target) and
//     only an allow-listed set of paths; everything else is refused;
//   - each visit is time-bounded (it never lingers);
//   - its memory is measurable per instance (spike S-5).
//
// This is the CONTROLLER with a pluggable visitor. The default visitor is an HTTP
// GET (Node built-ins). The headless-browser visitor that actually executes page
// JS (needed for C03) and its full memory profile are the S-5 spike / C03 work.
import http from 'node:http';
import crypto from 'node:crypto';

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function readJson(req, cap = 16384) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => { size += c.length; if (size > cap) finish({ tooLarge: true }); else chunks.push(c); });
    req.on('end', () => { if (size > cap) return finish({ tooLarge: true }); try { finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { finish({ bad: true }); } });
    req.on('error', () => finish({ bad: true }));
    req.on('aborted', () => finish({ bad: true }));
    req.on('close', () => finish({ bad: true }));
  });
}

// A page is allowed only if it is on the bot's OWN instance (same origin as the
// target) and its path starts with an allow-listed prefix.
export function isAllowed(targetOrigin, url, allowPrefixes) {
  if (!(url instanceof URL)) return false;
  if (url.origin !== targetOrigin) return false;
  // Match the exact path or anything strictly UNDER the prefix. A prefix without a
  // trailing slash must not over-match a sibling (e.g. /staff/tickets must not
  // allow /staff/ticketsX) — require a path separator after it.
  return allowPrefixes.some((p) => url.pathname === p || url.pathname.startsWith(p.endsWith('/') ? p : `${p}/`));
}

// The default visitor: a time-bounded HTTP GET whose body read is also SIZE-capped,
// so a large page served quickly cannot OOM the bot (the time bound alone would
// not stop a fast large body). Never throws.
export async function visitHttp(href, { timeoutMs = 5000, maxBodyBytes = 1 << 20 } = {}) {
  try {
    const r = await fetch(href, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (r.body) {
      const reader = r.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBodyBytes) { try { await reader.cancel(); } catch { /* already done */ } break; }
      }
    }
    return { ok: true, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function createBotController({
  target,
  allowPrefixes = ['/tickets/', '/staff/tickets', '/product/', '/disputes/'],
  maxVisitMs = 5000,
  visit = visitHttp,
} = {}) {
  const targetOrigin = new URL(target).origin;
  const visits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/stats') return sendJson(res, 200, { visits: visits.length, memory: process.memoryUsage() });
    if (req.method === 'POST' && url.pathname === '/visit') {
      const b = await readJson(req);
      if (b.tooLarge) return sendJson(res, 413, { error: 'too_large' });
      const path = b.value?.path;
      if (b.bad || typeof path !== 'string') return sendJson(res, 400, { error: 'path (string) is required' });
      let dest;
      try { dest = new URL(path, target); } catch { return sendJson(res, 400, { error: 'bad path' }); }
      if (!isAllowed(targetOrigin, dest, allowPrefixes)) {
        return sendJson(res, 403, { refused: true, reason: 'not a page of this instance, or not allow-listed', path });
      }
      const started = Date.now();
      const result = await visit(dest.href, { timeoutMs: maxVisitMs });
      const record = { visit_id: crypto.randomUUID(), path: dest.pathname, status: result.status, duration_ms: Date.now() - started };
      visits.push(record);
      return sendJson(res, 200, { visited: true, ...record });
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
  return { server, visits, targetOrigin };
}
