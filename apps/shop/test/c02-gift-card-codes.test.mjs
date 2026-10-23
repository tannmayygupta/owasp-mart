// Unit tests of the C02 module in isolation (no HTTP, no app): the code format, the case-insensitivity fix, and every redeem outcome.
// A real bug report ("the old redeem card doesn't exist") turned out to be a forged code rejected only because its hex was upper
// case; these tests pin that down so it cannot come back silently.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { buyCard, issueCard, redeem } from '../src/challenges/c02-gift-card-codes.mjs';

const VULN = { challenges: { C02: 'vulnerable' } };
const FIXED = { challenges: {} };
const md5hex = (serial) => createHash('md5').update(String(serial)).digest('hex').slice(0, 12);

/** A fresh database with one real customer row (the player), so owner/foreign-key columns are satisfiable. */
function dbWithPlayer() {
  const d = openDb(':memory:');
  migrate(d);
  d.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (7, 'player@example.test', 'x', 'customer')").run();
  return d;
}
const player = { id: 7 };

test('a forged code for a lower serial is redeemed on the vulnerable build, whatever case it is typed in', () => {
  const forged = 'VM-' + md5hex('1');
  const variants = [forged, forged.toUpperCase(), forged.slice(0, 7) + forged.slice(7).toUpperCase(), ` ${forged} `];
  for (const typed of variants) {
    const d = dbWithPlayer();
    issueCard(d, { serial: 1, message: 'VM{FLAG}', amount_cents: 5000 }, VULN); // the seeded flag card, no owner
    buyCard(d, player, { amount_cents: 2000 }, VULN); // the player's own card, so the pattern is visible to them
    const out = redeem(d, player, typed, VULN);
    assert.equal(out.serial, 1, `typed as ${JSON.stringify(typed)}`);
    assert.equal(out.card_class, 'flag_card');
  }
});

test('a code with the wrong shape is malformed; a well-formed code nothing matches is "no such gift card", not malformed', () => {
  const d = dbWithPlayer();
  issueCard(d, { serial: 1, message: 'x', amount_cents: 100 }, VULN);
  assert.throws(() => redeem(d, player, 'not-a-code', VULN), /malformed code/);
  assert.throws(() => redeem(d, player, 'VM-zz', VULN), /malformed code/, 'too short and not hex');
  assert.throws(() => redeem(d, player, 'VM-aaaaaaaaaaaa', VULN), /no such gift card/, 'well-formed, matches nothing');
});

test('redeeming the same card twice is refused the second time', () => {
  const d = dbWithPlayer();
  issueCard(d, { serial: 1, message: 'x', amount_cents: 100 }, VULN);
  const code = 'VM-' + md5hex('1');
  redeem(d, player, code, VULN);
  assert.throws(() => redeem(d, player, code, VULN), /already redeemed/);
});

test('on the fixed build the forged (weak-derivation) code for a card never matches; only the real random code does, in any case', () => {
  const d = dbWithPlayer();
  issueCard(d, { serial: 1, message: 'x', amount_cents: 100 }, FIXED); // random code, keyed hash stored
  assert.throws(() => redeem(d, player, 'VM-' + md5hex('1'), FIXED), /no such gift card/, 'the weak derivation does not apply here');

  const d2 = dbWithPlayer();
  const real = issueCard(d2, { serial: 1, message: 'x', amount_cents: 100 }, FIXED);
  const out = redeem(d2, player, real.toUpperCase(), FIXED);
  assert.equal(out.serial, 1);
});
