// Entry point: a bad start document ends with exit code 2, a fixed message and no listener; a good one starts both ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { main } from '../src/main.mjs';
import { freshValues, startDoc, postedEvent, request, freePort } from './helpers.mjs';

function capture(fn) {
  const err = console.error; const log = console.log; const lines = [];
  console.error = (...a) => lines.push(a.join(' ')); console.log = (...a) => lines.push(a.join(' '));
  return fn().finally(() => { console.error = err; console.log = log; }).then((r) => ({ r, lines }));
}

test('bad start document: exit 2, the fixed message, no listener is started, nothing of the document is printed', async () => {
  const v = freshValues();
  let made = 0;
  const deps = { createSidecar: () => { made += 1; throw new Error('must not be built'); } };
  for (const bad of ['', '{', JSON.stringify({ ...startDoc(v), extra: 1 }), JSON.stringify({ schema_version: '0.1' }), JSON.stringify({ ...startDoc(v), event_key: undefined })]) {
    const { r, lines } = await capture(() => main(['--relay', 'http://x:1/y'], {}, { stdin: Readable.from([bad]), deps }));
    assert.equal(r, 2);
    assert.deepEqual(lines, ['sidecar: bad start document']);
  }
  assert.equal(made, 0);
  const { r, lines } = await capture(() => main(['--relay'], {}, { stdin: Readable.from(['']), deps }));
  assert.equal(r, 2);
  assert.match(lines[0], /bad argument/);
});

test('a good start document starts both ports; the word "sidecar" in front of the flags is accepted; the log line holds no key or digest', async () => {
  const v = freshValues();
  const eventsPort = await freePort(); const playerPort = await freePort();
  let sc;
  const { createSidecar } = await import('../src/sidecar.mjs');
  const wrapped = { createSidecar: (o) => { sc = createSidecar({ ...o, relayUrl: 'http://127.0.0.1:1/x', statePath: null, outboxPath: null }); return sc; } };
  const { r, lines } = await capture(() => main(['sidecar', '--relay', 'http://127.0.0.1:1/x', '--upstream', 'http://127.0.0.1:1', '--events-port', String(eventsPort), '--player-port', String(playerPort)], {}, { stdin: Readable.from([JSON.stringify(startDoc(v))]), deps: wrapped }));
  try {
    assert.equal(r, null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^sidecar: listening on \d+ and \d+, epoch 1, next seq 1$/);
    assert.ok(!lines[0].includes(v.event_key));
    assert.equal((await request(eventsPort, { method: 'POST', path: '/v1/events', headers: { 'content-type': 'application/json' }, body: JSON.stringify(postedEvent()) })).status, 202);
  } finally { await sc.stop(); }
});
