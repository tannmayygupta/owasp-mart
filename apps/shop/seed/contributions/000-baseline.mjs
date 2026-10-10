// Baseline seeded world (T-08, FR-SHP-12). Deterministic: fixed ids and fixed
// timestamps (ctx.ts), no randomness, so every build produces the same world.
// This is the generic marketplace world (categories, two approved stores and
// their owners, a demo customer, a handful of products). Per-challenge seeded
// accounts are T-16; flags and per-instance secrets are injected at start, not
// here. Seed passwords are known demo-world data, not secrets.
import { hash } from '../../src/identity/password.mjs';

// A documented, non-secret demo password for the seeded world accounts.
export const SEED_PASSWORD = 'vulnmart-seed-demo';

export default function seed(db, ctx) {
  const ts = ctx.ts;
  const pw = hash(SEED_PASSWORD);

  const insertUser = db.prepare(
    'INSERT INTO users (id, email, password_hash, role, store_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertStore = db.prepare(
    'INSERT INTO stores (id, owner_user_id, name, status, commission_rate_bp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertCategory = db.prepare('INSERT INTO categories (id, name, parent_id) VALUES (?, ?, ?)');
  const insertProduct = db.prepare(
    'INSERT INTO products (id, store_id, category_id, title, description, price_cents, stock, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  // Users (store owners first with no store yet, then a customer).
  insertUser.run(1, 'owner.harbor@vulnmart.test', pw, 'seller_owner', null, 'active', ts);
  insertUser.run(2, 'owner.northwind@vulnmart.test', pw, 'seller_owner', null, 'active', ts);
  insertUser.run(3, 'customer.demo@vulnmart.test', pw, 'customer', null, 'active', ts);

  // Categories.
  insertCategory.run(1, 'Electronics', null);
  insertCategory.run(2, 'Home', null);
  insertCategory.run(3, 'Books', null);
  insertCategory.run(4, 'Grocery', null);

  // Stores (approved) and link each owner to its store.
  insertStore.run(1, 1, 'Harbor Supplies', 'approved', 1000, ts, ts);
  insertStore.run(2, 2, 'Northwind Tea Co.', 'approved', 1200, ts, ts);
  db.prepare('UPDATE users SET store_id = ? WHERE id = ?').run(1, 1);
  db.prepare('UPDATE users SET store_id = ? WHERE id = ?').run(2, 2);

  // Products (published) across the two stores and categories.
  insertProduct.run(1, 1, 1, 'USB-C Charger', 'A reliable 65W charger.', 1999, 50, 'published', ts, ts);
  insertProduct.run(2, 1, 2, 'Ceramic Mug', 'A plain everyday mug.', 899, 200, 'published', ts, ts);
  insertProduct.run(3, 2, 4, 'Green Tea Sampler', 'Six loose-leaf teas.', 1499, 80, 'published', ts, ts);
  insertProduct.run(4, 2, 2, 'Steel Kettle', 'A 1.7L stovetop kettle.', 2999, 30, 'published', ts, ts);
}
