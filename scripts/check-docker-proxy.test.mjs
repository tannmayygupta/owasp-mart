// Tests of the proxy conformance script. The rows are checked against a small HTTP server that applies the SAME allow-list shape as infra/compose/docker-proxy/rules.cfg
// (the real proof against the real HAProxy container is the local run recorded in the dev-log of work package C and the vm-i run of runbook Part E).
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { ROWS, checkListeners, checkProxy } from './check-docker-proxy.mjs';

const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const allowed = (m, p) => (m === 'GET' && /^(\/v[0-9.]+)?\/(_ping|version|containers\/json|networks|volumes|containers\/vm-[\w.-]+\/json)$/.test(p.split('?')[0]));

test('a proxy that allows exactly the reads passes every row', async () => {
  const s = await serve((req, res) => { res.statusCode = allowed(req.method, req.url) ? 200 : 403; res.end(); });
  try { assert.deepEqual(await checkProxy(urlOf(s)), []); } finally { s.close(); }
});

test('a proxy that lets a build through is caught, and so is one that refuses a read', async () => {
  const open = await serve((req, res) => { res.statusCode = allowed(req.method, req.url) || req.url === '/build' ? 200 : 403; res.end(); });
  const shut = await serve((req, res) => { res.statusCode = 403; res.end(); });
  try {
    const a = await checkProxy(urlOf(open));
    assert.equal(a.length, 1);
    assert.match(a[0], /POST \/build: expected 403/);
    const b = await checkProxy(urlOf(shut));
    assert.ok(b.some((f) => /GET \/_ping: refused/.test(f)));
  } finally { open.close(); shut.close(); }
});

test('no answer is a failure, not a pass', async () => {
  const fails = await checkProxy('http://127.0.0.1:1', [['GET', '/_ping', 'allow']]);
  assert.equal(fails.length, 1);
  assert.match(fails[0], /no answer/);
});

test('the rows hold both kinds, and only vm-* style names appear in the allowed ones', () => {
  assert.ok(ROWS.some((r) => r[2] === 'allow') && ROWS.filter((r) => r[2] === 'deny').length > 20);
  for (const [, p, e] of ROWS) if (e === 'allow' && /\/containers\/[^/]+\/json/.test(p)) assert.match(p, /vm-conformance-none/);
});

test('ss output: loopback only passes; any other bind fails with the address removed', () => {
  const ok = 'LISTEN 0 4096 127.0.0.1:2375 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:443 0.0.0.0:*';
  assert.deepEqual(checkListeners(ok), []);
  const bad = checkListeners('LISTEN 0 4096 10.1.2.3:2375 0.0.0.0:*');
  assert.equal(bad.length, 1);
  assert.doesNotMatch(bad[0], /10\.1\.2\.3/);
  assert.equal(checkListeners('LISTEN 0 4096 127.0.0.1:443 0.0.0.0:*').length, 1);
});
