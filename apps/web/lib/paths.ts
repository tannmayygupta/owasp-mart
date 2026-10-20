// Where to go after signing in (story P-26): a same-origin path only. Anything that could leave the site (another origin, a protocol-relative `//host`,
// a backslash form that some browsers read as `//`, or a control character) falls back to the dashboard, so `?next=` cannot become an open redirect.
const CONTROL = /[\u0000-\u001f\u007f]/;

export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || CONTROL.test(raw)) return '/dashboard';
  return raw;
}
