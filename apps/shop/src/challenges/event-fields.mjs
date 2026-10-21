// Field helpers for the app events the shop posts (IF-4, contracts/events/instance-events.posted.schema.json).
//
// The sidecar refuses a posted event whose data does not fit the contract, so a value that came from a player (an order number in a webhook, a path) must be made to fit
// before it is put in an event. These helpers do that and nothing else; they never decide whether the event is sent.

/** An `id` of the contract: letters, digits and _ . - only, 1 to 64 characters. Anything else becomes `_`; an empty value becomes `unknown`. */
export function safeId(value) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return text || 'unknown';
}

/** A `class` of the contract: lower-case letters, digits and _ , 1 to 32 characters. */
export function safeClass(value) {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  return text || 'unknown';
}

/** A whole number of the contract (`count`): never negative, never fractional. */
export function safeCount(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
