// Combined mock-services for a VulnMart instance (T-11, FR-SHP-13). One process,
// four small HTTP services on the instance network only (never published):
//   9101 payment gateway   9102 KYC provider   9103 metadata   9104 XSS collector
//
// Correct flow only. The deliberate weaknesses the challenges rely on live in the
// CALLER, not here: C08 is the shop's webhook handler skipping signature checks
// (the gateway here always signs); C11 is the shop's onboarding failing OPEN on a
// KYC error (the KYC here fails CLOSED); C10 is the shop's importer reaching this
// metadata service (the service itself just serves its data); C03 is stored XSS in
// the shop (the collector here just records what it is sent). No real secret is
// baked in; the per-instance C10 flag arrives in the read-only placement file.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PORTS = { payment: 9101, kyc: 9102, metadata: 9103, collector: 9104 };
const PLACEMENT_DIR = process.env.VM_PLACEMENT_MOCK_DIR ?? '/run/placement/mock';
// The gateway signs its events; the shop is meant to verify this (C08). Non-secret
// dev default; a real instance passes the per-instance key in the environment.
const GATEWAY_KEY = process.env.VM_GATEWAY_SIGNING_KEY ?? 'mock-gateway-dev-key';

function sendJson(res, status, obj, headers = {}) {
  if (res.writableEnded || res.destroyed) return; // never write to a torn-down socket
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}
// Read a JSON body with a size cap. Resolves once (never rejects); over-cap is
// reported (not by destroying the request, which could tear the socket down
// before the 413 is sent and crash the shared process); an aborted/closed
// request resolves too, so the handler never hangs.
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
const sign = (body) => crypto.createHmac('sha256', GATEWAY_KEY).update(body).digest('hex');

// ---- 9101 payment gateway -------------------------------------------------
// Charges a pending order and records a ledger entry; its events are signed. The
// ledger is readable (the monitor uses "paid but no ledger entry" to detect C08).
export function createPayment() {
  const ledger = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/ledger') return sendJson(res, 200, { entries: ledger });
    if (req.method === 'POST' && url.pathname === '/charge') {
      const b = await readJson(req);
      if (b.tooLarge) return sendJson(res, 413, { error: 'too_large' });
      if (b.bad || !b.value || typeof b.value.order_id !== 'string' || !Number.isInteger(b.value.amount) || b.value.amount <= 0) {
        return sendJson(res, 400, { error: 'order_id (string) and amount (positive integer) are required' });
      }
      const reference = `gw-${crypto.randomUUID()}`;
      const event = { type: 'payment.succeeded', order_id: b.value.order_id, amount: b.value.amount, reference };
      const signature = sign(JSON.stringify(event));
      ledger.push({ order_id: b.value.order_id, amount: b.value.amount, reference });
      // The gateway always signs (the shop is meant to verify; skipping that is C08).
      return sendJson(res, 200, { ...event, signature }, { 'x-gateway-signature': `v1=${signature}` });
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
  return { server, ledger };
}

// ---- 9102 KYC provider ----------------------------------------------------
// Verifies a seller tax id. Fails CLOSED: malformed input is a 400 error, never a
// silent "verified" (the fail-OPEN that auto-approves a seller is C11, in the shop).
export function createKyc() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'POST' && url.pathname === '/verify') {
      const b = await readJson(req);
      if (b.tooLarge) return sendJson(res, 413, { error: 'too_large' });
      const taxId = b.value?.tax_id;
      if (b.bad || typeof taxId !== 'string' || !/^[A-Z0-9-]{6,32}$/.test(taxId)) {
        return sendJson(res, 400, { error: 'tax_id must be 6-32 chars of A-Z, 0-9, -' });
      }
      // A simple deterministic rule stands in for a real check.
      const outcome = taxId.endsWith('0') ? 'rejected' : 'verified';
      return sendJson(res, 200, { outcome, tax_id: taxId });
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
  return { server };
}

// ---- 9103 metadata (IMDSv1-style internal service) ------------------------
// /rates is called legitimately by the shop; /latest/user-data imitates cloud
// instance metadata and serves the per-instance C10 flag from the read-only
// placement file (the SSRF that reaches this from the shop's importer is C10).
// Every request it serves is reported to the sidecar as `meta.request_served` (IF-4): the path and who asked (ua_class importer for the shop's importer, health for the
// health check, rates for the shop's own rates call). It is the signal that the importer really reached an internal service (the second milestone of C10).
const uaClassOf = (req, pathname) => (pathname === '/healthz' ? 'health' : /^VulnMart-Importer\//.test(String(req.headers['user-agent'] ?? '')) ? 'importer' : 'rates');

export function createMetadata({ placementDir = PLACEMENT_DIR, eventsUrl = process.env.VM_SIDECAR_EVENTS_URL, post = postEvent } = {}) {
  // The injector writes exactly one "file in mock-services" placement file (C10);
  // its NAME comes from the challenge catalogue (IF-7), only the directory is
  // fixed by IF-6. So serve whichever single file is there, not a hardcoded name.
  // A decoy file (C10.decoy<n>, H-42) may sit in the same volume: it is never served. The placement file is C10.placement, or else the one file that is not a decoy.
  const readPlacement = () => {
    try {
      const files = fs.readdirSync(placementDir).filter((f) => !/\.decoy\d+$/.test(f) && fs.statSync(path.join(placementDir, f)).isFile());
      const file = files.includes('C10.placement') ? 'C10.placement' : files[0];
      return file ? fs.readFileSync(path.join(placementDir, file), 'utf8').trim() : null;
    } catch { return null; }
  };
  const served = (req, pathname) => {
    if (!eventsUrl) return;
    post(eventsUrl, { schema_version: '0.1', type: 'meta.request_served', source: 'mock', session_kind: 'anon', user_id: null,
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), data: { path: pathname.slice(0, 200), ua_class: uaClassOf(req, pathname) } });
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/rates') { served(req, url.pathname); return sendJson(res, 200, { base: 'USD', rates: { EUR: 0.92, GBP: 0.79, INR: 83.2 } }); }
    if (req.method === 'GET' && url.pathname === '/latest/user-data') {
      served(req, url.pathname);
      const flag = readPlacement();
      const userData = `#!/bin/sh\n# vm-meta startup\nexport VM_REGION=lab-1\n${flag ? `export VM_C10=${flag}\n` : ''}`;
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(userData);
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
  return { server };
}

// ---- 9104 XSS collector ---------------------------------------------------
// Records what it is sent (a stored-XSS payload running in the support bot exfiltrates here, C03 part B). It only collects; it never serves a flag.
//   /c/<id>[...]  any method: one hit. `collector_id_ok` is true when <id> is this instance's collector id (the instance id without "i-", lowercase; any id when the instance id
//                 is not known), `bot_tagged` is true when the request carries the visit tag the bot's network layer adds (x-vm-visit), `size` counts the query string and body.
//                 The answer is a 1x1 GIF with open CORS, so an image or a fetch of the page both succeed.
//   POST / and /collect: the original JSON drop, kept for the other tests.
//   GET /inbox    the last 20 hits, newest last (what the shop's listener page shows the player); GET /hits the count.
// Each hit on /c/ is reported to the sidecar as `collector.hit` (IF-4), ids and counts only, never the content. The flag never passes through the sidecar: the player pastes it.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const TAG = /^v-[0-9a-f-]{36}$/;
const FLAG_LIKE = /VM\{[A-Z2-7]{24}\}/;
const INBOX_CAP = 20;
const DATA_CAP = 2048;

export const collectorIdFor = (instanceId) => String(instanceId ?? '').replace(/^i-/, '').toLowerCase();

export function createCollector({ instanceId = process.env.VM_INSTANCE_ID, eventsUrl = process.env.VM_SIDECAR_EVENTS_URL, post = postEvent } = {}) {
  const hits = [];
  const expectedId = collectorIdFor(instanceId);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/hits') return sendJson(res, 200, { count: hits.length });
    if (req.method === 'GET' && url.pathname === '/inbox') return sendJson(res, 200, { id: expectedId || null, hits: hits.slice(-INBOX_CAP) });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'c' && parts.length >= 2) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      let body = '';
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        let size = 0;
        await new Promise((resolve) => {
          req.on('data', (c) => { size += c.length; if (size <= 16384) chunks.push(c); });
          req.on('end', resolve); req.on('error', resolve); req.on('close', resolve);
        });
        body = Buffer.concat(chunks).toString('utf8');
      }
      const query = url.search.slice(1);
      const content = `${query}${query && body ? ' | ' : ''}${body}`;
      const tagged = TAG.test(String(req.headers['x-vm-visit'] ?? ''));
      const idOk = expectedId ? parts[1].toLowerCase() === expectedId : true;
      const record = { at: new Date().toISOString(), method: req.method, path: url.pathname, bot_tagged: tagged, collector_id_ok: idOk, size: Buffer.byteLength(content), data: safeDecode(content).slice(0, DATA_CAP) };
      hits.push(record);
      if (hits.length > INBOX_CAP) hits.shift();
      if (eventsUrl) {
        const flag = FLAG_LIKE.exec(record.data)?.[0];
        const data = { collector_id_ok: idOk, bot_tagged: tagged, size: record.size };
        if (flag) data.candidate_sha256 = crypto.createHash('sha256').update(flag).digest('hex');
        post(eventsUrl, { schema_version: '0.1', type: 'collector.hit', source: 'mock', session_kind: 'anon', user_id: null, ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), data });
      }
      res.writeHead(200, { 'content-type': 'image/gif', 'content-length': GIF.length, 'cache-control': 'no-store', ...cors });
      return res.end(GIF);
    }
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/collect')) {
      const b = await readJson(req);
      if (b.tooLarge) return sendJson(res, 413, { error: 'too_large' });
      hits.push({ at: new Date().toISOString(), size: JSON.stringify(b.value ?? null).length });
      if (hits.length > INBOX_CAP) hits.shift();
      return sendJson(res, 202, { status: 'collected' });
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
  return { server, hits };
}

const safeDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

// Best effort: a hit must never fail because the sidecar is slow or absent.
function postEvent(eventsUrl, event) {
  try {
    fetch(new URL('/v1/events', eventsUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(3000) }).catch(() => {});
  } catch { /* no usable URL */ }
}
export function createMockServices(opts = {}) {
  return {
    payment: createPayment(),
    kyc: createKyc(),
    metadata: createMetadata(opts),
    collector: createCollector(),
  };
}
