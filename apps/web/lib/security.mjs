// Security rules of the dashboards' origin (architecture 03 section 1, 06 section 7, NFR-SEC-03), kept free of any
// Next.js import so the unit tests in apps/web/test run with plain Node in CI. proxy.ts applies them.
//
// - Every page gets a nonce-based Content-Security-Policy (a fresh nonce per request, 'strict-dynamic', no inline
//   script) and the fixed headers below. The development server alone adds what hot reload needs.
// - Every /api/* request is forwarded to the API with `x-origin-secret` (the browser's own value is dropped), the
//   forwarded host and protocol, and the browser's cookies and request id unchanged.
// - Pages and API answers are never cached: `Cache-Control: private, no-store`.

export const ORIGIN_SECRET_HEADER = 'x-origin-secret';
export const NO_STORE = 'private, no-store';

/** A fresh, unguessable nonce (128 random bits, base64). */
export function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The Content-Security-Policy of a page.
 * @param {{ nonce: string, dev?: boolean, https?: boolean }} options
 */
export function buildCsp({ nonce, dev = false, https = false }) {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error('a CSP nonce is base64, 16 characters or more');
  const directives = [
    "default-src 'self'",
    // React uses eval only in development (Next.js CSP guide); production never allows it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // The development overlay injects style elements without a nonce; production styles carry the nonce.
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Same origin only: the browser talks to this origin and nothing else (architecture 03). Hot reload needs its socket.
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/**
 * The fixed security headers of every answer of this origin (pages, static files, API answers).
 * @param {{ https?: boolean }} options
 * @returns {Record<string, string>}
 */
export function fixedHeaders({ https = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  // HSTS means something only over HTTPS; on http://127.0.0.1 a browser ignores it, so it is sent in production only.
  if (https) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return headers;
}

// Headers a browser could forge that the API trusts only from the edge: the secret, and the client address
// (architecture 03 rule 4: x-forwarded-for counts only when the secret is valid). They are always dropped; the proxy sets
// the secret itself, and the client address comes from the production edge (Vercel), never from the browser.
export const DROPPED_FROM_BROWSER = ['x-origin-secret', 'x-forwarded-for', 'x-real-ip', 'forwarded'];

/**
 * The headers of a request forwarded to the API: everything the browser sent (cookies, request id, content type),
 * without the headers of DROPPED_FROM_BROWSER, plus the real secret and the forwarded host and protocol.
 * @param {Headers} incoming
 * @param {{ secret?: string, host?: string, proto?: string }} options
 * @returns {Headers}
 */
export function upstreamHeaders(incoming, { secret, host, proto } = {}) {
  const out = new Headers(incoming);
  for (const name of DROPPED_FROM_BROWSER) out.delete(name);
  if (secret) out.set(ORIGIN_SECRET_HEADER, secret);
  if (host) out.set('x-forwarded-host', host);
  if (proto) out.set('x-forwarded-proto', proto);
  return out;
}

/** The API path a browser path maps to: the same path and query on the API origin (the /api prefix is kept). */
export function upstreamUrl(apiOrigin, pathname, search = '') {
  if (!pathname.startsWith('/api/')) throw new Error('only /api/* is forwarded');
  const base = new URL(apiOrigin);
  if (base.pathname !== '/' || base.search) throw new Error('API_ORIGIN is an origin, without a path');
  return new URL(pathname + search, base);
}
