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
  // Next compresses answers with gzip by default and holds back small chunks, which stops the live stream (`/api/v1/live`, Server-Sent Events, story P-22) from
  // reaching the browser until the compressor has enough to send: the first frame never arrives. The stream must not be compressed by this proxy (FR-LIV-02: no
  // buffering on the stream route); the API compresses nothing, and the production front (Vercel, Caddy) does its own compression.
  compress: false,
  async headers() {
    const fixed = Object.entries(fixedHeaders({ https: HTTPS })).map(([key, value]) => ({ key, value }));
    return [{ source: '/:path*', headers: fixed }];
  },
};

export default nextConfig;
