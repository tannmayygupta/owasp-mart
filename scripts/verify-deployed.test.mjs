// Story P-32: the deployed-verification script against a local stand-in server: a current deploy passes, a stale one (a route of the contract answers 404) and
// missing security headers fail, and bad arguments are refused.
//   node --test scripts/verify-deployed.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { PAGES, mailProviderCheck, parseArgs, platformOperations, verify } from './verify-deployed.mjs';

const BUNDLE = { paths: {
  '/api/v1/health': { get: { operationId: 'getHealth', tags: ['health'], security: [] } },
  '/api/v1/me/invites': { get: { operationId: 'listMyInvites', tags: ['invites'] } },
  '/api/v1/company/exports': { post: { operationId: 'exportCompanyResults', tags: ['exports'] } },
  '/api/v1/me/attempts': { get: { operationId: 'listMyAttempts', tags: ['attempts'] } },
  '/api/v1/live/ticket': { post: { operationId: 'createLiveTicket', tags: ['live'] } },
  '/api/v1/attempts/{attempt_id}': { get: { operationId: 'getAttempt', tags: ['attempts'] } },
} };

function stand_in({ missing = [], headers = true, console_page = false } = {}) {
  return createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/v1/health') return json(200, { status: 'ok' });
    if (req.url === '/api/v1/session' && req.headers.origin === 'https://evil.example') return json(403, { code: 'AUTH-ORIGIN-FORBIDDEN', request_id: 'req-1' });
    if (req.url === '/') {
      const csp = headers ? { 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'" } : {};
      res.writeHead(200, { 'content-type': 'text/html', ...csp });
      return res.end('<html><title>VulnMart lab console</title><script src="/app.js"></script></html>');
    }
    if (PAGES.includes(req.url)) {
      const h = { 'content-type': 'text/html' };
      if (headers) Object.assign(h, { 'content-security-policy': "script-src 'nonce-abc123=' 'strict-dynamic'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.writeHead(200, h);
      return res.end(console_page ? '<html><title>lab console</title></html>' : '<html><script src="/_next/static/chunks/main.js"></script></html>');
    }
    if (['/api/v1/me/invites', '/api/v1/company/exports'].includes(req.url) && !missing.includes(req.url)) return json(401, { code: 'AUTH-SESSION-REQUIRED', request_id: 'req-2' });
    return json(404, { code: 'REQ-ROUTE-UNKNOWN', request_id: 'req-3' });
  });
}

async function run(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await verify({ base: `http://127.0.0.1:${server.address().port}`, bundle: BUNDLE, timeout: 5000 });
  } finally {
    server.close();
  }
}

test('the operations to check leave out public, lab and pending routes and those with a path parameter', () => {
  const ops = platformOperations(BUNDLE).filter((o) => !o.public && !o.lab).map((o) => o.id);
  assert.deepEqual(ops.sort(), ['createLiveTicket', 'exportCompanyResults', 'listMyInvites']);
});

test('a current deploy passes every check', async () => {
  const results = await run(stand_in());
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.ok(results.some((r) => r.name.includes('listMyInvites')) && !results.some((r) => r.name.includes('createLiveTicket')));
});

test('a stale deploy (a contract route answers 404) and missing headers fail', async () => {
  const results = await run(stand_in({ missing: ['/api/v1/me/invites'], headers: false }));
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(failed.some((n) => n.includes('listMyInvites')), failed.join(' | '));
  assert.ok(failed.includes('pages carry a nonce CSP') && failed.includes('X-Content-Type-Options: nosniff'));
  assert.ok(!failed.some((n) => n.includes('exportCompanyResults')));
});

test('a site that serves another page on every path fails the page checks', async () => {
  const failed = (await run(stand_in({ console_page: true }))).filter((r) => !r.ok).map((r) => r.name);
  assert.ok(failed.includes('page /login is the dashboards app') && failed.includes('page /admin is the dashboards app'), failed.join(' | '));
});

test('bad arguments are refused', () => {
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(['--base', 'https://example.org/path']).error);
  assert.ok(parseArgs(['--base', 'https://example.org', '--what']).error);
  assert.equal(parseArgs(['--base', 'https://example.org']).base, 'https://example.org');
});

test('the learner console at / must keep its strict CSP and must not be the dashboards app', async () => {
  const stale = (await run(stand_in({ headers: false }))).filter((r) => !r.ok).map((r) => r.name);
  assert.ok(stale.includes('the learner console at / keeps the strict CSP (style-src self, no nonce)'), stale.join(' | '));
});

test('the mail provider check: brevo passes, the catcher in any form fails', async () => {
  assert.equal(mailProviderCheck('VULNMART_EMAIL_PROVIDER=brevo\nVULNMART_ALLOW_MAIL_CATCHER=false\n').ok, true);
  assert.equal(mailProviderCheck('VULNMART_PLATFORM_HOST=h\n').ok, true, 'the compose default is brevo');
  assert.equal(mailProviderCheck('VULNMART_EMAIL_PROVIDER=smtp\n').ok, false);
  assert.equal(mailProviderCheck('VULNMART_EMAIL_PROVIDER=brevo\nVULNMART_ALLOW_MAIL_CATCHER=true\n').ok, false);
  assert.equal(mailProviderCheck('COMPOSE_PROFILES=mail-catcher\r\n').ok, false);
  const withEnv = async (platformEnv) => {
    const server = stand_in();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { return (await verify({ base: `http://127.0.0.1:${server.address().port}`, bundle: BUNDLE, timeout: 5000, platformEnv })).find((r) => r.name.startsWith('the mail provider')); } finally { server.close(); }
  };
  assert.equal((await withEnv('VULNMART_EMAIL_PROVIDER=brevo\n')).ok, true);
  assert.equal((await withEnv('VULNMART_EMAIL_PROVIDER=smtp\n')).ok, false);
  assert.equal(await (async () => { const server = stand_in(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); try { return (await verify({ base: `http://127.0.0.1:${server.address().port}`, bundle: BUNDLE, timeout: 5000 })).some((r) => r.name.startsWith('the mail provider')); } finally { server.close(); } })(), false, 'without --platform-env the check is not run');
  assert.equal(parseArgs(['--base', 'https://example.org', '--platform-env', 'x.env']).platformEnv, 'x.env');
});
