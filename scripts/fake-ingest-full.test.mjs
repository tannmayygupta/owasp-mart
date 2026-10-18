// Story 6.4: the test-only route GET /_fake/events/full of the fake ingest (a mock of stream L, not part of IF-4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../contracts/mocks/fake-ingest/server.mjs';
import { signEvent, TEST_KEY, TEST_INSTANCE } from '../contracts/mocks/fake-ingest/sign.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALID_DIR = path.join(ROOT, 'contracts', 'events', 'examples', 'valid', 'instance-events');
const example = (type) => JSON.parse(fs.readFileSync(path.join(VALID_DIR, `${type}.json`), 'utf8'));

test('GET /_fake/events/full returns the stored wire events with arrival time, ordered by (epoch, seq)', async () => {
  const { server, port } = await startServer({ key: TEST_KEY, port: 0, log() {} });
  try {
    const base = `http://127.0.0.1:${port}`;
    const empty = await fetch(`${base}/_fake/events/full`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), []);

    const a = example('proxy.request');
    const b = { ...example('proxy.crs_match'), seq: a.seq + 5 };
    const early = { ...a, seq: a.seq + 2 };
    for (const ev of [b, a, early]) {
      const s = signEvent(TEST_KEY, ev);
      assert.equal((await fetch(`${base}/internal/v1/events`, { method: 'POST', headers: s.headers, body: s.body })).status, 202);
    }
    const res = await fetch(`${base}/_fake/events/full`);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const rows = await res.json();
    assert.deepEqual(rows.map((r) => r.event.seq), [a.seq, a.seq + 2, a.seq + 5]);
    assert.equal(rows[0].event.instance_id, TEST_INSTANCE);
    assert.equal(rows[0].event.type, 'proxy.request');
    assert.ok(rows.every((r) => !Number.isNaN(Date.parse(r.received_at))));
    // the short list is unchanged
    const short = await (await fetch(`${base}/_fake/events`)).json();
    assert.deepEqual(short.map((r) => r.seq), [a.seq, a.seq + 2, a.seq + 5]);
    assert.deepEqual(Object.keys(short[0]).sort(), ['epoch', 'instance_id', 'seq', 'type']);
    // other methods and the path with a suffix stay unknown
    assert.equal((await fetch(`${base}/_fake/events/full`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/_fake/events/fullx`)).status, 404);
  } finally {
    server.close();
  }
});
