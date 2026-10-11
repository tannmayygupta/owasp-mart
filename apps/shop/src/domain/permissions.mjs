// The six-role permission matrix (T-07, FR-SHP-03) from RS-G 1.2. This is the
// CORRECT matrix with real store/owner scoping; the deliberate gaps challenges
// rely on (e.g. C01's missing store check) are added later as isolated paths,
// never here.
//
// `can(role, action, ctx)` is the decision function the flow stories (T-14,
// T-15) call before acting. Rule vocabulary per cell:
//   true               allowed, unscoped
//   'own'              ctx.owner_id === ctx.actor_id
//   'own_store'        ctx.actor_store_id === ctx.resource_store_id (actor has a store)
//   'own_store_under_limit'  own_store AND ctx.amount <= ctx.limit
//   'amounts_only'     allowed, but the caller must redact personal data (finance)
//   (absent)           denied
// Finer parenthetical rules in RS-G (staff "no price change", cancel "before
// shipped", review "own purchased") are state checks enforced by the flow, not
// by this decision function.
import { isRole } from './roles.mjs';

const MATRIX = {
  view_catalog: { customer: true, seller_owner: true, seller_staff: true, support_agent: true, admin: true },
  create_edit_product: { seller_owner: 'own_store', seller_staff: 'own_store', admin: true },
  approve_product: { admin: true },
  cart_checkout: { customer: 'own', seller_owner: 'own' },
  view_order: { customer: 'own', seller_owner: 'own_store', seller_staff: 'own_store', support_agent: true, finance: 'amounts_only', admin: true },
  update_fulfilment: { seller_owner: 'own_store', seller_staff: 'own_store', admin: true },
  cancel_order: { customer: 'own', seller_owner: 'own_store', support_agent: true, admin: true },
  request_refund: { customer: 'own', support_agent: true },
  approve_refund: { seller_owner: 'own_store_under_limit', support_agent: true, admin: true },
  open_dispute: { customer: 'own', support_agent: true },
  resolve_dispute: { support_agent: true, admin: true },
  write_review: { customer: 'own' },
  report_review: { customer: true, seller_owner: true, seller_staff: true, support_agent: true, admin: true },
  moderate_review: { support_agent: true, admin: true },
  create_ticket: { customer: true, seller_owner: true, seller_staff: true, support_agent: true, admin: true },
  manage_tickets: { support_agent: true, admin: true },
  manage_staff: { seller_owner: 'own_store', admin: true },
  approve_seller: { admin: true },
  manage_coupons: { seller_owner: 'own_store', admin: true },
  view_payouts: { seller_owner: 'own_store', finance: true, admin: true },
  approve_payout: { finance: true, admin: true },
  hold_payout: { admin: true },
  propose_commission: { finance: true },
  set_commission: { admin: true },
  manage_users: { admin: true },
  view_audit_log: { admin: true },
  upload_product_image: { seller_owner: 'own_store', seller_staff: 'own_store', admin: true },
};

export const ACTIONS = Object.freeze(Object.keys(MATRIX));

// The raw matrix rule for a (role, action), or undefined when denied.
// DIAGNOSTIC ONLY: use this to learn the scope (e.g. 'amounts_only' to redact,
// 'own_store' to filter a query) AFTER `can()` has allowed the action. It is
// NOT an authorization gate — a scoped rule like 'own' is truthy here but still
// requires the ctx check that `can()` performs. Gating on this truthiness would
// bypass scoping.
export function permissionScope(role, action) {
  if (!isRole(role)) return undefined;
  return MATRIX[action]?.[role];
}

// Whether a role's allowed access to an action must redact personal data
// (finance's amounts-only order view, FR-SHP-03 AC). The flow (T-15) calls this
// and strips names/addresses before returning the row.
export function requiresRedaction(role, action) {
  return permissionScope(role, action) === 'amounts_only';
}

function resolve(rule, ctx) {
  switch (rule) {
    case true:
      return true;
    case 'own':
      return ctx.owner_id != null && ctx.owner_id === ctx.actor_id;
    case 'own_store':
      return ctx.actor_store_id != null && ctx.actor_store_id === ctx.resource_store_id;
    case 'own_store_under_limit':
      return (
        ctx.actor_store_id != null &&
        ctx.actor_store_id === ctx.resource_store_id &&
        typeof ctx.amount === 'number' &&
        typeof ctx.limit === 'number' &&
        ctx.amount <= ctx.limit
      );
    case 'amounts_only':
      return true; // allowed; personal data redaction is the caller's job
    default:
      return false; // unknown rule => safe deny
  }
}

// Decide whether `role` may do `action` in `ctx`. Safe default deny: an unknown
// role, unknown action, or missing scope context returns false, never throws.
export function can(role, action, ctx = {}) {
  if (!isRole(role)) return false;
  const rule = MATRIX[action]?.[role];
  if (rule === undefined) return false;
  return resolve(rule, ctx);
}
