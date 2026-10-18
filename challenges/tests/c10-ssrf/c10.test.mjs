// C10 self-test: the importer reaches the internal metadata service via a
// variant-form loopback address and leaks the flag on the vulnerable build; on
// the fixed build the resolved loopback IP is refused. Also: a non-http scheme is
// rejected on both builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { importImageFromUrl } from '../../../apps/shop/src/challenges/c10-ssrf-import.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C10-METADATA-FLAG-MARKER';

// A fake internal metadata service on loopback; /latest/user-data holds the flag.
function startMeta() {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url === '/latest/user-data' ? `instance bootstrap data; ${MARKER}` : 'ok');
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port })));
}

async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C10: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events };
}

test('C10 exploit PASSES on the vulnerable build (string-blocklist bypass reaches metadata)', async () => {
  const meta = await startMeta();
  const prev = process.env.VM_C10_TARGET;
  process.env.VM_C10_TARGET = `http://2130706433:${meta.port}/latest/user-data`; // decimal 127.0.0.1
  const { server, baseUrl, events } = await bootShop('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'c10', test: exploit, timeoutMs: 15000 });
    assert.equal(r.passed, true, r.detail);
    assert.ok(events.some((e) => e.type === 'importer.fetch_attempt' && e.data.url_class === 'loopback'), 'expected importer.fetch_attempt loopback');
  } finally {
    server.close(); meta.server.close();
    if (prev === undefined) delete process.env.VM_C10_TARGET; else process.env.VM_C10_TARGET = prev;
  }
});

test('C10 exploit FAILS on the fixed build (resolved loopback IP is refused)', async () => {
  const meta = await startMeta();
  const prev = process.env.VM_C10_TARGET;
  process.env.VM_C10_TARGET = `http://2130706433:${meta.port}/latest/user-data`;
  const { server, baseUrl } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c10', test: exploit, timeoutMs: 15000 });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build blocks the resolved loopback address (clean fail)');
  } finally {
    server.close(); meta.server.close();
    if (prev === undefined) delete process.env.VM_C10_TARGET; else process.env.VM_C10_TARGET = prev;
  }
});

test('a non-http scheme is rejected on both builds', async () => {
  for (const mode of ['vulnerable', 'fixed']) {
    await assert.rejects(() => importImageFromUrl('file:///etc/passwd', { challenges: { C10: mode } }), /http and https/);
    await assert.rejects(() => importImageFromUrl('gopher://x/1', { challenges: { C10: mode } }), /http and https/);
  }
});
