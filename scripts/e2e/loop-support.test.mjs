// Pure tests of scripts/e2e/loop-support.mjs (story 8.3). No Docker, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findLeftovers, hostOf, isInstanceId, labelFilter, leftoverText, lines, loopManifest, loopTemplate, orchSign, parseMemMiB, pollUntil, redactAll, runLabels, tailRedacted, newRunId } from './loop-support.mjs';

test('labels carry the kind and the run id; a bad id is refused', () => {
  assert.deepEqual(runLabels('vmloopabc123'), ['--label', 'vm.kind=loop-test', '--label', 'vm.run=vmloopabc123']);
  assert.throws(() => runLabels('Bad Id; rm'));
  assert.match(newRunId(), /^vmloop[0-9a-f]{6}$/);
});

test('label filter: one run, or the whole kind', () => {
  assert.deepEqual(labelFilter('vmloopabc123'), ['--filter', 'label=vm.run=vmloopabc123']);
  assert.deepEqual(labelFilter(null), ['--filter', 'label=vm.kind=loop-test']);
});

test('leftover finder counts unique non-blank lines', () => {
  assert.deepEqual(lines('a\r\n\r\nb\na\n'), ['a', 'b']);
  const none = findLeftovers({ containers: '\n', networks: '', volumes: undefined });
  assert.equal(none.total, 0);
  const some = findLeftovers({ containers: 'c1\nc2', networks: 'n1', volumes: '' });
  assert.equal(some.total, 3);
  assert.equal(leftoverText(some), 'containers 2, networks 1, volumes 0');
});

test('bounded poll: returns the value, retries a throwing check, and times out with the label', async () => {
  let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
  let n = 0;
  assert.equal(await pollUntil(() => { n += 1; if (n < 3) throw new Error('not yet'); return 'ok'; }, { timeoutMs: 5000, intervalMs: 100, sleep, now }), 'ok');
  await assert.rejects(() => pollUntil(() => false, { timeoutMs: 1000, intervalMs: 300, label: 'the event', sleep, now }), /timeout after 1000 ms waiting for the event/);
  await assert.rejects(() => pollUntil(() => { throw new Error('boom'); }, { timeoutMs: 100, intervalMs: 50, sleep, now }), /last: boom/);
});

test('redaction: flags, long hex, addresses, tokens, tickets, cookies and given secrets never survive', () => {
  const secret = 'my-demo-token-value';
  const text = `flag VM{ABCDEF} key ${'a'.repeat(64)} at 10.1.2.3 X-Lab-Demo-Token: ${secret} GET /_vm/enter?t=abc.def __Host-vm_gate=zzz; other ${secret}`;
  const out = redactAll(text, [secret]);
  for (const bad of ['VM{ABCDEF}', 'a'.repeat(64), '10.1.2.3', secret, 'abc.def', 'zzz']) assert.ok(!out.includes(bad), `${bad} is still in: ${out}`);
  assert.match(out, /<flag>/);
  assert.match(tailRedacted('l1\nl2\nl3\nVM{X}', 2), /l3 \| <flag>/);
});

test('orchestrator signature: fixed shape and it changes with every input', () => {
  const a = orchSign('k'.repeat(40), 'POST', '/v1/instances', '2026-10-17T10:00:00Z', 'n1', '{}');
  assert.match(a, /^v1=[0-9a-f]{64}$/);
  assert.notEqual(a, orchSign('k'.repeat(40), 'POST', '/v1/instances', '2026-10-17T10:00:00Z', 'n2', '{}'));
  assert.notEqual(a, orchSign('k'.repeat(40), 'GET', '/v1/instances', '2026-10-17T10:00:00Z', 'n1', '{}'));
  assert.notEqual(a, orchSign('k'.repeat(40), 'POST', '/v1/instances', '2026-10-17T10:00:00Z', 'n1', '{ }'));
});

test('manifest and template of the loop: sidecar in, other roles out, relay in the sidecar command', () => {
  const m = loopManifest({ stubId: 'sha256:' + '1'.repeat(64), relayUrl: 'http://edge:8081/internal/v1/events' });
  assert.equal(m.images.sidecar, m.images.shop);
  assert.deepEqual(m.commands.sidecar.slice(0, 3), ['sidecar', '--relay', 'http://edge:8081/internal/v1/events']);
  assert.deepEqual(m.commands.shop, ['shop']);
  const t = loopTemplate({ components: [{ role: 'shop' }, { role: 'sidecar' }, { role: 'injector' }, { role: 'mock-services' }, { role: 'bot-controller' }] });
  assert.deepEqual(t.components.map((c) => c.role), ['shop', 'sidecar', 'injector']);
});

test('memory text parser and id helpers', () => {
  assert.equal(parseMemMiB('12.5MiB / 256MiB'), 12.5);
  assert.equal(parseMemMiB('2048KiB / 1GiB'), 2);
  assert.equal(parseMemMiB('1GiB / 2GiB'), 1024);
  assert.equal(parseMemMiB('nonsense'), null);
  assert.ok(isInstanceId('i-ABCDEFGHIJKLMNOP'));
  assert.ok(!isInstanceId('i-abc'));
  assert.equal(hostOf('i-ABCDEFGHIJKLMNOP', 'labs.test'), 'i-abcdefghijklmnop.labs.test');
});
