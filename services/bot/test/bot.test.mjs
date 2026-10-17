// Support-agent bot controller tests (T-13, FR-SHP-11): it visits only its own
// instance's allow-listed pages, refuses everything else, bounds each visit, and
// reports its memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, createBotController } from '../src/controller.mjs';

const TARGET = 'http://shop.test:3000';

// A fake visitor so the tests do no real network; it records how it was called.
function fakeVisitor() {
  const calls = [];
  const visit = async (href, opts) => { calls.push({ href, opts }); return { ok: true, status: 200 }; };
  return { visit, calls };
}
async function withBot(opts, fn) {
  const { server, visits } = createBotController(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, visits); } finally { server.close(); }
}
const visit = (base, path) => fetch(`${base}/visit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });

test('isAllowed: same instance + allow-listed prefix only', () => {
  const origin = new URL(TARGET).origin;
  assert.equal(isAllowed(origin, new URL('/tickets/5', TARGET), ['/tickets/']), true);
  assert.equal(isAllowed(origin, new URL('/admin', TARGET), ['/tickets/']), false); // not allow-listed
  assert.equal(isAllowed(origin, new URL('http://evil.com/tickets/5'), ['/tickets/']), false); // other origin
});

test('visits an allowed page of its own instance, time-bounded', async () => {
  const { visit: v, calls } = fakeVisitor();
  await withBot({ target: TARGET, allowPrefixes: ['/tickets/'], maxVisitMs: 1234, visit: v }, async (base, visits) => {
    const r = await visit(base, '/tickets/5');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.visited, true);
    assert.equal(body.path, '/tickets/5');
    assert.equal(body.status, 200);
    assert.equal(visits.length, 1);
    // The visit was bounded by maxVisitMs.
    assert.equal(calls[0].href, 'http://shop.test:3000/tickets/5');
    assert.equal(calls[0].opts.timeoutMs, 1234);
  });
});

test('refuses pages outside its instance or outside the allow-list', async () => {
  const { visit: v } = fakeVisitor();
  await withBot({ target: TARGET, allowPrefixes: ['/tickets/'], visit: v }, async (base, visits) => {
    for (const bad of ['/admin', 'http://evil.com/tickets/5', '//evil.com/tickets/5', '/staff/users']) {
      const r = await visit(base, bad);
      assert.equal(r.status, 403, `must refuse ${bad}`);
      assert.equal((await r.json()).refused, true);
    }
    assert.equal(visits.length, 0, 'no refused page was visited');
  });
});

test('a prefix without a trailing slash does not over-match a sibling path', async () => {
  const origin = new URL(TARGET).origin;
  // /staff/tickets must allow itself and anything under it, but NOT /staff/ticketsX.
  assert.equal(isAllowed(origin, new URL('/staff/tickets', TARGET), ['/staff/tickets']), true);
  assert.equal(isAllowed(origin, new URL('/staff/tickets/5', TARGET), ['/staff/tickets']), true);
  assert.equal(isAllowed(origin, new URL('/staff/ticketsX', TARGET), ['/staff/tickets']), false);
  assert.equal(isAllowed(origin, new URL('/staff/tickets-secret', TARGET), ['/staff/tickets']), false);
  // And over the wire.
  const { visit: v } = fakeVisitor();
  await withBot({ target: TARGET, allowPrefixes: ['/staff/tickets'], visit: v }, async (base) => {
    assert.equal((await visit(base, '/staff/ticketsX')).status, 403);
    assert.equal((await visit(base, '/staff/tickets/5')).status, 200);
  });
});

test('a redirect off the allowed page is NOT followed (manual redirect)', async () => {
  const http = await import('node:http');
  const target = http.createServer((_req, res) => { res.writeHead(302, { location: 'http://evil.invalid/' }); res.end(); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetUrl = `http://127.0.0.1:${target.address().port}`;
  try {
    await withBot({ target: targetUrl, allowPrefixes: ['/tickets/'], maxVisitMs: 2000 }, async (base) => {
      const body = await (await visit(base, '/tickets/9')).json();
      assert.equal(body.visited, true);
      assert.equal(body.status, 302, 'the redirect is returned, not followed to another origin');
    });
  } finally { target.close(); }
});

test('bad input is refused with 400', async () => {
  const { visit: v } = fakeVisitor();
  await withBot({ target: TARGET, visit: v }, async (base) => {
    assert.equal((await visit(base, undefined)).status, 400);
    assert.equal((await fetch(`${base}/visit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
  });
});

test('/healthz and /stats report liveness and memory per instance', async () => {
  const { visit: v } = fakeVisitor();
  await withBot({ target: TARGET, allowPrefixes: ['/tickets/'], visit: v }, async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    await visit(base, '/tickets/1');
    const stats = await (await fetch(`${base}/stats`)).json();
    assert.equal(stats.visits, 1);
    assert.ok(Number.isInteger(stats.memory.rss) && stats.memory.rss > 0, 'reports rss memory');
    assert.ok(Number.isInteger(stats.memory.heapUsed), 'reports heapUsed');
  });
});

test('the default HTTP visitor bounds a hung target by the timeout', async () => {
  // A target that accepts but never responds; the visit must return promptly.
  const http = await import('node:http');
  const hung = http.createServer(() => { /* never responds */ });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${hung.address().port}`;
  try {
    await withBot({ target, allowPrefixes: ['/tickets/'], maxVisitMs: 300 }, async (base) => {
      const start = Date.now();
      const body = await (await visit(base, '/tickets/9')).json();
      assert.equal(body.visited, true);
      assert.equal(body.status, 0, 'a hung page yields status 0 (aborted), not a hang');
      assert.ok(Date.now() - start < 3000, 'the visit returns promptly via the timeout');
    });
  } finally { hung.close(); }
});
