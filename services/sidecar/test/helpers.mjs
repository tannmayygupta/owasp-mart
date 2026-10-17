// Test helpers. Every flag, decoy and key is made fresh at each run from pieces, so no flag-shaped literal exists in the source or the docs.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createSidecar } from '../src/sidecar.mjs';
import { listen } from '../src/common.mjs';

export const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const rand = (alphabet, n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
export const LB = String.fromCharCode(123);
export const RB = String.fromCharCode(125);
export const fakeFlag = () => 'VM' + LB + rand(B32, 24) + RB;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const KEYS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'];

export function freshValues() {
  return {
    instance_id: 'i-' + rand(B32, 16),
    epoch: 1,
    event_key: 'FAKE-TEST-KEY-' + rand('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 40),
    flags: KEYS.map((challenge_key) => ({ challenge_key, flag: fakeFlag() })),
    decoys: [{ challenge_key: 'C05', value: fakeFlag() }, { challenge_key: 'C03', value: fakeFlag() }],
  };
}
export const flagOf = (v, key) => v.flags.find((f) => f.challenge_key === key).flag;

export const startDoc = (v) => ({
  schema_version: '0.1', instance_id: v.instance_id, epoch: v.epoch, event_key: v.event_key,
  flag_digests: [
    ...v.flags.map((f) => ({ challenge_key: f.challenge_key, kind: 'real', sha256: sha256(f.flag) })),
    ...v.decoys.map((d) => ({ challenge_key: d.challenge_key, kind: 'decoy', sha256: sha256(d.value) })),
  ],
});

export const postedEvent = (overrides = {}) => ({
  schema_version: '0.1', type: 'shop.catalog_query_error', source: 'shop', session_kind: 'player', user_id: 'u-1001',
  ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), data: { route: '/api/products/search', error_class: 'sql_syntax' }, ...overrides,
});

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(15); }
  return false;
}

// Resolves { status, text, body (Buffer), headers }.
export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { const buf = Buffer.concat(c); resolve({ status: res.statusCode, text: buf.toString('utf8'), body: buf, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
export const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// A scripted shop: handler(req, body) -> { status, headers, body } where body is a Buffer or string. Records every request it received.
export async function shop(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => {
      const body = Buffer.concat(c);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const r = handler(req, body);
      res.writeHead(r.status ?? 200, r.headers ?? {});
      if (!r.chunks) return res.end(r.body ?? '');
      // sent in pieces cut at the given offsets, with a pause between them, so the pieces reach the sidecar separately
      const buf = Buffer.from(r.body);
      const cuts = [0, ...r.chunks, buf.length];
      (function next(i) {
        if (i >= cuts.length - 1) return res.end();
        res.write(buf.subarray(cuts[i], cuts[i + 1]));
        setTimeout(() => next(i + 1), 20);
      })(0);
    });
  });
  return { server, seen, port: await listen(server, 0, '127.0.0.1') };
}

// A relay that answers from a script (statuses), and keeps the signed bodies it got.
export async function scripted(statuses) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { calls.push({ sig: req.headers['x-vm-signature'], body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(statuses[Math.min(calls.length - 1, statuses.length - 1)]); res.end('{}'); });
  });
  return { server, calls, port: await listen(server, 0, '127.0.0.1') };
}

export async function boot({ relayPort, upstreamPort = 1, v = freshValues(), startOverride, ...opts }) {
  const alarms = [];
  const start = startOverride ?? startDoc(v);
  const sc = createSidecar({
    start, relayUrl: `http://127.0.0.1:${relayPort}/internal/v1/events`, upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    alarm: (m) => alarms.push(m), retryMinMs: 15, retryMaxMs: 60, requestTimeoutMs: 500, ...opts,
  });
  const ports = await sc.listen({ eventsPort: 0, playerPort: 0, host: '127.0.0.1' });
  return { sc, ports, v, alarms, post: (body, extra = {}) => request(ports.eventsPort, { method: 'POST', path: '/v1/events', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra }) };
}

export const gzip = (s) => zlib.gzipSync(Buffer.from(s));
export const deflate = (s) => zlib.deflateSync(Buffer.from(s));
export const brotli = (s) => zlib.brotliCompressSync(Buffer.from(s));
