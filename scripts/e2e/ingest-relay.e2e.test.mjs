// End-to-end proof of story edge-4: the REAL Node relay (apps/edge/src/relay.mjs) forwards sidecar-signed events to the REAL Python ingest
// route (apps/api, uvicorn on loopback). No Docker. Events are signed like the stub sidecar does (contracts/mocks/fake-ingest/sign.mjs and
// event-key.mjs, with the FAKE master of the written key vector). The ingest keeps events in memory behind a port (P-06 owns the table).
// Run: node --test scripts/e2e/ingest-relay.e2e.test.mjs   (needs uv and the locked api environment; skipped with a message without uv)
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../apps/edge/src/relay.mjs';
import { signEvent } from '../../contracts/mocks/fake-ingest/sign.mjs';
import { deriveEventKey } from '../../contracts/mocks/fake-ingest/event-key.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VECTOR = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'events', 'examples', 'event-key-vector.json'), 'utf8'));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'events', 'examples', 'valid', 'instance-events', 'proxy.flag_seen.json'), 'utf8'));
const A = 'i-AAAAAAAAAAAAAAAA';
const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
const skip = uv.status === 0 ? false : 'uv is not installed: the ingest cannot be started';

const PY = `
import sys
from datetime import UTC, datetime
import uvicorn
from fastapi import FastAPI
from vulnmart.ingest.handler import IngestHandler
from vulnmart.ingest.route import install_event_route
from vulnmart.ingest.store import MemoryEventStore, MemoryInstanceEpochs
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.problem import install_problem_handlers
port, master_hex = int(sys.argv[1]), sys.argv[2]
epochs, store = MemoryInstanceEpochs({"${A}": 1}), MemoryEventStore()
app = FastAPI()
install_problem_handlers(app)
install_event_route(app, IngestHandler(keys=FakeKeyPort(event_master=bytes.fromhex(master_hex)), epochs=epochs, store=store,
                                       now=lambda: datetime.now(UTC)))
@app.get("/_test/stored")
def stored():
    return [{"instance_id": i, "epoch": e, "seq": s} for i, e, s in store.triples()]
@app.post("/_test/epoch/{iid}/{epoch}")
def set_epoch(iid: str, epoch: int):
    epochs.set(iid, epoch)
    return {"ok": True}
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
`;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});
const req = (port, { method = 'POST', p = '/internal/v1/events', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});
const json = (r) => JSON.parse(r.text || 'null');

let proc; let relay; let ingestPort; let relayPort; let tmp; let output = '';
const key = (epoch) => deriveEventKey(VECTOR.master_hex, A, epoch);
const event = (o = {}) => ({ ...EXAMPLE, ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ...o });
const post = (e, k = key(e.epoch)) => { const { body, headers } = signEvent(k, e); return req(relayPort, { headers, body }); };
const stored = async () => json(await req(ingestPort, { method: 'GET', p: '/_test/stored' }));

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-ingest-e2e-'));
  const script = path.join(tmp, 'ingest_app.py');
  fs.writeFileSync(script, PY);
  ingestPort = await freePort();
  proc = spawn('uv', ['run', '--locked', '--package', 'vulnmart-api', 'python', script, String(ingestPort), VECTOR.master_hex], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => { output += d; });
  const t0 = Date.now();
  for (;;) {
    try { await req(ingestPort, { method: 'GET', p: '/_test/stored' }); break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 90000) throw new Error(`the ingest did not start: ${output.slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  relay = createRelay({ ingestUrl: `http://127.0.0.1:${ingestPort}`, rateMax: 10000 });
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  relayPort = relay.server.address().port;
});
after(async () => {
  if (relay) { relay.server.closeAllConnections(); relay.server.close(); }
  if (proc) proc.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a sidecar-signed event through the relay is accepted once and stored as (instance, epoch, seq)', { skip }, async () => {
  const r = await post(event({ seq: 3 }));
  assert.equal(r.status, 202);
  assert.deepEqual(json(r), { status: 'accepted' });
  assert.deepEqual(await stored(), [{ instance_id: A, epoch: 1, seq: 3 }]);
});

test('a replay is 200 and stays one row; the same triple with another body is 409 EVT-DUPLICATE-MISMATCH', { skip }, async () => {
  const r = await post(event({ seq: 3 }));
  assert.equal(r.status, 200);
  assert.equal((await stored()).length, 1);
  const other = await post(event({ seq: 3, user_id: 'u-2002' }));
  assert.equal(other.status, 409);
  assert.deepEqual(json(other), { code: 'EVT-DUPLICATE-MISMATCH' });
  assert.equal((await stored()).length, 1);
});

test('forged, tampered and foreign-epoch events are 401 and not stored; the answer holds a code and nothing else', { skip }, async () => {
  const e = event({ seq: 10 });
  const forged = await post(e, 'FAKE-WRONG-KEY-NOT-REAL-000000000000000');
  assert.equal(forged.status, 401);
  assert.deepEqual(json(forged), { code: 'EVT-BAD-SIGNATURE' });
  const { headers } = signEvent(key(1), e);
  const tampered = await req(relayPort, { headers, body: JSON.stringify({ ...e, user_id: 'u-9' }) });
  assert.equal(tampered.status, 401);
  assert.equal((await post(event({ seq: 11, epoch: 2 }))).status, 401, 'an epoch the platform has not started');
  assert.equal((await post(event({ seq: 12, epoch: 2 }), key(1))).status, 401, 'signed with the key of another epoch');
  assert.equal((await stored()).length, 1);
});

test('a stale epoch is late history (accepted under its own epoch); a new current epoch accepts new events', { skip }, async () => {
  await req(ingestPort, { p: `/_test/epoch/${A}/2` });
  assert.equal((await post(event({ seq: 20, epoch: 1 }))).status, 202);
  assert.equal((await post(event({ seq: 1, epoch: 2 }))).status, 202);
  const rows = await stored();
  assert.ok(rows.some((x) => x.epoch === 1 && x.seq === 20) && rows.some((x) => x.epoch === 2 && x.seq === 1));
});

test('oversize and many events are refused at the relay and never stored; an oversize body is cut off', { skip }, async () => {
  const before = (await stored()).length;
  const big = event({ seq: 30 });
  const { headers } = signEvent(key(1), big);
  const over = await req(relayPort, { headers, body: JSON.stringify({ ...big, pad: 'x'.repeat(17000) }) });
  assert.equal(over.status, 413);
  const many = await req(relayPort, { headers, body: JSON.stringify([event({ seq: 31 }), event({ seq: 32 })]) });
  assert.equal(many.status, 422);
  // direct to the ingest: 413 for a declared and a chunked oversize body, 422 for an array
  assert.equal((await req(ingestPort, { headers: { 'content-type': 'application/json' }, body: 'x'.repeat(17000) })).status, 413);
  assert.equal((await req(ingestPort, { headers: { ...headers }, body: JSON.stringify([event({ seq: 33 })]) })).status, 422);
  assert.equal((await stored()).length, before);
});

test('a bad ts reaches the ingest and is 422 with only a code to the instance side', { skip }, async () => {
  const r = await post(event({ seq: 40, ts: new Date(Date.now() + 11 * 60000).toISOString().replace(/\.\d+Z$/, 'Z') }));
  assert.equal(r.status, 422);
  assert.deepEqual(json(r), { code: 'EVT-SCHEMA' });
});
