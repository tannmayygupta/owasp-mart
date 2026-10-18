// C02 self-test: the exploit forges the flag card's code and redeems it on the
// vulnerable build (PASS), and is rejected on the fixed build (FAIL). The flag
// card (serial 1) is seeded; sold cards start at 1001.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { issueCard } from '../../../apps/shop/src/challenges/c02-gift-card-codes.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C02-GIFTCARD-FLAG-MARKER';

async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  // Seed the flag card (serial 1) in the same mode the shop runs in, so the
  // fixed build stores a real random code the player cannot derive.
  issueCard(db, { serial: 1, message: MARKER, amount_cents: 5000, ownerId: null }, { challenges: { C02: mode } });
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C02: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events };
}

test('C02 exploit PASSES on the vulnerable build (forged code redeems the flag card)', async () => {
  const { server, baseUrl, events } = await bootShop('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'c02', test: exploit });
    assert.equal(r.passed, true, r.detail);
    assert.ok(events.some((e) => e.type === 'shop.giftcard_attempt' && e.data.card_class === 'flag_card'), 'expected a flag_card redeem event');
  } finally {
    server.close();
  }
});

test('C02 exploit FAILS on the fixed build (a derived code is rejected)', async () => {
  const { server, baseUrl, events } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c02', test: exploit });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'a fixed build is a clean fail, not an error');
    assert.equal(events.some((e) => e.type === 'shop.giftcard_attempt' && e.data.result === 'redeemed' && e.data.card_class === 'flag_card'), false);
  } finally {
    server.close();
  }
});
