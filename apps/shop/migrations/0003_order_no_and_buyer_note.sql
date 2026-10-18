-- T-19 (C01): seller order detail is addressed by a human-facing, sequential
-- order number (VM-1NNNNN), and an order carries a buyer_note (the field C01's
-- flag lives in for a seeded order). No BEGIN/COMMIT — the runner wraps this file.

ALTER TABLE orders ADD COLUMN order_no TEXT;
ALTER TABLE orders ADD COLUMN buyer_note TEXT;

-- Backfill a deterministic, sequential order number for existing rows.
UPDATE orders SET order_no = 'VM-1' || substr('00000' || id, -5) WHERE order_no IS NULL;

-- Unique among the non-null numbers (new orders get theirs at checkout).
CREATE UNIQUE INDEX idx_orders_order_no ON orders(order_no) WHERE order_no IS NOT NULL;
