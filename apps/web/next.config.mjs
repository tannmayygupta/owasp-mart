// Same-origin API path (architecture 03, section 1): the browser only talks to this
// origin; the Next.js server forwards /api/* to the API unchanged (the prefix stays, so
// /api/v1/health reaches the API's /api/v1/health, as the bundle contracts/api/bundle says).
// Locally the API is the Compose service "api". Story 1.7 adds the origin-secret header and security headers.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://api:8000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16 blocks dev resources (hot reload) for any origin but localhost. The stack is opened as
  // http://127.0.0.1:3000 (ports are bound to loopback), so allow that host. Dev server only.
  allowedDevOrigins: ['127.0.0.1'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
