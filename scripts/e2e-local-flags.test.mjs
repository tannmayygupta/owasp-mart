import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { CHALLENGES, newFlag, recordingFetch } from './e2e-local-flags.mjs';

test('a made flag has the platform format and two made flags differ', () => {
  const a = newFlag(); const b = newFlag();
  assert.match(a, /^VM\{[A-Z2-7]{24}\}$/);
  assert.notEqual(a, b);
});

test('the recording fetch remembers flag-shaped values of a response and hands the response on unchanged', async () => {
  const flag = newFlag();
  const server = await new Promise((resolve) => { const s = http.createServer((_, res) => res.end(`note ${flag} and VM{short}`)); s.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const found = new Set();
    const res = await recordingFetch(found)(`http://127.0.0.1:${server.address().port}/`);
    assert.match(await res.text(), /note VM\{/, 'the body is still readable by the exploit');
    assert.deepEqual([...found], [flag], 'only the well-formed flag is kept');
  } finally { server.close(); }
});

test('all eleven challenges are in the run', () => {
  assert.deepEqual(Object.keys(CHALLENGES), ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11']);
});
