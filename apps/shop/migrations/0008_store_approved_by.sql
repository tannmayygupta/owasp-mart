-- T-29 (C11): record how a store was approved. The C11 flag shows only when a
-- store was approved by the KYC fail-open fallback (approved_by =
-- 'system:kyc-fallback'); an admin- or seed-approved store never shows it. No
-- BEGIN/COMMIT here — the runner wraps this file.

ALTER TABLE stores ADD COLUMN approved_by TEXT;
-- Existing (seeded) stores were approved by the seed, not the fallback.
UPDATE stores SET approved_by = 'seed' WHERE approved_by IS NULL;
