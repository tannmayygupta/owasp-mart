// Same-origin API path (architecture 03, section 1): the browser only talks to this origin. The forwarding of
// /api/* to the API (with the origin secret) and the per-request CSP live in proxy.ts (story 1.7). This file adds the
// fixed security headers to every answer, static files included.
import { fixedHeaders } from './lib/security.mjs';

const HTTPS = (process.env.DASHBOARD_ORIGIN ?? '').startsWith('https://');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16 blocks dev resources (hot reload) for any origin but localhost. The stack is opened as
  // http://127.0.0.1:3000 (ports are bound to loopback), so allow that host. Dev server only.
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  async headers() {
    const fixed = Object.entries(fixedHeaders({ https: HTTPS })).map(([key, value]) => ({ key, value }));
    return [{ source: '/:path*', headers: fixed }];
  },
};

export default nextConfig;
