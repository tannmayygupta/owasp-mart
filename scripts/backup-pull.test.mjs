import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeDump, newest, toPrune } from './backup-pull.mjs';

test('the newest dump of each database is chosen from a listing, anything else is ignored', () => {
  const names = ['vulnmart-20261018T023000Z.dump', 'vulnmart-20261019T023000Z.dump', 'vm_keystore-20261017T000000Z.dump', 'vm_keystore-20261019T023001Z.dump', 'notes.txt', 'vulnmart-20261019T023000Z.dump.part', ''];
  assert.deepEqual(newest(names), ['vulnmart-20261019T023000Z.dump', 'vm_keystore-20261019T023001Z.dump']);
  assert.deepEqual(newest(['vulnmart-20261019T023000Z.dump']), ['vulnmart-20261019T023000Z.dump']);
  assert.deepEqual(newest([]), []);
});

test('a dump needs the PostgreSQL custom-format header and some content', () => {
  assert.equal(looksLikeDump(Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(100)])), true);
  assert.equal(looksLikeDump(Buffer.from('PGDMP')), false);
  assert.equal(looksLikeDump(Buffer.alloc(200, 'x')), false);
  assert.equal(looksLikeDump('PGDMP'.padEnd(200)), false);
});

test('only the newest N of each database stay locally', () => {
  const names = ['vulnmart-20261015T000000Z.dump', 'vulnmart-20261016T000000Z.dump', 'vulnmart-20261017T000000Z.dump', 'vm_keystore-20261015T000000Z.dump', 'vm_keystore-20261016T000000Z.dump', 'other.txt'];
  assert.deepEqual(toPrune(names, 2), ['vulnmart-20261015T000000Z.dump']);
  assert.deepEqual(toPrune(names, 5), []);
});