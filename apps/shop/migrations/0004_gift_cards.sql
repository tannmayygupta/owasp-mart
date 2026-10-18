-- T-20 (C02): gift cards. A card has a serial, a message (where the C02 flag sits
-- for a seeded card), an amount, and — in the fixed build — a keyed hash of a
-- random code. Redeemed credit goes to a SEPARATE, non-spendable promo_credit
-- ledger (never the wallet or the C04 refund ledger). No BEGIN/COMMIT here.

CREATE TABLE gift_cards (
  id            INTEGER PRIMARY KEY,
  serial        INTEGER NOT NULL UNIQUE,
  message       TEXT,
  amount_cents  INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  code_hash     TEXT,          -- keyed hash of the random code (fixed build only)
  owner_user_id INTEGER REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','redeemed')),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE promo_credit (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
