-- T-22 (C04): the "quick refund" path and its ledger. refund_ledger records quick
-- refunds (separate, non-spendable); goodwill_adjustment is the sentinel row that
-- only ever exists once the refunded total passes the amount paid (the C04 flag
-- lives in its reference, read from the sentinel table at that moment). No
-- BEGIN/COMMIT here — the runner wraps this file in one transaction.

CREATE TABLE refund_ledger (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  path            TEXT NOT NULL DEFAULT 'quick',
  idempotency_key TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_refund_ledger_idem ON refund_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE goodwill_adjustment (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  reference  TEXT,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sentinel values read only by the ledger-reconcile path (the C04 flag reference
-- lives here; injected per instance). Not reachable by any other challenge.
CREATE TABLE sentinel (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
