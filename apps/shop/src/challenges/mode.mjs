// Challenge build mode (T-19+). Every OWASP challenge is one isolated path that
// is only exploitable in the "vulnerable" build; the default is "fixed" (the
// correct behaviour) so a shop run without an explicit challenge setting is safe.
// The mode comes from an explicit override map (used by tests and by the instance
// injector) or, failing that, the environment: VM_CHALLENGE_<KEY>=vulnerable, or
// VM_CHALLENGE_MODE=vulnerable to turn every challenge on at once. Anything else
// — including unset — is "fixed".
export function resolveMode(key, overrides = {}, env = process.env) {
  const fromOverride = overrides?.[key];
  const raw = (fromOverride ?? env[`VM_CHALLENGE_${key}`] ?? env.VM_CHALLENGE_MODE ?? 'fixed');
  return String(raw).toLowerCase() === 'vulnerable' ? 'vulnerable' : 'fixed';
}

export function isVulnerable(key, overrides = {}, env = process.env) {
  return resolveMode(key, overrides, env) === 'vulnerable';
}
