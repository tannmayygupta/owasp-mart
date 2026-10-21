// A throttle for the WEB login (deferred work of the shop review: login throttling). The per-account lockout (c09-logging-failures.mjs: five failures in five minutes lock the
// account) cannot stop password spraying across many accounts or guessing at emails that do not exist, because those failures have no account to lock. This counts failures per
// SOURCE and refuses further attempts from a source that has failed too often. Only failures count, so a customer who signs in correctly is never held back by it.
//
// In memory and per process: one shop process serves one instance, and a restart clears it (the same as the lockout window). Bounded: it never tracks more than MAX_SOURCES.
// It guards the web login only. The legacy mobile route is the C09 weakness (the vulnerable build has no lockout and no rate limit there, by design) and the password-reset
// confirm route is the C07 weakness; neither calls this.
const MAX_SOURCES = 5000;

export function createLoginThrottle({ max = 30, windowMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const failures = new Map(); // source -> timestamps (ms) of recent failed attempts
  const recent = (source, t) => (failures.get(source) ?? []).filter((x) => t - x < windowMs);
  return {
    /** True when this source has failed `max` times or more inside the window. */
    blocked(source) {
      const t = now();
      const list = recent(source, t);
      if (list.length) failures.set(source, list); else failures.delete(source);
      return list.length >= max;
    },
    /** Record one failed attempt from this source. */
    fail(source) {
      const t = now();
      const list = recent(source, t);
      list.push(t);
      failures.delete(source); // re-insert last, so the oldest sources are the first dropped
      failures.set(source, list);
      while (failures.size > MAX_SOURCES) failures.delete(failures.keys().next().value);
    },
    get size() { return failures.size; },
  };
}