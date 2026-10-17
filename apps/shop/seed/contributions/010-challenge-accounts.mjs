// Per-challenge account roster (T-16, FR-SHP-08). The known cast every fresh
// instance needs: a player seller-staff and customer login, a finance account,
// a dormant support agent, an admin, a support-agent bot, and filler customers
// no human uses. Accounts only — per-challenge vulnerable data, the deliberate
// weak/default passwords (C05/C07/C09) and per-instance flags are injected by
// the challenge epics and the injector (D-02), never baked in here.
//
// Each password is DISTINCT and documented non-secret demo data: the AC is that
// no seeded account password is reused across challenges (C07 and C09 differ).
// The owning challenge epic replaces a specific account's credential with the
// deliberate weakness per instance; here every account has a strong distinct
// placeholder so the roster works and the no-reuse invariant holds.
//
// Stores are the two baseline stores (Harbor = the player's store, Northwind =
// the "other" store C01 reads across); this contribution adds no stores. Ids
// start at 10 so they never collide with the baseline users (1-3).
import { hash } from '../../src/identity/password.mjs';

// The roster as data — one source of truth for the challenge briefs, the
// exploit tests and later epics. `store` is a baseline store id or null.
export const CHALLENGE_ACCOUNTS = [
  { id: 10, email: 'staff.harbor@vulnmart.test', role: 'seller_staff', store: 1, password: 'harbor-staff-demo-a1', note: "player's seller staff at Harbor (C01/C06 start)" },
  { id: 11, email: 'player.customer@vulnmart.test', role: 'customer', store: null, password: 'player-customer-demo-b2', note: "player's customer login (C02/C04/C07/C08/C09 start)" },
  { id: 12, email: 'finance.ops@vulnmart.test', role: 'finance', store: null, password: 'finance-ops-demo-c3', note: 'C07 reset-code target' },
  { id: 13, email: 's.iyer@vulnmart.test', role: 'support_agent', store: null, password: 'legacy-support-demo-d4', note: 'C09 dormant legacy-login target (distinct from the bot)' },
  { id: 14, email: 'admin.root@vulnmart.test', role: 'admin', store: null, password: 'admin-root-demo-e5', note: 'C01/C05/C09-alerts/C11 queue' },
  { id: 15, email: 'bot.support@vulnmart.test', role: 'support_agent', store: null, password: 'support-bot-demo-f6', note: 'C03 stored-XSS victim bot (distinct from s.iyer)' },
  { id: 16, email: 'shopper.lee@vulnmart.test', role: 'customer', store: null, password: 'filler-lee-demo-g7', note: 'filler customer, no human uses' },
  { id: 17, email: 'shopper.ng@vulnmart.test', role: 'customer', store: null, password: 'filler-ng-demo-h8', note: 'filler customer, no human uses' },
];

// Every plaintext login password this contribution seeds (see 000-baseline's
// note): the global cross-contribution distinctness test reads this.
export const seededPasswords = CHALLENGE_ACCOUNTS.map((a) => a.password);

export default function seed(db, ctx) {
  const ts = ctx.ts;
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, password_hash, role, store_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const a of CHALLENGE_ACCOUNTS) {
    insertUser.run(a.id, a.email, hash(a.password), a.role, a.store, 'active', ts);
  }
}
