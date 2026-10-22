// Where each challenge's per-instance flag and data are planted (IF-6 section 5; catalogue `flag.placement`). The injector runs this on a copy of the baked snapshot.
//
// This is the one place that turns "the instance has a flag for C0x" into rows and files, so the rule is the same in every instance. It reproduces the set-up that the
// exploit self-tests of challenges/tests/*/c*.test.mjs make by hand, so an instance behaves like the vulnerable build the tests prove:
//
//   database-seed     C01 a competitor order whose buyer note holds the flag; C02 the flag gift card (serial 1); C04 a delivered order and the sentinel;
//                     C07 and C09 the sentinel (C09 also gives the dormant support agent a weak, wordlist password)
//   sentinel-table    C05, C08, C11: one `sentinel` row per challenge, read only by that challenge's path
//   catalogue-store   C03: built at request time from the flags file (see server.mjs), nothing to plant here
//   file placements   C06 for the import service and C10 for the mock services: a read-only file in a volume only that service mounts
//
//   decoys            (H-42, H-331) a decoy is a flag-shaped value placed where a legitimate solver never goes: AT REST, outside the path of the weakness. `decoy_placement`
//                     is `shop-db` (the default: a `sentinel` row `decoy_<key>_<index>`, key in lower case, that no route reads) or `service-file` (C06 and C10 only: `<KEY>.decoy<index>` next to the
//                     placement file, in a volume only that service mounts). It is NOT put beside the real flag: a solver who read the whole table could not tell which is real.
//                     The sidecar still watches responses for the decoy digests, so a value that comes out over an escalation beyond the intended weakness is flagged for a human.
//
// A challenge is planted only when the document carries its flag. Every flag is the exact value the platform derived; nothing here invents or logs one.
import { createHmac } from 'node:crypto';
import { issueCard } from '../challenges/c02-gift-card-codes.mjs';
import { hash } from '../identity/password.mjs';

export const SENTINEL_KEYS = ['C04', 'C05', 'C07', 'C08', 'C09', 'C11'];
export const WEAK_SUPPORT_PASSWORD = 'monday123!'; // the C09 dormant account: a password that is in a common wordlist (the player brings the list)
export const FILE_PLACEMENTS = [
  { challenge_key: 'C06', dir: '/run/placement/import', file: 'C06.placement' }, // kind "file in import service"
  { challenge_key: 'C10', dir: '/run/placement/mock', file: 'C10.placement' }, // kind "file in mock-services"
];

const sentinel = (db, key, value) => db.prepare('INSERT OR REPLACE INTO sentinel (key, value) VALUES (?, ?)').run(key.toLowerCase(), value);

// D-02, per-instance seeded passwords. The baked snapshot gives every instance the same demo passwords. That is wrong for an account the brief does not hand to the player:
// owner.northwind and customer.demo share the demo password of owner.harbor (named in the C06 and C10 briefs), so a player could sign in to the competitor store without C01;
// finance.ops is the C07 target and admin.root, bot.support, s.iyer and the filler customers have documented passwords that sit in the repository. The injector therefore
// gives each of them a password derived from this instance's seed (HMAC-SHA256 over the email), which nobody is told, and leaves only the logins the briefs name.
export const BRIEF_ACCOUNTS = ['staff.harbor@vulnmart.test', 'player.customer@vulnmart.test', 'owner.harbor@vulnmart.test'];

/** The password the injector sets for a reseeded account of the instance with this seed (24 characters of base64url). Only a test asks for it. */
export function reseededPassword(seed, email) {
  return createHmac('sha256', String(seed)).update(`vm-seed-password-v1:${email}`).digest('base64url').slice(0, 24);
}

/** Give every seeded account the brief does not name a password of its own for this instance. Returns the emails changed (never a password). */
export function reseedAccounts(db, seed) {
  const users = db.prepare('SELECT id, email FROM users ORDER BY id').all().filter((u) => !BRIEF_ACCOUNTS.includes(u.email));
  const set = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  for (const u of users) set.run(hash(reseededPassword(seed, u.email)), u.id);
  return users.map((u) => u.email);
}

/** The challenge keys whose flag is in the document, mapped to the flag. */
export function flagMap(doc) {
  return Object.fromEntries(doc.flags.map((f) => [f.challenge_key, f.flag]));
}

export const DECOY_PLACEMENTS = ['shop-db', 'service-file'];
export const FILE_DECOY_KEYS = FILE_PLACEMENTS.map((p) => p.challenge_key);

/** The decoys of the document as { challenge_key, index, value, placement }; the placement defaults to shop-db. */
export function decoyList(doc) {
  return (doc.decoys ?? []).map((x) => ({ challenge_key: x.challenge_key, index: x.index, value: x.value, placement: x.decoy_placement ?? 'shop-db' }));
}

/** Plant the shop-db decoys (sentinel rows no route reads). Returns how many. */
export function plantDecoysDatabase(db, decoys) {
  const rows = decoys.filter((x) => x.placement === 'shop-db');
  for (const x of rows) sentinel(db, `decoy_${x.challenge_key}_${x.index}`, x.value);
  return rows.length;
}

/** Plant every database placement. Returns the keys planted, in order (for the exit report; never a value). */
export function plantDatabase(db, flags) {
  const done = [];
  if (flags.C01) {
    // a Northwind (store 2) order, numbered VM-100777, whose buyer note is the flag: the competitor order C01 reads across stores
    const o = db.prepare("INSERT INTO orders (customer_id, status, total_cents, order_no, buyer_note, ship_line1, ship_city, ship_country) VALUES (11,'paid',1499,'VM-100777',?, '9 Rival Rd','Teastown','Landia')").run(flags.C01);
    db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,3,2,1499,1,'paid',180)").run(Number(o.lastInsertRowid));
    // the orders around it, so the numbers run in sequence as the hints say: four of the player's own store (Harbor, store 1) just before it, two more of the competitor after it (decoys with ordinary notes, never a secret)
    const around = [['VM-100773', 1, 1, 'Please gift wrap.'], ['VM-100774', 1, 1, 'Leave with the neighbour.'], ['VM-100775', 1, 1, 'Is this dishwasher safe?'], ['VM-100776', 1, 1, null], ['VM-100778', 3, 2, 'Ring the bell twice.'], ['VM-100779', 3, 2, 'Loose leaf, not bags, please.']];
    for (const [no, product, store, note] of around) {
      const x = db.prepare("INSERT INTO orders (customer_id, status, total_cents, order_no, buyer_note, ship_line1, ship_city, ship_country) VALUES (11,'paid',1200,?,?,'4 Quay St','Portville','Landia')").run(no, note);
      db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,?,?,1200,1,'paid',150)").run(Number(x.lastInsertRowid), product, store);
    }
    done.push('C01');
  }
  if (flags.C02) {
    issueCard(db, { serial: 1, message: flags.C02, amount_cents: 5000, ownerId: null }, { challenges: { C02: 'vulnerable' } });
    // the unsold staff test cards (catalogue decoys of C02): forging one of them is the second milestone ("redeemed a card they did not buy"); they carry a marker, never the flag
    for (const serial of [2, 3]) issueCard(db, { serial, message: 'STAFF-TEST-CARD: no prize on this card.', amount_cents: 100, ownerId: null }, { challenges: { C02: 'vulnerable' } });
    done.push('C02');
  }
  if (flags.C04) {
    // the player's delivered order, paid 2500: the order whose refunds C04 pushes past the amount paid
    db.prepare("INSERT INTO orders (id, customer_id, status, total_cents, order_no, ship_line1, ship_city, ship_country) VALUES (90001,11,'paid',2500,'VM-190001','1 St','Town','Land')").run();
    db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (90001,1,1,2500,1,'delivered',250)").run();
    done.push('C04');
  }
  for (const key of SENTINEL_KEYS) {
    if (flags[key]) {
      sentinel(db, key, flags[key]);
      if (!done.includes(key)) done.push(key);
    }
  }
  if (flags.C09) {
    db.prepare("UPDATE users SET password_hash = ? WHERE email = 's.iyer@vulnmart.test'").run(hash(WEAK_SUPPORT_PASSWORD));
  }
  return done;
}
