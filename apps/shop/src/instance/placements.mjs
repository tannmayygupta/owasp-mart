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
// A challenge is planted only when the document carries its flag. Every flag is the exact value the platform derived; nothing here invents or logs one.
import { issueCard } from '../challenges/c02-gift-card-codes.mjs';
import { hash } from '../identity/password.mjs';

export const SENTINEL_KEYS = ['C04', 'C05', 'C07', 'C08', 'C09', 'C11'];
export const WEAK_SUPPORT_PASSWORD = 'monday123!'; // the C09 dormant account: a password that is in a common wordlist (the player brings the list)
export const FILE_PLACEMENTS = [
  { challenge_key: 'C06', dir: '/run/placement/import', file: 'C06.placement' }, // kind "file in import service"
  { challenge_key: 'C10', dir: '/run/placement/mock', file: 'C10.placement' }, // kind "file in mock-services"
];

const sentinel = (db, key, value) => db.prepare('INSERT OR REPLACE INTO sentinel (key, value) VALUES (?, ?)').run(key.toLowerCase(), value);

/** The challenge keys whose flag is in the document, mapped to the flag. */
export function flagMap(doc) {
  return Object.fromEntries(doc.flags.map((f) => [f.challenge_key, f.flag]));
}

/** Plant every database placement. Returns the keys planted, in order (for the exit report; never a value). */
export function plantDatabase(db, flags) {
  const done = [];
  if (flags.C01) {
    // a Northwind (store 2) order, numbered VM-100777, whose buyer note is the flag: the competitor order C01 reads across stores
    const o = db.prepare("INSERT INTO orders (customer_id, status, total_cents, order_no, buyer_note, ship_line1, ship_city, ship_country) VALUES (11,'paid',1499,'VM-100777',?, '9 Rival Rd','Teastown','Landia')").run(flags.C01);
    db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,3,2,1499,1,'paid',180)").run(Number(o.lastInsertRowid));
    done.push('C01');
  }
  if (flags.C02) {
    issueCard(db, { serial: 1, message: flags.C02, amount_cents: 5000, ownerId: null }, { challenges: { C02: 'vulnerable' } });
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
