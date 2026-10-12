// The dashboards' proxy (Next.js 16 "proxy", formerly middleware), the local form of the browser path of
// architecture 03: the browser only ever talks to this origin.
//   /api/*  -> rewritten to API_ORIGIN with the same path, `x-origin-secret` added (the shape of the production
//              Vercel rewrite with its header transform, LE-3), answered with no-store.
//   pages   -> a fresh CSP nonce per request, the CSP and no-store headers; the layout reads the nonce.
// The fixed headers (nosniff, Referrer-Policy, ...) come from next.config.mjs so static files carry them too.
import { NextResponse, type NextRequest } from 'next/server';
import { DROPPED_FROM_BROWSER, NO_STORE, buildCsp, makeNonce, upstreamHeaders, upstreamUrl } from './lib/security.mjs';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://api:8000';
// Server-side only (never NEXT_PUBLIC_*): the browser never sees it.
const ORIGIN_SECRET = process.env.ORIGIN_SECRET ?? '';
const DEV = process.env.NODE_ENV === 'development';

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const https = request.nextUrl.protocol === 'https:';

  if (pathname.startsWith('/api/')) {
    const headers = upstreamHeaders(request.headers, {
      secret: ORIGIN_SECRET,
      host: request.headers.get('host') ?? undefined,
      proto: https ? 'https' : 'http',
    });
    const response = NextResponse.rewrite(upstreamUrl(API_ORIGIN, pathname, search), { request: { headers } });
    response.headers.set('Cache-Control', NO_STORE);
    return response;
  }

  const nonce = makeNonce();
  const csp = buildCsp({ nonce, dev: DEV, https });
  const headers = new Headers(request.headers);
  for (const name of DROPPED_FROM_BROWSER) headers.delete(name);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp); // Next.js reads the nonce from here for its own scripts
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', NO_STORE);
  return response;
}

export const config = {
  // Everything except the static build files and the icon (they need neither a nonce nor the API).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
