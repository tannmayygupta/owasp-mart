import assert from 'node:assert/strict';
import test from 'node:test';
import { redactInspect, SECTIONS, splitSections } from './live-audit.mjs';

const remote = SECTIONS.map((n) => `\n=====${n}=====\n${n === 'inspect.json' ? '[]' : `content of ${n}`}\n`).join('');

test('the remote output is split at its markers and every section must be present', () => {
  const s = splitSections(remote);
  assert.equal(s['ss.txt'].trim(), 'content of ss.txt');
  assert.deepEqual(Object.keys(s).sort(), [...SECTIONS].sort());
  assert.throws(() => splitSections(remote.replace('=====ss.txt=====', '=====other=====')), /no ss\.txt/);
  assert.throws(() => splitSections(remote.replace('content of daemon.json', '')), /no daemon\.json/);
});

test('inspect output keeps the names of the environment variables but never their values, and hides addresses except loopback', () => {
  const raw = JSON.stringify([[{ Name: '/x', Config: { Env: ['SECRET_FILE=/run/secrets/a', 'TOKEN=abc'], Cmd: ['connect(9200,"127.0.0.1")'] }, NetworkSettings: { IPAddress: '172.30.4.2' } }]]);
  const out = redactInspect(raw);
  assert.ok(!out.includes('/run/secrets/a') && !out.includes('abc') && !out.includes('172.30.4.2'));
  assert.ok(out.includes('SECRET_FILE=<redacted>') && out.includes('127.0.0.1') && out.includes('<addr>'));
  assert.equal(JSON.parse(out).length, 1, 'nested arrays are flattened into the list the audit reads');
});