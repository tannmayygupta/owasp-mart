// Length caps for free text that a customer, a seller or an agent types (deferred work of the shop review, PR #14: field length limits). The DB columns are TEXT, so the
// service layer is the only place that can refuse an oversized value. Every cap is far above any honest use and far below a value that could bloat a row or a page.
import { ValidationError } from './shop-service.mjs'; // a cycle with shop-service.mjs is fine: the class is only used inside the functions, never at load

export const LIMITS = Object.freeze({
  address_line: 200, // ship line1, city, country
  order_note: 2000, // the buyer note of an order
  ticket_subject: 120, // the support form already says maxlength 120
  ticket_body: 2000, // challenge spec 3.2: a ticket message is at most 2 KB
  review_body: 2000,
  reason: 1000, // refund and dispute reasons
  reply_body: 2000, // a staff reply to a ticket
});

/** A trimmed string within `max` characters. `required` refuses an empty value. Never truncates silently: too long is a 400. */
export function capText(field, value, max, { required = false } = {}) {
  const s = value == null ? '' : String(value);
  if (required && !s.trim()) throw new ValidationError(`${field} is required`);
  if (s.length > max) throw new ValidationError(`${field} is too long (at most ${max} characters)`);
  return s;
}

/** The three lines of a shipping address, each within the cap. */
export function capShip(ship = {}) {
  return {
    line1: capText('address', ship.line1, LIMITS.address_line, { required: true }),
    city: capText('city', ship.city, LIMITS.address_line, { required: true }),
    country: capText('country', ship.country, LIMITS.address_line, { required: true }),
  };
}

/** limit and offset for a list query: a whole number of rows from 1 to `max` (default `def`), and an offset that is never negative. */
export function pageArgs({ limit, offset } = {}, def = 100, max = 500) {
  const l = Number(limit);
  const o = Number(offset);
  return {
    limit: Number.isInteger(l) && l >= 1 ? Math.min(l, max) : def,
    offset: Number.isInteger(o) && o >= 0 ? Math.min(o, 1_000_000) : 0,
  };
}