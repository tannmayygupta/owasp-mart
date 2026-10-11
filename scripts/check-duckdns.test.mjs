// Tests for the S-16 wildcard check with an injected resolver (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWildcard, validName, validLabel, parseCli } from './check-duckdns.mjs';

// map: { '<host>': { 4: [...], 6: [...] } or array (family 4 only) }; '*' answers every other host.
const fake = (map) => async (h, family) => {
  const e = h in map ? map[h] : map['*'];
  const v = Array.isArray(e) ? (family === 4 ? e : undefined) : e?.[family];
  if (v) return v;
  const err = new Error('nx'); err.code = 'ENODATA'; throw err;
};

test('match when a random label resolves to the same A record; the address is never printed', async () => {
  const r = await checkWildcard({ name: 'demo.duckdns.org', resolve: fake({ '*': ['198.51.100.7'] }), label: 'zz' });
  assert.equal(r.code, 0);
  assert.match(r.message, /^match/);
  assert.ok(!r.message.includes('198.51.100.7'));
});

test('a match on AAAA alone counts', async () => {
  const r = await checkWildcard({ name: 'demo.duckdns.org', resolve: fake({ '*': { 6: ['2001:db8::7'] } }), label: 'zz' });
  assert.equal(r.code, 0);
  assert.match(r.message, /AAAA/);
  assert.ok(!r.message.includes('2001:db8'));
});

test('no match when the label does not resolve, resolves elsewhere, or the name itself fails', async () => {
  const none = await checkWildcard({ name: 'demo.duckdns.org', resolve: fake({ 'demo.duckdns.org': ['198.51.100.7'] }), label: 'zz' });
  assert.equal(none.code, 1);
  assert.match(none.message, /^no match: a random label does not resolve/);
  const other = await checkWildcard({ name: 'demo.duckdns.org', resolve: fake({ 'demo.duckdns.org': ['198.51.100.7'], 'zz.demo.duckdns.org': ['203.0.113.9'] }), label: 'zz' });
  assert.equal(other.code, 1);
  assert.ok(!other.message.includes('203.0.113.9') && !other.message.includes('198.51.100.7'));
  const gone = await checkWildcard({ name: 'demo.duckdns.org', resolve: fake({}), label: 'zz' });
  assert.equal(gone.code, 1);
  assert.match(gone.message, /the name itself does not resolve/);
});

test('a resolver that hangs is cut off by the resolver time limit (an error code counts as no answer)', async () => {
  const timeout = async () => { const e = new Error('t'); e.code = 'ETIMEOUT'; throw e; };
  const r = await checkWildcard({ name: 'demo.duckdns.org', resolve: timeout, label: 'zz' });
  assert.equal(r.code, 1);
  assert.match(r.message, /ETIMEOUT/);
});

test('refuses a name that is not <x>.duckdns.org, and a label that is not 1 to 63 of a-z, 0-9, -', async () => {
  for (const n of ['example.com', '*.demo.duckdns.org', 'a.b.duckdns.org', '', undefined, 'UPPER.duckdns.org']) {
    assert.equal(validName(n), false, String(n));
    assert.equal((await checkWildcard({ name: n, resolve: fake({ '*': ['198.51.100.7'] }) })).code, 2);
  }
  for (const l of ['', 'a.b', 'Abc', 'a b', 'x'.repeat(64), '../x', undefined]) assert.equal(validLabel(l), false, String(l));
  assert.equal(validLabel('s16-abc123'), true);
  const bad = await checkWildcard({ name: 'demo.duckdns.org', resolve: fake({ '*': ['198.51.100.7'] }), label: 'a.b' });
  assert.equal(bad.code, 2);
  assert.match(bad.message, /usage:/);
});

test('command line: --label is read by flag, a bad call gives a usage error', () => {
  assert.deepEqual(parseCli(['demo.duckdns.org']), { name: 'demo.duckdns.org' });
  assert.deepEqual(parseCli(['--label', 'abc', 'demo.duckdns.org']), { name: 'demo.duckdns.org', label: 'abc' });
  assert.deepEqual(parseCli(['demo.duckdns.org', '--label', 'abc']), { name: 'demo.duckdns.org', label: 'abc' });
  for (const bad of [[], ['--label'], ['--label', '--x', 'a.duckdns.org'], ['a.duckdns.org', 'b.duckdns.org'], ['--nope', 'a.duckdns.org']]) assert.ok(parseCli(bad).error, JSON.stringify(bad));
});
