// Permission matrix tests (T-07, FR-SHP-03), checking the RS-G 1.2 cells and
// the store/owner scoping, including the FR-SHP-03 acceptance criteria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, permissionScope, requiresRedaction, ACTIONS } from '../src/domain/permissions.mjs';

// Per RS-G 1.2, admin administers but does not act as a buyer or a complainant,
// and "propose commission" is finance's cell. Everything else is admin's.
const NOT_ADMIN = new Set(['cart_checkout', 'request_refund', 'open_dispute', 'write_review', 'propose_commission']);

test('admin may do every administrative action and none of the buyer/complainant ones', () => {
  for (const action of ACTIONS) {
    const expected = !NOT_ADMIN.has(action);
    assert.equal(can('admin', action, {}), expected, `admin ${action} should be ${expected}`);
  }
});

test('customers see only their own orders (FR-SHP-03 AC)', () => {
  assert.equal(can('customer', 'view_order', { actor_id: 7, owner_id: 7 }), true);
  assert.equal(can('customer', 'view_order', { actor_id: 7, owner_id: 8 }), false);
});

test('seller roles are scoped to their own store (FR-SHP-03 AC)', () => {
  const own = { actor_store_id: 3, resource_store_id: 3 };
  const other = { actor_store_id: 3, resource_store_id: 9 };
  assert.equal(can('seller_owner', 'view_order', own), true);
  assert.equal(can('seller_owner', 'view_order', other), false);
  assert.equal(can('seller_staff', 'update_fulfilment', own), true);
  assert.equal(can('seller_staff', 'update_fulfilment', other), false);
  // A seller with no store cannot act on a store resource.
  assert.equal(can('seller_owner', 'view_order', { actor_store_id: null, resource_store_id: 3 }), false);
});

test('support agents can read any order; finance is amounts-only (FR-SHP-03 AC)', () => {
  assert.equal(can('support_agent', 'view_order', { actor_id: 1, owner_id: 999 }), true);
  assert.equal(can('finance', 'view_order', {}), true);
  assert.equal(permissionScope('finance', 'view_order'), 'amounts_only', 'finance read must be flagged amounts-only for redaction');
});

test('approve_refund for a seller is own-store AND under the limit', () => {
  assert.equal(can('seller_owner', 'approve_refund', { actor_store_id: 2, resource_store_id: 2, amount: 500, limit: 1000 }), true);
  assert.equal(can('seller_owner', 'approve_refund', { actor_store_id: 2, resource_store_id: 2, amount: 1500, limit: 1000 }), false);
  assert.equal(can('seller_owner', 'approve_refund', { actor_store_id: 2, resource_store_id: 9, amount: 100, limit: 1000 }), false);
  assert.equal(can('support_agent', 'approve_refund', {}), true);
});

test('role-exclusive actions are denied to the wrong roles', () => {
  assert.equal(can('customer', 'approve_product', {}), false);
  assert.equal(can('seller_owner', 'approve_seller', {}), false);
  assert.equal(can('support_agent', 'approve_payout', {}), false);
  assert.equal(can('finance', 'manage_users', {}), false);
  assert.equal(can('finance', 'approve_payout', {}), true);
  assert.equal(can('customer', 'cart_checkout', { actor_id: 5, owner_id: 5 }), true);
  assert.equal(can('seller_staff', 'cart_checkout', { actor_id: 5, owner_id: 5 }), false);
});

test('unknown role or action is a safe deny, never a throw', () => {
  assert.equal(can('root', 'view_order', {}), false);
  assert.equal(can('admin', 'launch_missiles', {}), false);
  assert.equal(can(undefined, undefined, undefined), false);
});

test('finance order view requires redaction; others do not', () => {
  assert.equal(requiresRedaction('finance', 'view_order'), true);
  assert.equal(requiresRedaction('support_agent', 'view_order'), false);
  assert.equal(requiresRedaction('admin', 'view_order'), false);
});

test('permissionScope is role-guarded (unknown role is undefined, not a rule)', () => {
  assert.equal(permissionScope('root', 'view_order'), undefined);
  assert.equal(permissionScope('customer', 'view_order'), 'own');
});
