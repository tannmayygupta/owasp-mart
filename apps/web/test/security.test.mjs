// Unit tests of the dashboards' security rules (apps/web/lib/security.mjs): run in CI by node --test "apps/*/test/*.test.mjs".
import test from 'node:test';
import assert from 'node:assert/strict';
import { DROPPED_FROM_BROWSER, NO_STORE, ORIGIN_SECRET_HEADER, buildCsp, fixedHeaders, makeNonce, upstreamHeaders, upstreamUrl } from '../lib/security.mjs';

const directives = (csp) => Object.fromEntries(csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v]; }));

test('a nonce is fresh, base64 and 128 bits', () => {
  const seen = new Set(Array.from({ length: 200 }, makeNonce));
  assert.equal(seen.size, 200);
  for (const n of seen) {
    assert.match(n, /^[A-Za-z0-9+/]{22}==$/);
    assert.equal(Buffer.from(n, 'base64').length, 16);
  }
});

test('the production CSP allows scripts and styles only with the nonce, nothing inline, no framing', () => {
  const d = directives(buildCsp({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', https: true }));
  assert.deepEqual(d['script-src'], ["'self'", "'nonce-AAAAAAAAAAAAAAAAAAAAAA=='", "'strict-dynamic'"]);
  assert.deepEqual(d['style-src'], ["'self'", "'nonce-AAAAAAAAAAAAAAAAAAAAAA=='"]);
  assert.deepEqual(d['frame-ancestors'], ["'none'"]);
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['base-uri'], ["'none'"]);
  assert.deepEqual(d['connect-src'], ["'self'"], 'the browser talks to this origin only');
  assert.ok('upgrade-insecure-requests' in d);
  const csp = buildCsp({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', https: true });
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
});

test('the development CSP adds only what hot reload needs, and no HTTPS upgrade on plain http', () => {
  const d = directives(buildCsp({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', dev: true }));
  assert.ok(d['script-src'].includes("'unsafe-eval'"));
  assert.ok(d['style-src'].includes("'unsafe-inline'"));
  assert.deepEqual(d['connect-src'], ["'self'", 'ws:', 'wss:']);
  assert.ok(!('upgrade-insecure-requests' in d), 'http://127.0.0.1 would break if requests were upgraded');
  assert.deepEqual(d['frame-ancestors'], ["'none'"], 'framing is denied in development too');
});

test('a nonce that is not base64 is refused (it would break out of the header)', () => {
  for (const bad of ['', 'short', "abc'; script-src *", 'AAAAAAAAAAAAAAAA AAAA']) {
    assert.throws(() => buildCsp({ nonce: bad }));
  }
});

test('the fixed headers, with HSTS only over HTTPS', () => {
  const http = fixedHeaders();
  assert.equal(http['X-Content-Type-Options'], 'nosniff');
  assert.equal(http['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(http['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(http['X-Frame-Options'], 'DENY');
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) assert.match(http['Permissions-Policy'], new RegExp(`${feature}=\\(\\)`));
  assert.equal(http['Strict-Transport-Security'], undefined);
  assert.match(fixedHeaders({ https: true })['Strict-Transport-Security'], /^max-age=\d{8}; includeSubDomains$/);
});

test('the upstream request carries the real secret, never the one the browser sent, and keeps cookies and the request id', () => {
  const incoming = new Headers({ cookie: '__Host-vm_session=abc', 'x-request-id': 'user-a-0000001', 'x-origin-secret': 'forged', 'content-type': 'application/json' });
  const out = upstreamHeaders(incoming, { secret: 'real-secret', host: '127.0.0.1:3000', proto: 'http' });
  assert.equal(out.get(ORIGIN_SECRET_HEADER), 'real-secret');
  assert.equal(out.get('cookie'), '__Host-vm_session=abc');
  assert.equal(out.get('x-request-id'), 'user-a-0000001');
  assert.equal(out.get('x-forwarded-host'), '127.0.0.1:3000');
  assert.equal(out.get('x-forwarded-proto'), 'http');
  assert.equal(incoming.get('x-origin-secret'), 'forged', 'the incoming headers are not changed');
  const none = upstreamHeaders(incoming, {});
  assert.equal(none.get(ORIGIN_SECRET_HEADER), null, 'without a configured secret a forged one is still dropped');
});

test('a client address the browser chose never reaches the API next to the real secret', () => {
  const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.7', forwarded: 'for=203.0.113.7', cookie: 'a=1' });
  const out = upstreamHeaders(incoming, { secret: 'real-secret' });
  for (const name of DROPPED_FROM_BROWSER) if (name !== ORIGIN_SECRET_HEADER) assert.equal(out.get(name), null, name);
  assert.equal(out.get('cookie'), 'a=1');
});

test('only /api/* is forwarded, to the same path and query on the API origin', () => {
  assert.equal(upstreamUrl('http://api:8000', '/api/v1/health').href, 'http://api:8000/api/v1/health');
  assert.equal(upstreamUrl('http://api:8000/', '/api/v1/challenges', '?limit=5').href, 'http://api:8000/api/v1/challenges?limit=5');
  assert.throws(() => upstreamUrl('http://api:8000', '/healthz'));
  assert.throws(() => upstreamUrl('http://api:8000/prefix', '/api/v1/health'));
  // a path cannot leave the API origin
  assert.equal(new URL(upstreamUrl('http://api:8000', '/api/..//evil.example/x').href).host, 'api:8000');
});

test('answers are never cached', () => {
  assert.equal(NO_STORE, 'private, no-store');
});
