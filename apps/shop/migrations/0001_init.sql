-- VulnMart shop schema v1 (T-06, FR-SHP-02). The correct marketplace model:
-- ~20 tables from RS-G 1.1 plus the thin audit log and the C09 security-events
-- and alerts tables. Money is always integer minor units (*_cents). Status
-- columns carry CHECK constraints that match the seven state machines
-- (src/domain/state-machines.mjs). No weaknesses, flags or seed data here.
--
-- Foreign keys are enforced per-connection (PRAGMA foreign_keys = ON in the db
-- wrapper). Timestamps are ISO-8601 text defaulted to CURRENT_TIMESTAMP.

-- Identity --------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN
                  ('customer','seller_owner','seller_staff','support_agent','finance','admin')),
  store_id      INTEGER REFERENCES stores(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE addresses (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  line1       TEXT NOT NULL,
  line2       TEXT,
  city        TEXT NOT NULL,
  region      TEXT,
  postal_code TEXT,
  country     TEXT NOT NULL
);

-- Catalog ---------------------------------------------------------------------
CREATE TABLE stores (
  id                 INTEGER PRIMARY KEY,
  owner_user_id      INTEGER NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                       ('pending','approved','rejected','suspended')),
  commission_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (commission_rate_bp BETWEEN 0 AND 10000),
  kyc_text           TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id)
);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  category_id INTEGER REFERENCES categories(id),
  title       TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                ('draft','pending_review','published','rejected','unlisted')),
  image_path  TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reviews (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT,
  status     TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','reported','removed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, user_id)
);

-- Buying ----------------------------------------------------------------------
CREATE TABLE carts (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cart_items (
  id         INTEGER PRIMARY KEY,
  cart_id    INTEGER NOT NULL REFERENCES carts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  UNIQUE (cart_id, product_id)
);

CREATE TABLE coupons (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  -- Dual unit by design: `value` is minor currency units (cents) when
  -- type='fixed', and percent points when type='percent'.
  value       INTEGER NOT NULL CHECK (value >= 0),
  usage_limit INTEGER,
  store_id    INTEGER REFERENCES stores(id)
);

CREATE TABLE orders (
  id            INTEGER PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'payment_pending' CHECK (status IN
                  ('payment_pending','paid','payment_failed')),
  total_cents   INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  coupon_id     INTEGER REFERENCES coupons(id),
  -- Shipping address snapshot (nullable here; the checkout flow in T-14 fills
  -- and requires it before an order reaches 'paid'). Snapshot by design (RS-G),
  -- not a foreign key to addresses, so later edits to the address do not change
  -- a past order.
  ship_line1    TEXT,
  ship_line2    TEXT,
  ship_city     TEXT,
  ship_region   TEXT,
  ship_postal   TEXT,
  ship_country  TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  store_id         INTEGER NOT NULL REFERENCES stores(id),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  -- No default: the checkout flow sets the fulfilment status explicitly when
  -- the item is created, so an item is never 'paid' before its order is.
  status           TEXT NOT NULL CHECK (status IN
                     ('paid','processing','shipped','delivered','completed','cancelled')),
  commission_cents INTEGER NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payments (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  method      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  card_last4  TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Money out -------------------------------------------------------------------
CREATE TABLE commissions (
  id            INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  rate_bp       INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000)
);

CREATE TABLE payouts (
  id                    INTEGER PRIMARY KEY,
  store_id              INTEGER NOT NULL REFERENCES stores(id),
  period                TEXT NOT NULL,
  gross_cents           INTEGER NOT NULL DEFAULT 0 CHECK (gross_cents >= 0),
  commission_cents      INTEGER NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  refunds_deducted_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunds_deducted_cents >= 0),
  -- net_cents = gross - commission - refunds_deducted and may legitimately be
  -- negative (refunds exceed a period's sales), so it carries no >= 0 CHECK.
  net_cents             INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'accrued' CHECK (status IN
                          ('accrued','ready','approved_by_finance','paid','held')),
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- After sale ------------------------------------------------------------------
CREATE TABLE refunds (
  id            INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
                  ('requested','approved','rejected','processed')),
  requested_by  INTEGER NOT NULL REFERENCES users(id),
  decided_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE disputes (
  id            INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  opened_by     INTEGER NOT NULL REFERENCES users(id),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN
                  ('open','under_review','resolved_customer','resolved_seller','escalated')),
  resolution    TEXT,
  liable_party  TEXT CHECK (liable_party IN ('customer','seller')),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tickets (
  id           INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  assignee_id  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ticket_messages (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Files -----------------------------------------------------------------------
CREATE TABLE uploads (
  id            INTEGER PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id),
  store_id      INTEGER REFERENCES stores(id),
  path          TEXT NOT NULL,
  mime          TEXT,
  original_name TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Audit and detection (kept thin on purpose; see C09) -------------------------
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  target     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE security_events (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES users(id),
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY,
  security_event_id INTEGER REFERENCES security_events(id),
  kind              TEXT NOT NULL,
  acknowledged      INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Helpful indexes for the common lookups later stories make.
CREATE INDEX idx_products_store ON products(store_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_store ON order_items(store_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_security_events_account ON security_events(account_id);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_refunds_order_item ON refunds(order_item_id);
CREATE INDEX idx_commissions_order_item ON commissions(order_item_id);
CREATE INDEX idx_disputes_order_item ON disputes(order_item_id);
CREATE INDEX idx_ticket_messages_ticket ON ticket_messages(ticket_id);
CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_uploads_owner ON uploads(owner_id);
