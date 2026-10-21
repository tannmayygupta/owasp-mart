// C11 — Mishandling of Exceptional Conditions (OWASP 2025 A10), CWE-636/755.
//
// Seller registration sends the tax ID to a KYC provider. The verify call is
// wrapped in a catch meant to "never block onboarding on a provider outage".
// This module owns the one place that catch decides what a provider error means.
//
//   FIXED (default): a provider error FAILS CLOSED — the store stays pending for
//     manual review; it is never auto-approved.
//   VULNERABLE (VM_CHALLENGE_C11=vulnerable): the catch returns "verified" on ANY
//     thrown error, so a malformed tax-id shape that crashes the provider (500)
//     auto-approves the store with approved_by = 'system:kyc-fallback'. The
//     Payouts page then shows the flag (shown only for a fallback-approved store).
//
// Two input classes: class 1 (parseable but invalid) gets a 422 and a verbose
// upstream message (guidance, not the bug); class 2 (malformed shape) crashes the
// provider. Fix: fail closed, strict input validation before the call, narrow
// exception types, generic user errors, alert on provider errors.
import { ValidationError, ForbiddenError } from '../domain/shop-service.mjs';
import { isVulnerable } from './mode.mjs';

export class KycInvalidError extends Error {} // class 1: provider 422
export class KycProviderError extends Error {} // class 2: provider 500 (crash)

// The KYC provider mock. A normal ascii tax id verifies; a parseable-but-invalid
// one is a 422 (verbose); a malformed shape (non-string) crashes the provider.
export function kycVerify(taxId) {
  if (typeof taxId !== 'string' || taxId.length === 0) {
    throw new KycProviderError('KYC provider error 500');
  }
  if (!/^[\x20-\x7e]{1,32}$/.test(taxId)) {
    throw new KycInvalidError('KYC provider https://kyc.vulnmart.internal/verify returned 422: tax id has an invalid format');
  }
  return { verified: true };
}

function flag(db) {
  return db.prepare("SELECT value FROM sentinel WHERE key = 'c11'").get()?.value ?? 'C11-PAYOUTS-FLAG-MARKER';
}

// Register a seller store with the KYC step. A new store starts pending; only the
// vulnerable fail-open path auto-approves it. Promotes the actor to seller_owner.
export function registerStoreWithKyc(db, user, { name, tax_id } = {}, { challenges = {}, emit = () => {}, kyc = kycVerify } = {}) {
  if (!user || user.status !== 'active') throw new ForbiddenError();
  if (user.store_id) throw new ValidationError('this account already has a store');
  if (user.role !== 'customer' && user.role !== 'seller_owner') throw new ForbiddenError('only a customer without a store can register one');
  const nm = String(name ?? '').trim();
  if (!nm) throw new ValidationError('a store name is required');

  const info = db.prepare("INSERT INTO stores (owner_user_id, name, status, approved_by) VALUES (?, ?, 'pending', NULL)").run(user.id, nm);
  const storeId = Number(info.lastInsertRowid);
  db.prepare("UPDATE users SET role = 'seller_owner', store_id = ? WHERE id = ?").run(storeId, user.id);

  try {
    kyc(tax_id); // valid -> verified; stays pending for admin review
    emit('kyc.result', { outcome: 'valid', store_id: String(storeId) }); // IF-4 outcomes: valid, invalid_verbose, provider_error_fallback
    return { store_id: storeId, outcome: 'pending' };
  } catch (err) {
    if (err instanceof KycInvalidError) {
      // Class 1: pending (correct) + a verbose upstream message (guidance).
      emit('kyc.result', { outcome: 'invalid_verbose', store_id: String(storeId) });
      return { store_id: storeId, outcome: 'pending', verbose: err.message };
    }
    // Class 2: provider crash.
    if (isVulnerable('C11', challenges)) {
      // FAIL OPEN: approve the store on a provider error.
      db.prepare("UPDATE stores SET status = 'approved', approved_by = 'system:kyc-fallback', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(storeId);
      emit('kyc.result', { outcome: 'provider_error_fallback', store_id: String(storeId) });
      emit('store.approved', { store_id: String(storeId), approved_by: 'system_kyc_fallback' }); // IF-4 ids cannot hold a colon: the stored value is system:kyc-fallback
      return { store_id: storeId, outcome: 'fallback_approved' };
    }
    // FAIL CLOSED: stays pending (the contract has no outcome for a provider error that was refused: it is reported as the fallback outcome with no approval event).
    emit('kyc.result', { outcome: 'provider_error_fallback', store_id: String(storeId) });
    return { store_id: storeId, outcome: 'pending' };
  }
}

// The seller Payouts page. The flag is shown only when the store was approved by
// the KYC fallback (sentinel rule) — never for a seed- or admin-approved store.
export function sellerPayoutsView(db, user) {
  const store = user.store_id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(user.store_id) : null;
  if (!store) throw new ForbiddenError();
  const payouts = db.prepare('SELECT id, period, net_cents, status FROM payouts WHERE store_id = ? ORDER BY id DESC').all(store.id);
  return {
    store,
    payouts,
    flag: store.approved_by === 'system:kyc-fallback' ? flag(db) : null,
  };
}
