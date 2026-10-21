#!/usr/bin/env node
// Read-only verification of a deployed platform (story P-32, NFR-SEC-01, NFR-SEC-03): it creates no account and changes nothing.
//   node scripts/verify-deployed.mjs --base https://tanmay-platform-prod.duckdns.org [--bundle contracts/api/bundle/openapi.json] [--json] [--platform-env <the .env of the platform stack>]
// Checks: the public health route; the page security headers (a nonce CSP with frame-ancestors 'none', HSTS on https, nosniff, Referrer-Policy, no X-Powered-By);
// http redirects to https; an unknown route is an IF-8 problem with a request id and no stack trace; a cross-site POST is refused (AUTH-ORIGIN-FORBIDDEN);
// every dashboards page is served by the dashboards app (the learner console owns `/` and keeps its strict CSP, ADR 0074); with --platform-env <the staged .env> the mail provider is not the catcher; and every operation of the platform contract without a path parameter EXISTS on the deployed site (answered without a
// session, it must not be 404: a 404 means the deploy is older than the contract). Exit code 0 when every check passes, 1 otherwise, 2 for bad arguments.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Operations the contract declares but marks PENDING and the API does not serve on purpose (createLiveTicket waits for the spike S-14).
export const PENDING = new Set(['createLiveTicket']);
export const PAGES = ['/login', '/signup', '/verify-email', '/forgot-password', '/reset-password', '/confirm-email-change', '/account', '/dashboard', '/invite', '/company',
  '/company/candidates', '/admin'];

export function parseArgs(argv) {
  const out = { base: null, platformEnv: null, bundle: path.join(ROOT, 'contracts', 'api', 'bundle', 'openapi.json'), json: false, timeout: 15000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--platform-env') out.platformEnv = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]) * 1000;
    else if (a === '--help') return { help: true };
    else return { error: `unknown argument ${a}` };
  }
  if (!out.base || !/^https?:\/\/[^/]+$/.test(out.base)) return { error: '--base must be an origin such as https://example.org (no path)' };
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return { error: '--timeout must be seconds' };
  return out;
}

/** The platform operations a client can call with no path parameter: [method, path, operationId, public]. */
export function platformOperations(bundle) {
  const ops = [];
  for (const [p, item] of Object.entries(bundle.paths)) {
    if (p.includes('{')) continue;
    for (const [m, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || !op.operationId) continue;
      const lab = (op.tags ?? []).some((t) => ['instances', 'attempts', 'flags', 'hints', 'results', 'catalogue'].includes(t));
      ops.push({ method: m.toUpperCase(), path: p, id: op.operationId, public: Array.isArray(op.security) && op.security.length === 0, lab });
    }
  }
  return ops;
}

/** The mail provider of the deployed stack from its `.env` text: `ok` is false when mail would go to the catcher (provider smtp, the catcher allowed, or the catcher profile on). */
export function mailProviderCheck(envText) {
  const env = Object.fromEntries(String(envText).split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  const provider = env.VULNMART_EMAIL_PROVIDER ?? 'brevo'; // the compose default
  const catcher = provider === 'smtp' || env.VULNMART_ALLOW_MAIL_CATCHER === 'true' || /(^|,)mail-catcher(,|$)/.test(env.COMPOSE_PROFILES ?? '');
  return { ok: !catcher, detail: `provider ${provider}${catcher ? ', the mail catcher is active: no e-mail reaches anyone' : ''}` };
}

export async function verify({ base, bundle, timeout = 15000, fetchImpl = fetch, platformEnv = null }) {
  const results = [];
  const add = (ok, name, detail = '') => results.push({ ok, name, detail });
  const get = (url, init = {}) => fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), ...init });

  // 1. health
  try {
    const r = await get(`${base}/api/v1/health`);
    const body = await r.json().catch(() => ({}));
    add(r.status === 200 && body.status === 'ok', 'health is ok', `${r.status} ${JSON.stringify(body)}`);
  } catch (e) {
    add(false, 'health is ok', `unreachable: ${e.message}`);
    return results; // nothing else can be checked
  }
  // 2. page headers: the dashboards set a nonce CSP (Next.js, per request); the console at / keeps the strict static CSP
  const page = await get(`${base}/login`);
  const h = (n) => page.headers.get(n) ?? '';
  add(/'nonce-[A-Za-z0-9+/=]+'/.test(h('content-security-policy')), 'pages carry a nonce CSP', h('content-security-policy').slice(0, 120));
  add(/frame-ancestors 'none'/.test(h('content-security-policy')), "the CSP forbids framing (frame-ancestors 'none')");
  add(h('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff', h('x-content-type-options'));
  add(h('referrer-policy') !== '', 'a Referrer-Policy is set', h('referrer-policy'));
  add(h('x-powered-by') === '', 'no X-Powered-By header', h('x-powered-by'));
  const consolePage = await get(`${base}/`);
  const consoleCsp = consolePage.headers.get('content-security-policy') ?? '';
  const consoleHtml = await consolePage.text().catch(() => '');
  add(consolePage.status === 200 && !consoleHtml.includes('/_next/') && /style-src 'self'(;|$)/.test(consoleCsp) && !/nonce-|unsafe-inline/.test(consoleCsp),
    'the learner console at / keeps the strict CSP (style-src self, no nonce)', `${consolePage.status} ${consoleCsp.slice(0, 80)}`);
  if (platformEnv !== null) {
    const mail = mailProviderCheck(platformEnv);
    add(mail.ok, 'the mail provider is not the catcher (real e-mail is sent)', mail.detail);
  }
  if (base.startsWith('https://')) {
    add(/max-age=\d+/.test(h('strict-transport-security')), 'HSTS is set', h('strict-transport-security'));
    try {
      const plain = await get(base.replace('https://', 'http://') + '/');
      add([301, 302, 307, 308].includes(plain.status) && (plain.headers.get('location') ?? '').startsWith('https://'), 'http redirects to https',
        `${plain.status} ${plain.headers.get('location') ?? ''}`);
    } catch (e) {
      add(false, 'http redirects to https', e.message);
    }
  }
  // 3. errors: an IF-8 problem with a request id, no stack trace
  const unknown = await get(`${base}/api/v1/no-such-route-${Date.now()}`);
  const problem = await unknown.json().catch(() => ({}));
  add(unknown.status === 404 && problem.code === 'REQ-ROUTE-UNKNOWN' && typeof problem.request_id === 'string' && !/Traceback|at .*\(.*:\d+/.test(JSON.stringify(problem)),
    'an unknown route is an IF-8 problem with a request id and no stack trace', `${unknown.status} ${problem.code ?? ''}`);
  // 4. a cross-site form post is refused (NFR-SEC-03)
  const forged = await get(`${base}/api/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'nobody@example.org', password: 'not a real password 123' }) });
  const forgedBody = await forged.json().catch(() => ({}));
  add(forged.status === 403 && forgedBody.code === 'AUTH-ORIGIN-FORBIDDEN', 'a cross-site POST is refused (AUTH-ORIGIN-FORBIDDEN)', `${forged.status} ${forgedBody.code ?? ''}`);
  // 5. pages
  // a 200 alone is not enough (a static catch-all answers every path): the page must be the dashboards app (Next.js serves its scripts from /_next/)
  for (const p of PAGES) {
    const r = await get(`${base}${p}`);
    const html = await r.text().catch(() => '');
    add(r.status === 200 && html.includes('/_next/'), `page ${p} is the dashboards app`, r.status !== 200 ? String(r.status) : html.includes('/_next/') ? '' : 'another page is served (no /_next/ assets)');
  }
  // 6. every platform operation exists on the deployed site
  for (const op of platformOperations(bundle)) {
    if (op.public || op.lab || PENDING.has(op.id)) continue; // public routes may change state or need a body; the lab's routes are stream L's (L-30)
    const init = op.method === 'GET' ? {} : { method: op.method, headers: { 'content-type': 'application/json', origin: base }, body: '{}' };
    const r = await get(`${base}${op.path}`, init);
    add(r.status !== 404, `${op.method} ${op.path} (${op.id}) exists`, r.status === 404 ? '404: the deploy is older than the contract' : String(r.status));
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/verify-deployed.mjs --base https://host [--bundle path] [--json] [--timeout seconds] [--platform-env path-of-the-staged-.env]');
    return 0;
  }
  if (args.error) {
    console.error(args.error);
    return 2;
  }
  const bundle = JSON.parse(readFileSync(args.bundle, 'utf8'));
  const platformEnv = args.platformEnv ? readFileSync(args.platformEnv, 'utf8') : null;
  const results = await verify({ base: args.base, bundle, timeout: args.timeout, platformEnv });
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`SUMMARY: ${results.length - failed} PASS, ${failed} FAIL against ${args.base}`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
