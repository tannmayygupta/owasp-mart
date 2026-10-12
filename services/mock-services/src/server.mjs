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
export function createMetadata({ placementDir = PLACEMENT_DIR } = {}) {
  // The injector writes exactly one "file in mock-services" placement file (C10);
  // its NAME comes from the challenge catalogue (IF-7), only the directory is
  // fixed by IF-6. So serve whichever single file is there, not a hardcoded name.
  const readPlacement = () => {
    try {
      const file = fs.readdirSync(placementDir).find((f) => fs.statSync(path.join(placementDir, f)).isFile());
      return file ? fs.readFileSync(path.join(placementDir, file), 'utf8').trim() : null;
    } catch { return null; }
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/rates') return sendJson(res, 200, { base: 'USD', rates: { EUR: 0.92, GBP: 0.79, INR: 83.2 } });
    if (req.method === 'GET' && url.pathname === '/latest/user-data') {
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
// Records what it is sent (a stored-XSS payload would exfiltrate here, C03). It
// only collects; it never serves a flag.
export function createCollector() {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/hits') return sendJson(res, 200, { count: hits.length });
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/collect')) {
      const b = await readJson(req);
      if (b.tooLarge) return sendJson(res, 413, { error: 'too_large' });
      hits.push({ at: new Date().toISOString(), size: JSON.stringify(b.value ?? null).length });
      return sendJson(res, 202, { status: 'collected' });
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
  return { server, hits };
}

export function createMockServices(opts = {}) {
  return {
    payment: createPayment(),
    kyc: createKyc(),
    metadata: createMetadata(opts),
    collector: createCollector(),
  };
}
