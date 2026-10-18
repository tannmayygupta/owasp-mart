// Read-only smoke check of the deployed site for the live demo (story 8.6, L-30). Sends GET requests only, to URLs
// given by environment variables, and prints PASS / FAIL lines. It changes nothing and sends no secret.
//
//   $env:SMOKE_BASE_URL = "https://<site>"        required: the dashboards origin (the same-origin proxy of /api/*)
//   $env:SMOKE_HEALTH_PATH  = "/api/v1/health"     default /api/v1/health
//   $env:SMOKE_VERSION_PATH = "/api/v1/version"    optional: if set, must answer 200 with a non-empty body
//   $env:SMOKE_EXPECT_VERSION = "<text>"           optional: the version answer must contain this text
//   $env:SMOKE_EXTRA_URLS = "https://a/healthz,https://b/"   optional: more URLs that must answer 200
//   node scripts/live-smoke.mjs
//
// Header rules on every checked URL: x-content-type-options must be nosniff; x-origin-secret and x-powered-by must not
// appear (the origin secret must never reach a browser); on https the strict-transport-security header is required.
// Run it against a local server first (scripts/live-smoke.test.mjs); the real run is a runbook step
// (docs/runbooks/demo-19-oct.md) and its result is the developer's.
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTable } from './demo.mjs';

export const REQUIRED_HEADERS = { 'x-content-type-options': /^nosniff$/i };
export const FORBIDDEN_HEADERS = ['x-origin-secret', 'x-powered-by'];

// ---------- pure parts ----------
export function configFromEnv(env) {
  const base = (env.SMOKE_BASE_URL ?? '').trim();
  if (!base) return { error: 'SMOKE_BASE_URL is not set (the dashboards origin, for example https://<site>)' };
  let u;
  try {
    u = new URL(base);
  } catch {
    return { error: 'SMOKE_BASE_URL is not a valid URL' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'SMOKE_BASE_URL must be http or https' };
  const extra = (env.SMOKE_EXTRA_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of extra) {
    try {
      if (!['http:', 'https:'].includes(new URL(e).protocol)) return { error: `SMOKE_EXTRA_URLS entry is not http or https: ${e}` };
    } catch {
      return { error: `SMOKE_EXTRA_URLS entry is not a valid URL: ${e}` };
    }
  }
  return {
    base: u.origin,
    healthPath: env.SMOKE_HEALTH_PATH || '/api/v1/health',
    versionPath: env.SMOKE_VERSION_PATH || null,
    expectVersion: env.SMOKE_EXPECT_VERSION || null,
    extra,
  };
}

// headers: a lower-case name to value map (node's res.headers). Returns a list of problems (empty = fine).
export function headerProblems(headers, url) {
  const out = [];
  for (const [h, re] of Object.entries(REQUIRED_HEADERS)) {
    const v = headers[h];
    if (v === undefined) out.push(`missing header ${h}`);
    else if (!re.test(String(v))) out.push(`header ${h} has the wrong value`);
  }
  for (const h of FORBIDDEN_HEADERS) if (headers[h] !== undefined) out.push(`forbidden header ${h} is present`);
  if (url.startsWith('https:') && headers['strict-transport-security'] === undefined) out.push('missing header strict-transport-security');
  return out;
}

export const exitCodeOf = (rows) => (rows.length && rows.every((r) => r.status === 'PASS') ? 0 : 1);

// ---------- IO ----------
export function get(url, { timeoutMs = 10000 } = {}) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'vulnmart-live-smoke/1' } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n <= 65536) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
  });
}

async function checkUrl(name, url, { bodyCheck } = {}) {
  const r = await get(url);
  if (!r.status) return { status: 'FAIL', name, detail: `no answer (${r.error})` };
  const problems = [];
  if (r.status !== 200) problems.push(`HTTP ${r.status} (want 200)`);
  problems.push(...headerProblems(r.headers, url));
  if (bodyCheck && r.status === 200) {
    const b = bodyCheck(r.body);
    if (b) problems.push(b);
  }
  return problems.length ? { status: 'FAIL', name, detail: problems.join('; ') } : { status: 'PASS', name, detail: `HTTP 200, headers ok` };
}

export async function runSmoke(cfg) {
  const rows = [];
  rows.push(await checkUrl('site-root', `${cfg.base}/`));
  rows.push(await checkUrl('health', `${cfg.base}${cfg.healthPath}`));
  if (cfg.versionPath)
    rows.push(
      await checkUrl('version', `${cfg.base}${cfg.versionPath}`, {
        bodyCheck: (b) => (!b.trim() ? 'empty body' : cfg.expectVersion && !b.includes(cfg.expectVersion) ? 'answer does not contain the expected version text' : null),
      }),
    );
  cfg.extra.forEach((u, i) => rows.push({ _p: checkUrl(`extra-${i + 1}`, u) }));
  return Promise.all(rows.map((r) => (r._p ? r._p : r)));
}

export async function main(env = process.env) {
  const cfg = configFromEnv(env);
  if (cfg.error) {
    console.error(`FAIL ${cfg.error}`);
    return 2;
  }
  const rows = await runSmoke(cfg);
  console.log(formatTable(rows));
  const code = exitCodeOf(rows);
  console.log(code === 0 ? '\nlive-smoke: PASS (read-only GET checks)' : '\nlive-smoke: FAIL');
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
