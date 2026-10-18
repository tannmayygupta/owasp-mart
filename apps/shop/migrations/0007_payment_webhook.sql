-- T-26 (C08): the payment webhook. A payment carries a provider reference and a
-- verified flag; payment_ref is written from the sentinel only on the unsigned
-- sandbox-bypass path (the C08 flag). No BEGIN/COMMIT here — the runner wraps this.

ALTER TABLE payments ADD COLUMN payment_ref TEXT;
ALTER TABLE payments ADD COLUMN verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1));
