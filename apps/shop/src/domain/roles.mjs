// The six shop roles (T-07, FR-SHP-03). These match the users.role CHECK in
// migrations/0001_init.sql.
export const ROLES = Object.freeze([
  'customer',
  'seller_owner',
  'seller_staff',
  'support_agent',
  'finance',
  'admin',
]);

export const SELLER_ROLES = Object.freeze(['seller_owner', 'seller_staff']);

export function isRole(role) {
  return ROLES.includes(role);
}

export function isSellerRole(role) {
  return SELLER_ROLES.includes(role);
}
