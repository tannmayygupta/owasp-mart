// C02 — Cryptographic Failures (OWASP 2021 A02 / 2025 A04), CWE-328/338.
//
// Gift-card redemption codes. The question is how a code is derived from a card.
// This module is the single isolated place where the correct and the weak answer
// diverge; the rest of the shop is unaffected.
//
//   FIXED (default): a code is 24 random hex from a CSPRNG, and only a keyed hash
//     (HMAC) of it is stored. A code cannot be derived from anything printed on a
//     receipt, so guessing serial 1's code does not work.
//
//   VULNERABLE (VM_CHALLENGE_C02=vulnerable): the code is `VM-` + the first 12 hex
//     of an UNSALTED MD5 of the serial (a counter printed on the receipt). Anyone
//     who buys two cards sees the pattern and can forge the code of any serial,
//     including the seeded flag card (serial 1).
//
// Redeemed value goes to a separate, non-spendable promo_credit ledger — never a
// wallet usable at checkout and never the C04 refund ledger. The fix: random
// codes, keyed-hash at rest, single use, rate limit; see the challenge spec.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValidationError, NotFoundError } from '../domain/shop-service.mjs';
import { isVulnerable } from './mode.mjs';

const PREFIX = 'VM-';
const WELLFORMED = /^VM-[0-9a-f]{12}$/;
// A keyed hash secret for stored codes (fixed build). Per-instance in real runs;
// a fixed dev default keeps tests deterministic. Never the challenge flag.
const CODE_HMAC_KEY = process.env.VM_GIFTCARD_HMAC_KEY || 'dev-giftcard-key';

// The DELIBERATELY WEAK derivation: unsalted MD5 of the serial, first 12 hex.
function weakCodeFor(serial) {
  return PREFIX + createHash('md5').update(String(serial)).digest('hex').slice(0, 12);
}
function keyedHash(code) {
  return createHmac('sha256', CODE_HMAC_KEY).update(code).digest('hex');
}
function hexEq(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Issue a card at `serial`. Returns the code to show the buyer once. In the fixed
// build the code is random and only its keyed hash is stored; in the vulnerable
// build the code is derivable from the serial, so nothing secret is stored.
export function issueCard(db, { serial, message = null, amount_cents = 0, ownerId = null }, { challenges = {} } = {}) {
  let code;
  let codeHash = null;
  if (isVulnerable('C02', challenges)) {
    code = weakCodeFor(serial);
  } else {
    code = PREFIX + randomBytes(12).toString('hex');
    codeHash = keyedHash(code);
  }
  db.prepare('INSERT INTO gift_cards (serial, message, amount_cents, code_hash, owner_user_id, status) VALUES (?, ?, ?, ?, ?, \'issued\')')
    .run(serial, message, amount_cents, codeHash, ownerId);
  return code;
}

// Buy a card with the simulated payment. Sold cards start at serial 1001.
export function buyCard(db, user, { amount_cents = 2000 } = {}, { challenges = {} } = {}) {
  const nextSerial = Math.max(1000, db.prepare('SELECT COALESCE(MAX(serial), 1000) AS m FROM gift_cards').get().m) + 1;
  const amt = Number(amount_cents);
  if (!Number.isInteger(amt) || amt <= 0 || amt > 1_000_00) throw new ValidationError('invalid amount');
  const code = issueCard(db, { serial: nextSerial, message: null, amount_cents: amt, ownerId: user.id }, { challenges });
  return { serial: nextSerial, code, amount_cents: amt };
}

// Redeem a code. The branch that matters is how a card is found from the code.
export function redeem(db, user, rawCode, { challenges = {}, emit = () => {} } = {}) {
  const code = String(rawCode ?? '').trim();
  const wellformed = WELLFORMED.test(code);
  const attempt = (result, extra = {}) => emit('shop.giftcard_attempt', { result, user_id: user?.id != null ? String(user.id) : null, ...extra });

  let card = null;
  if (isVulnerable('C02', challenges)) {
    // VULNERABLE: the code IS a function of the serial, so recover the serial by
    // matching the weak derivation against every card. A forged code for a serial
    // the player never bought still matches — that is the weakness.
    if (!wellformed) { attempt('malformed'); throw new ValidationError('malformed code'); }
    for (const c of db.prepare('SELECT * FROM gift_cards').all()) {
      if (hexEq(weakCodeFor(c.serial), code)) { card = c; break; }
    }
  } else {
    // FIXED: look the card up by the keyed hash of the presented code. Only the
    // real random code matches; a code derived from a serial will not.
    if (wellformed || code.startsWith(PREFIX)) {
      card = db.prepare('SELECT * FROM gift_cards WHERE code_hash = ?').get(keyedHash(code)) ?? null;
    }
  }

  if (!card) {
    attempt(wellformed ? 'unknown_wellformed' : 'invalid');
    throw new NotFoundError('no such gift card');
  }
  if (card.status === 'redeemed') { attempt('already_redeemed', { serial: String(card.serial) }); throw new ValidationError('card already redeemed'); }

  const ownedByPlayer = card.owner_user_id === user.id;
  const cardClass = card.serial === 1 ? 'flag_card' : (!ownedByPlayer ? 'unsold_test' : 'own');
  db.prepare("UPDATE gift_cards SET status = 'redeemed' WHERE id = ?").run(card.id);
  // Credit goes to the non-spendable promo ledger, never a checkout-usable wallet.
  db.prepare("INSERT INTO promo_credit (user_id, amount_cents, source) VALUES (?, ?, 'giftcard')").run(user.id, card.amount_cents);
  attempt('redeemed', { card_class: cardClass, serial: String(card.serial) });
  // The message (where a seeded card's flag lives) is returned only here.
  return { serial: card.serial, amount_cents: card.amount_cents, message: card.message, card_class: cardClass };
}
