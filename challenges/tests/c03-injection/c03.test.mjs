// C03 self-test (both parts): the part-A UNION injection and the part-B stored
// XSS both HOLD on the vulnerable build and FAIL on the fixed build. Part A runs
// against the separate catalog store; part B against the support console render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploitA from './exploit-a-sqli.mjs';
import exploitB from './exploit-b-stored-xss.mjs';

async function bootShop(modes) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: modes });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events };
}

test('C03A UNION injection PASSES on the vulnerable build, FAILS on the fixed build', async () => {
  const v = await bootShop({ C03A: 'vulnerable' });
  try {
    assert.equal((await runExploit({ baseUrl: v.baseUrl, name: 'c03a', test: exploitA })).passed, true);
  } finally { v.server.close(); }
  const f = await bootShop({ C03A: 'fixed' });
  try {
    const r = await runExploit({ baseUrl: f.baseUrl, name: 'c03a', test: exploitA });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build is a clean fail');
  } finally { f.server.close(); }
});

test('C03A: a malformed search on the vulnerable build emits shop.catalog_query_error', async () => {
  const v = await bootShop({ C03A: 'vulnerable' });
  try {
    await fetch(`${v.baseUrl}/api/products/search?q=${encodeURIComponent("'")}`);
    assert.ok(v.events.some((e) => e.type === 'shop.catalog_query_error'), 'expected a SQL-error event');
  } finally { v.server.close(); }
});

test('C03B stored XSS PASSES on the vulnerable build, FAILS on the fixed build', async () => {
  const v = await bootShop({ C03B: 'vulnerable' });
  try {
    assert.equal((await runExploit({ baseUrl: v.baseUrl, name: 'c03b', test: exploitB })).passed, true);
    assert.ok(v.events.some((e) => e.type === 'shop.ticket_markup_stored'), 'expected the markup-stored event');
  } finally { v.server.close(); }
  const f = await bootShop({ C03B: 'fixed' });
  try {
    const r = await runExploit({ baseUrl: f.baseUrl, name: 'c03b', test: exploitB });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build escapes the markup');
  } finally { f.server.close(); }
});
