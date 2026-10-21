// Where to go after signing in (story P-26): a same-origin path only. Anything that could leave the site (another origin, a protocol-relative `//host`,
// a backslash form that some browsers read as `//`, or a control character) falls back to the dashboard, so `?next=` cannot become an open redirect.
const CONTROL = /[\u0000-\u001f\u007f]/;

export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || CONTROL.test(raw)) return '/dashboard';
  return raw;
}

/** Where a visitor lands after signing in: where they came from (`next`, same-origin only), else the home of their kind of account. A learner's home is the lab console at `/`
 *  (the practice lab with its countdown); a recruiter and an administrator work in the dashboards. */
export function afterSignIn(raw: string | null, accountType: string | undefined): string {
  if (raw && safeNext(raw) === raw) return raw; // a valid same-origin path the visitor came from
  return accountType === 'participant' ? '/' : '/dashboard';
}
