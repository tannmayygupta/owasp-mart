import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DIR, FIXTURE_FILE } from './validate-domain-events.mjs';
import http from 'node:http';
import { HEARTBEAT_MS, createHub, loadRecords, main, readSse, run, waitForConnections } from './replay-domain-events.mjs';

const records = loadRecords();
const quiet = () => {
  const lines = [];
  return { lines, io: { log: (m) => lines.push(m), err: (m) => lines.push(m) } };
};

test('the committed fixtures replay cleanly: every check passes', async () => {
  const { lines, io } = quiet();
  assert.equal(await run(DEFAULT_DIR, io), 0, lines.join('\n'));
  assert.ok(lines.filter((l) => l.startsWith('PASS')).length >= 14);
  assert.ok(!lines.some((l) => l.startsWith('FAIL')));
});

test('a fixture that sends learner practice to a company makes the replay fail on the privacy wall', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'if3replay-'));
  fs.cpSync(DEFAULT_DIR, dir, { recursive: true });
  const f = path.join(dir, FIXTURE_FILE);
  const fx = JSON.parse(fs.readFileSync(f, 'utf8'));
  const i = fx.records.findIndex((r) => r.event.type === 'attempt.milestone_reached' && r.event.data.mode === 'learner');
  fx.records[i].audiences.push('org:ORG-ACME-1'); // a learner milestone also goes to the company
  fs.writeFileSync(f, JSON.stringify(fx));
  const { lines, io } = quiet();
  assert.equal(await run(dir, io), 1);
  assert.match(lines.join('\n'), /FAIL  privacy wall: .*a learner event reached an org/);
});

test('hub ids: same millisecond counts up, an earlier time is clamped, ids never go backwards', async () => {
  const hub = createHub();
  const e = (at) => ({ audiences: ['admin'], event: { ...records[0].event, occurred_at: at } });
  const ids = [hub.publish(e('2026-10-11T09:00:00Z')), hub.publish(e('2026-10-11T09:00:00Z')), hub.publish(e('2026-10-11T08:59:00Z')), hub.publish(e('2026-10-11T09:00:05Z'))];
  const ms = Date.parse('2026-10-11T09:00:00Z');
  assert.deepEqual(ids, [`${ms}-0`, `${ms}-1`, `${ms}-2`, `${ms + 5000}-0`]);
  await hub.close();
});

test('the hub answers 400 without audiences or with a malformed one, and 404 for another path', async () => {
  const hub = createHub();
  const base = await hub.listen();
  try {
    assert.equal((await fetch(`${base}/live?close=1`)).status, 400);
    assert.equal((await fetch(`${base}/live?close=1`, { headers: { 'x-test-audiences': 'user:a b' } })).status, 400);
    assert.equal((await fetch(`${base}/other`, { headers: { 'x-test-audiences': 'admin' } })).status, 404);
    const ok = await fetch(`${base}/live?close=1`, { headers: { 'x-test-audiences': 'admin' } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/event-stream/);
    assert.match(ok.headers.get('cache-control'), /no-store/);
    assert.equal(ok.headers.get('x-accel-buffering'), 'no');
  } finally { await hub.close(); }
});

test('the consumer ignores heartbeat comments and waits for the connection instead of sleeping', async () => {
  const hub = createHub({ heartbeatMs: 10 });
  const base = await hub.listen();
  try {
    const pending = readSse(base, { audiences: ['admin'], close: false, maxEvents: 1, maxMs: 3000 });
    await waitForConnections(hub, 1);
    await new Promise((r) => setTimeout(r, 40));
    hub.publish(records[0]);
    const got = await pending;
    assert.equal(got.events.length, 1);
    assert.ok(got.comments >= 1);
    assert.equal(got.events[0].event, 'instance.state_changed');
  } finally { await hub.close(); }
});

test('a buffer that trims keeps only the newest events and replays them for a valid id', async () => {
  const hub = createHub({ buffer: 3 });
  const ids = records.slice(0, 6).map((r) => hub.publish({ audiences: ['admin'], event: r.event }));
  const base = await hub.listen();
  try {
    const all = await readSse(base, { audiences: ['admin'] });
    assert.deepEqual(all.events.map((e) => e.id), ids.slice(3));
    const old = await readSse(base, { audiences: ['admin'], lastEventId: ids[0] });
    assert.deepEqual(old.events.map((e) => e.event), ['stream.resync']);
    const edge = await readSse(base, { audiences: ['admin'], lastEventId: ids[2] });
    assert.deepEqual(edge.events.map((e) => e.id), ids.slice(3));
  } finally { await hub.close(); }
});

test('CLI: --help exits 0, an unknown argument 2, --dir without a value 2, a folder without fixtures 1, the real contract 0', async () => {
  const { io } = quiet();
  assert.equal(await main(['--help'], io), 0);
  assert.equal(await main(['--nope'], io), 2);
  assert.equal(await main(['--dir'], io), 2);
  assert.equal(await main(['--dir', os.tmpdir()], io), 1);
  assert.equal(await main([], io), 0);
});

test('the default heartbeat is 15 seconds (FR-LIV-02)', () => {
  assert.equal(HEARTBEAT_MS, 15000);
});

test('publish refuses a time that is not real; ids stay valid', async () => {
  const hub = createHub();
  const bad = { audiences: ['admin'], event: { ...records[0].event, occurred_at: '2026-13-45T99:99:99Z' } };
  assert.throws(() => hub.publish(bad), /not a real UTC time/);
  await hub.close();
});

test('a reset gives buffer_reset to an older id, replays for the barrier id, and ends the connection', async () => {
  const hub = createHub();
  const ids = records.slice(0, 4).map((r) => hub.publish(r));
  const base = await hub.listen();
  try {
    hub.reset();
    const old = await readSse(base, { audiences: ['user:USR-LEARNER-1'], lastEventId: ids[0], close: false, maxMs: 3000 });
    assert.deepEqual(old.events.map((e) => e.data.data.reason), ['buffer_reset']);
    assert.equal(hub.connections(), 0);
    const barrier = await readSse(base, { audiences: ['user:USR-LEARNER-1'], lastEventId: ids[3] });
    assert.deepEqual(barrier.events, []);
  } finally { await hub.close(); }
});

test('a stalled hub is an error, not an empty answer', async () => {
  const stall = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); });
  await new Promise((r) => stall.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${stall.address().port}`;
  try {
    await assert.rejects(readSse(base, { audiences: ['admin'], maxMs: 150 }), /timed out/);
    await assert.rejects(readSse(base, { audiences: ['admin'], close: false, maxEvents: 1, maxMs: 150 }), /timed out/);
    const observed = await readSse(base, { audiences: ['admin'], close: false, maxMs: 100 }); // an open observation window is not an error
    assert.deepEqual(observed.events, []);
  } finally { stall.closeAllConnections?.(); await new Promise((r) => stall.close(r)); }
});

test('the consumer parses CRLF frames, skips frames without data, and stops at maxEvents', async () => {
  const body = [
    'id: 7\r\n\r\n', // a frame with only an id
    ': heartbeat\r\n\r\n',
    'id: 8-0\r\nevent: a\r\ndata: {"n":1}\r\n\r\n',
    'id: 9-0\r\nevent: b\r\ndata: {"n":\r\ndata: 2}\r\n\r\n', // a multi-line data field
    'id: 10-0\r\nevent: c\r\ndata: {"n":3}\r\n\r\n',
  ].join('');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const all = await readSse(base, { audiences: ['admin'] });
    assert.deepEqual(all.events.map((e) => [e.id, e.event, e.data.n]), [['8-0', 'a', 1], ['9-0', 'b', 2], ['10-0', 'c', 3]]);
    assert.equal(all.comments, 1);
    const two = await readSse(base, { audiences: ['admin'], maxEvents: 2 });
    assert.equal(two.events.length, 2);
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
});

test('a fresh connection without replay=all sees nothing of the buffer', async () => {
  const hub = createHub();
  records.slice(0, 3).forEach((r) => hub.publish(r));
  const base = await hub.listen();
  try {
    const got = await readSse(base, { audiences: ['user:USR-LEARNER-1'], replayAll: false });
    assert.deepEqual(got.events, []);
    const all = await readSse(base, { audiences: ['user:USR-LEARNER-1'] });
    assert.ok(all.events.length > 0);
  } finally { await hub.close(); }
});
