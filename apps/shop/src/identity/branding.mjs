// Neutral marketplace identity for the shop (T-07, FR-SHP-01). A believable,
// everyday-marketplace look: a neutral name and palette, never a hacker theme.
// The server-rendered pages that use this come in T-14.
export const BRANDING = Object.freeze({
  name: 'VulnMart',
  tagline: 'Everyday marketplace',
  theme: 'neutral', // not a hacker theme (FR-SHP-01 AC)
  areas: Object.freeze(['shop', 'account', 'seller', 'support', 'finance', 'admin']),
});
