-- T-18 (FR-SHP-10): the correct money model for refunds, commissions and payouts.
-- No BEGIN/COMMIT here — the migration runner wraps this file in one transaction.

-- Refunds carry an optional idempotency key so a retried approval/processing does
-- not pay out or reverse commission twice. Unique only among non-null keys.
ALTER TABLE refunds ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_refunds_idem ON refunds(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Append-only ledger of commission reversed when a refund is processed. The
-- commissions table cannot hold a negative row (CHECK amount_cents >= 0), so a
-- reversal is a separate, additive entry; payout accrual nets the two.
CREATE TABLE commission_reversals (
  id            INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  refund_id     INTEGER NOT NULL REFERENCES refunds(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_commission_reversals_item ON commission_reversals(order_item_id);
