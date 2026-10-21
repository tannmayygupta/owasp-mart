import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { CHALLENGES, newFlag, recordingFetch, ruleSeen } from './e2e-local-flags.mjs';

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

const C09_M2 = { kind: 'negative_window', group_by: 'account_id', failures: { type: 'auth.attempt', where: { route: 'legacy', result: { in: ['failure'] } }, at_least: 3 },
  success: { type: 'auth.attempt', where: { route: 'legacy', result: { in: ['success'] } } }, window_s: 600, absent: { type: 'shop.security_event_written', count: 0 }, grace_s: 30 };
const att = (result, account = '9', route = 'legacy') => ({ type: 'auth.attempt', data: { route, account_id: account, result } });

test('the rule evaluator: the C09 negative observation needs the failures, the success and no security event for the SAME account', () => {
  const ok = [att('failure'), att('failure'), att('failure'), att('success')];
  assert.equal(ruleSeen(ok, C09_M2), 'yes');
  assert.equal(ruleSeen([att('failure'), att('failure'), att('success')], C09_M2), 'no', 'too few failures');
  assert.equal(ruleSeen([...ok, { type: 'shop.security_event_written', data: { account_id: '9', kind: 'login_failed' } }], C09_M2), 'no', 'a security event for the account');
  assert.equal(ruleSeen([...ok, { type: 'shop.security_event_written', data: { account_id: '4', kind: 'login_failed' } }], C09_M2), 'yes', 'a security event for ANOTHER account does not count');
  assert.equal(ruleSeen([att('failure', 'unknown'), att('failure', 'unknown'), att('failure', 'unknown'), att('success', '9')], C09_M2), 'no', 'failures against an unknown email do not pool into the account');
  assert.equal(ruleSeen([att('failure', '9', 'web'), att('failure', '9', 'web'), att('failure', '9', 'web'), att('success')], C09_M2), 'no', 'web failures are not legacy failures');
});

test('the rule evaluator: any, count_distinct and grouped count are evaluated, not guessed', () => {
  const read = (order, store = '3') => ({ type: 'shop.cross_store_order_read', data: { order_id: order, order_store_id: store } });
  const c01 = { kind: 'any', of: [{ kind: 'count_distinct', type: 'shop.cross_store_order_read', where: {}, field: 'order_id', at_least: 3 }, { kind: 'event', type: 'shop.cross_store_order_read', where: { order_store_id: '2' } }] };
  assert.equal(ruleSeen([read('a'), read('b'), read('b')], c01), 'no');
  assert.equal(ruleSeen([read('a'), read('b'), read('c')], c01), 'yes');
  assert.equal(ruleSeen([read('a', '2')], c01), 'yes');
  const c04 = { kind: 'count', type: 'shop.refund_decision', where: { path: 'quick', decision: 'auto_approved' }, at_least: 2, group_by: 'order_id' };
  const rf = (order) => ({ type: 'shop.refund_decision', data: { path: 'quick', decision: 'auto_approved', order_id: order } });
  assert.equal(ruleSeen([rf('1'), rf('2')], c04), 'no');
  assert.equal(ruleSeen([rf('1'), rf('2'), rf('1')], c04), 'yes');
});
