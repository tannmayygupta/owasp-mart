// Spike S-14 (story LE-3, ADR 0031): does a live stream (SSE) survive a Vercel same-origin rewrite with an origin secret? Run from the developer's PC after the
// probe project is deployed (docs/runbooks/vercel-and-origin.md). It asks the probe upstream (infra/caddy/probe/server.mjs) through the Vercel URL.
// Prints PASS/FAIL lines and never a secret (the probe never returns it; this script never has it). Exit 0 all checks passed, 1 a check failed, 2 bad usage.
// Usage:
//   node scripts/check-sse-rewrite.mjs --url https://<project>.vercel.app [--direct https://<platform>.duckdns.org] [--hold <seconds>]
//   node scripts/check-sse-rewrite.mjs --validate [path/to/vercel.json]      (offline: checks the shape of the Vercel config, no network)
//   node scripts/check-sse-rewrite.mjs --render https://<platform>.duckdns.org --out <dir>   (copies the probe project to <dir> with the host filled in)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = [
  'usage: node scripts/check-sse-rewrite.mjs --url https://<project>.vercel.app [--direct https://<origin>] [--hold <seconds>]',
  '       node scripts/check-sse-rewrite.mjs --validate [vercel.json]',
  '       node scripts/check-sse-rewrite.mjs --render https://<label>.duckdns.org --out <dir>',
].join('\n');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_DIR = path.join(ROOT, 'infra', 'vercel', 's14-probe');
const DEFAULT_CONFIG = 'infra/vercel/s14-probe/vercel.json';
const SECRET_HEADER = 'x-origin-secret';
export const PLACEHOLDER_HOST = 'REPLACE-WITH-PLATFORM-NAME.duckdns.org';
const SCHEMA_URL = 'https://openapi.vercel.sh/vercel.json';
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.duckdns\.org$/;

// ---------------------------------------------------------------- offline validator of vercel.json

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => k in o);

/**
 * Shape rules for the Vercel config of the probe project (ADR 0031 D1). Returns a list of problems; empty means valid.
 * Strict by design: every string value must be one of a short allowlist, so no secret value or other address can hide in the file.
 */
export function validateVercelConfig(cfg) {
  const problems = [];
  if (!isObj(cfg)) return ['the file must hold one JSON object'];
  // "routes" cannot be combined with these (Vercel rule); the real dashboards need security headers, so see the fallback in ADR 0031.
  for (const k of ['rewrites', 'redirects', 'headers', 'cleanUrls', 'trailingSlash']) {
    if (k in cfg) problems.push(`"${k}" cannot be combined with "routes" (Vercel rule); the probe project uses "routes" only (ADR 0031)`);
  }
  for (const k of Object.keys(cfg)) if (!['$schema', 'routes', 'rewrites', 'redirects', 'headers', 'cleanUrls', 'trailingSlash'].includes(k)) problems.push(`unexpected top-level key "${k}"`);
  if ('$schema' in cfg && cfg.$schema !== SCHEMA_URL) problems.push(`"$schema" must be ${SCHEMA_URL}`);
  if (!Array.isArray(cfg.routes) || cfg.routes.length !== 1) return [...problems, '"routes" must hold exactly one route (the /api/ route)'];
  const [r] = cfg.routes;
  if (!isObj(r)) return [...problems, 'the route must be an object'];
  for (const k of Object.keys(r)) if (!['src', 'dest', 'transforms'].includes(k)) problems.push(`unexpected route key "${k}"`);
  if (r.src !== '/api/(.*)') problems.push('route src must be "/api/(.*)"');
  const destOk = typeof r.dest === 'string' && (r.dest === `https://${PLACEHOLDER_HOST}/api/$1` || /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?\.duckdns\.org\/api\/\$1$/.test(r.dest));
  if (!destOk) problems.push('route dest must be "https://<label>.duckdns.org/api/$1" (the placeholder host in the committed file): one DuckDNS host, the /api prefix kept (ADR 0031 D2)');
  const t = r.transforms;
  if (!Array.isArray(t) || t.length !== 1) problems.push('route needs exactly one transform');
  else if (!isObj(t[0])) problems.push('the transform must be an object');
  else {
    const x = t[0];
    for (const k of Object.keys(x)) if (!['type', 'op', 'target', 'args', 'env'].includes(k)) problems.push(`unexpected transform key "${k}"`);
    if (x.type !== 'request.headers') problems.push('transform type must be "request.headers"');
    if (x.op !== 'set') problems.push('transform op must be "set" (set overwrites a value sent by a visitor; append would not)');
    if (!isObj(x.target) || !sameKeys(x.target, ['key']) || x.target.key !== SECRET_HEADER) problems.push(`transform target must be exactly { "key": "${SECRET_HEADER}" }`);
    if (x.args !== '$ORIGIN_SECRET') problems.push('transform args must be exactly "$ORIGIN_SECRET" (a reference, never a value)');
    if (!Array.isArray(x.env) || x.env.length !== 1 || x.env[0] !== 'ORIGIN_SECRET') problems.push('transform env must be ["ORIGIN_SECRET"] (whitelist)');
  }
  return problems;
}

/** The origin for --render: https, one DuckDNS label, nothing else. Returns the host or null. */
export function originHost(s) {
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
    return HOST_RE.test(u.hostname) && u.hostname !== PLACEHOLDER_HOST.toLowerCase() && u.hostname.length <= 253 ? u.hostname : null;
  } catch { return null; }
}

/** Copy the probe project to outDir with the origin host filled in, and validate the result. Throws a plain Error with the problem. */
export function renderProbe({ origin, outDir, srcDir = PROBE_DIR }) {
  const host = originHost(origin);
  if (!host) throw new Error('refused origin: it must be https://<label>.duckdns.org (one DuckDNS name, no path, port, query or credentials)');
  const out = path.resolve(outDir);
  if (out === path.resolve(srcDir)) throw new Error('refused: the output folder is the source folder');
  const text = fs.readFileSync(path.join(srcDir, 'vercel.json'), 'utf8');
  if (!text.includes(PLACEHOLDER_HOST)) throw new Error('the source vercel.json has no placeholder host');
  const rendered = text.replace(PLACEHOLDER_HOST, host);
  const problems = validateVercelConfig(JSON.parse(rendered));
  if (problems.length) throw new Error(`the rendered file is not valid: ${problems.join('; ')}`);
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    if (f === 'vercel.json') continue;
    fs.copyFileSync(path.join(srcDir, f), path.join(out, f));
  }
  fs.writeFileSync(path.join(out, 'vercel.json'), rendered);
  return out;
}

// ---------------------------------------------------------------- live checks (fetch injected for tests)

/** Open a stream with a time limit that also covers waiting for the first byte (a buffering proxy never answers a stream that has no end). */
function openStream(fetchImpl, url, limitMs) {
  const ac = new AbortController();
  let isHeld = false;
  const timer = setTimeout(() => { isHeld = true; ac.abort(); }, limitMs);
  return { ac, held: () => isHeld, done: () => clearTimeout(timer), open: () => fetchImpl(url, { signal: ac.signal }) };
}

/** Read an SSE response. Frames (blocks ended by a blank line) are assembled across network chunks; onFrame(frameText, msSinceStart) gets each complete one. */
async function readStream(res, { now, onFrame, held }) {
  const start = now();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ended = 'stream-ended';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        onFrame(buf.slice(0, i), now() - start);
        buf = buf.slice(i + 2);
      }
    }
  } catch (e) {
    ended = held() ? 'held' : `cut: ${e?.cause?.code ?? e?.name ?? 'error'}`;
  }
  if (held()) ended = 'held';
  return { ended, ms: now() - start };
}

/**
 * @param {{url: string, direct?: string, holdMs?: number, streamIntervalMs?: number, requestTimeoutMs?: number, fetchImpl?: typeof fetch, now?: () => number}} o
 * @returns {Promise<{ok: boolean, code: number, lines: string[]}>}
 */
export async function runChecks({ url, direct, holdMs = 130000, streamIntervalMs = 2000, requestTimeoutMs = 15000, fetchImpl = fetch, now = Date.now }) {
  const base = url.replace(/\/+$/, '');
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });
  const fail = (name, e) => add(name, false, `request failed: ${e?.cause?.code ?? e?.name}`);
  const timeout = () => AbortSignal.timeout(requestTimeoutMs);
  const getJson = async (p, init = {}) => {
    const res = await fetchImpl(`${base}${p}`, { redirect: 'manual', ...init, signal: timeout() });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { res, body };
  };
  const hdr = (res, k) => res.headers.get(k);

  /** One stream request with a time limit that also covers waiting for the first byte. status 0 means no response before the limit. */
  const streamRun = async (p, limitMs, onFrame) => {
    const s = openStream(fetchImpl, `${base}${p}`, limitMs);
    try {
      const res = await s.open();
      const out = await readStream(res, { now, held: s.held, onFrame });
      return { status: res.status, res, out };
    } catch (e) {
      if (s.held()) return { status: 0, out: { ended: 'held', ms: limitMs } };
      throw e;
    } finally { s.done(); }
  };

  // 1. The route reaches the origin and the secret header arrives (the probe says only present or not, never the value).
  try {
    const { res, body } = await getJson('/api/v1/echo');
    add('echo-through-rewrite', res.status === 200 && body?.secretPresent === true,
      res.status !== 200 ? `status ${res.status}` : body?.secretPresent === true ? 'status 200, the origin received the secret header' : 'status 200 but the origin did not receive the secret header (is ORIGIN_SECRET set for this environment?)');
    if (body?.headers) {
      results.push({ name: 'host-and-forwarding-seen', info: true, ok: true, detail: `host header seen by the origin: ${body.host ?? 'none'}; x-forwarded-host: ${body.headers['x-forwarded-host'] ?? 'none'}; edge client address header present: ${body.headers['x-edge-forwarded-for'] ? 'yes' : 'no'} (information for the runbook)` });
    }
  } catch (e) { fail('echo-through-rewrite', e); }

  // 2. A visitor cannot choose the secret: a value sent by the client is overwritten by the transform (the origin still accepts the request).
  try {
    const { res, body } = await getJson('/api/v1/echo', { headers: { [SECRET_HEADER]: 'visitor-chosen-value' } });
    add('visitor-header-overwritten', res.status === 200 && body?.secretPresent === true, res.status === 200 ? 'a visitor value did not stop the request (the transform set its own value)' : `status ${res.status}: a visitor value was passed to the origin instead of being replaced`);
  } catch (e) { fail('visitor-header-overwritten', e); }

  // 3. Steady stream: 6 events spread over time. Frames are read per blank line, so an event split over two network chunks counts once.
  let streamRes = null;
  try {
    const stamps = [];
    const r = await streamRun(`/api/v1/stream?interval=${streamIntervalMs}&count=6&heartbeat=100000`, streamIntervalMs * 6 + requestTimeoutMs, (f, at) => { if (/^event: tick$/m.test(f)) stamps.push(at); });
    streamRes = r.res ?? null;
    const gaps = stamps.slice(1).map((s, i) => s - stamps[i]);
    const minGap = gaps.length ? Math.min(...gaps) : 0;
    const ok = r.status === 200 && stamps.length === 6 && stamps[0] < streamIntervalMs * 2.5 + 1500 && minGap >= streamIntervalMs * 0.4;
    add('stream-steady', ok, r.status === 0 ? 'no response in time: the stream is buffered or blocked' : `status ${r.status}, ${stamps.length} events, first after ${stamps[0] ?? 'n/a'} ms, smallest gap ${minGap} ms of ${streamIntervalMs} ms (events in batches or all at the end mean the stream is buffered), ended: ${r.out.ended}`);
  } catch (e) { fail('stream-steady', e); }

  // 3b. Headers of that stream survive: no compression, cache-control not rewritten.
  if (streamRes) {
    const enc = hdr(streamRes, 'content-encoding');
    add('stream-no-compression', !enc, enc ? `content-encoding ${enc} was added to the stream` : 'no content-encoding on the stream');
    const cc = hdr(streamRes, 'cache-control') ?? '';
    add('stream-cache-control', /no-cache/i.test(cc) && /no-transform/i.test(cc), `cache-control of the stream: ${cc || 'none'} (no-cache, no-transform expected)`);
  } else {
    add('stream-no-compression', false, 'no stream response to look at');
    add('stream-cache-control', false, 'no stream response to look at');
  }

  // 4. Longest stream: only heartbeats (comments) every 15 s, held for holdMs. Records the time at which Vercel or the network cut it, if it did.
  try {
    let beats = 0;
    const r = await streamRun('/api/v1/stream?interval=600000&heartbeat=15000', holdMs, (f) => { if (f.startsWith(': heartbeat')) beats += 1; });
    const held = r.out.ended === 'held';
    add('stream-longest', r.status === 200 && held, r.status === 0 ? `no response headers within ${Math.round(holdMs / 1000)} s: the stream is buffered or blocked` : `${Math.round(r.out.ms / 1000)} s, ${beats} heartbeats, ${held ? `held for the full ${Math.round(holdMs / 1000)} s without a cut` : `CUT after ${Math.round(r.out.ms / 1000)} s (${r.out.ended})`}`);
  } catch (e) { fail('stream-longest', e); }

  // 5. Cookie passthrough: a Set-Cookie of the origin reaches the client with its attributes, and a cookie sent back reaches the origin.
  try {
    const first = await fetchImpl(`${base}/api/v1/cookie`, { redirect: 'manual', signal: timeout() });
    const set = typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : [first.headers.get('set-cookie')].filter(Boolean);
    const mine = set.find((c) => /^probe=/.test(c));
    const attrsOk = !!mine && /HttpOnly/i.test(mine) && /Secure/i.test(mine) && /SameSite=Lax/i.test(mine);
    const second = await getJson('/api/v1/cookie', { headers: { cookie: 'probe=s14' } });
    add('cookie-passthrough', attrsOk && second.body?.cookieSeen === true, `Set-Cookie ${mine ? 'arrived' : 'missing'}${mine ? (attrsOk ? ' with HttpOnly, Secure, SameSite' : ' but attributes changed') : ''}; cookie sent to the origin: ${second.body?.cookieSeen === true ? 'yes' : 'no'}`);
  } catch (e) { fail('cookie-passthrough', e); }

  // 6. No shared cache: the probe answers a cacheable response (public, max-age=60) with a fresh random body each time. Two callers with different cookies
  // must get different bodies and no cache hit; the same body means something in between kept the first answer.
  try {
    const a = await getJson('/api/v1/cacheable', { headers: { 'x-probe-user': 'user-a', cookie: 'session=a' } });
    const b = await getJson('/api/v1/cacheable', { headers: { 'x-probe-user': 'user-b', cookie: 'session=b' } });
    const hit = /HIT/i.test(hdr(a.res, 'x-vercel-cache') ?? '') || /HIT/i.test(hdr(b.res, 'x-vercel-cache') ?? '');
    const same = a.body?.rand !== undefined && a.body?.rand === b.body?.rand;
    const ok = a.res.status === 200 && b.res.status === 200 && a.body?.rand && b.body?.rand && !same && b.body?.user === 'user-b' && !hit;
    add('no-shared-cache', !!ok, `${same ? 'both callers got the SAME body (a cache kept the first answer); ' : ''}${hit ? 'cache HIT seen; ' : ''}user-b body user: ${b.body?.user ?? 'none'}, x-vercel-cache: ${hdr(b.res, 'x-vercel-cache') ?? 'none'}`);
  } catch (e) { fail('no-shared-cache', e); }

  // 7. A POST body and a query string reach the origin unchanged.
  try {
    const payload = JSON.stringify({ s14: 'body', n: 1 });
    const query = '?a=1&b=two%20words&c=%C3%A4';
    const { res, body } = await getJson(`/api/v1/echo${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    const ok = res.status === 200 && body?.method === 'POST' && body?.path === `/api/v1/echo${query}` && body?.body === payload;
    add('request-body-and-query', ok, res.status !== 200 ? `status ${res.status}` : `method ${body?.method}, query ${body?.path === `/api/v1/echo${query}` ? 'unchanged' : 'CHANGED'}, body ${body?.body === payload ? 'unchanged' : 'CHANGED'}`);
  } catch (e) { fail('request-body-and-query', e); }

  // 8. Direct access without the secret is refused by the origin (optional: needs port 443 of vm-p open, runbook step).
  if (direct) {
    try {
      const res = await fetchImpl(`${direct.replace(/\/+$/, '')}/api/v1/echo`, { redirect: 'manual', signal: timeout() });
      const text = await res.text().catch(() => '');
      add('direct-access-refused', res.status === 403 && text.trim() === 'forbidden', `status ${res.status}, body ${text.trim() === 'forbidden' ? '"forbidden" (the Caddy gate)' : 'not the gate body'} (403 and "forbidden" expected)`);
    } catch (e) { fail('direct-access-refused', e); }
  } else {
    results.push({ name: 'direct-access-refused', skipped: true, ok: true, detail: 'skipped: no --direct given' });
  }

  const lines = results.map((r) => `${r.skipped ? 'SKIP' : r.info ? 'INFO' : r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
  const ok = results.every((r) => r.ok);
  lines.push(ok ? 'S-14: all checks passed (the live stream works through the rewrite)' : 'S-14: at least one check failed');
  return { ok, code: ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------- command line

const httpsUrl = (s) => { try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } };

export function parseCli(args) {
  const o = { validate: false };
  const need = (i) => (i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : null);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--validate') {
      o.validate = true;
      const v = need(i);
      if (v !== null) { o.config = v; i++; }
    } else if (['--url', '--direct', '--hold', '--render', '--out'].includes(a)) {
      const v = need(i);
      if (v === null) return { error: `${a} needs a value` };
      i++;
      if (a === '--url') o.url = v;
      else if (a === '--direct') o.direct = v;
      else if (a === '--render') o.render = v;
      else if (a === '--out') o.out = v;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1 || n > 900) return { error: '--hold must be 1 to 900 seconds' };
        o.holdMs = Math.round(n * 1000);
      }
    } else return { error: `unknown argument: ${a}` };
  }
  if (o.render !== undefined || o.out !== undefined) {
    if (o.render === undefined || o.out === undefined) return { error: '--render and --out go together' };
    if (o.validate || o.url || o.direct || o.holdMs) return { error: '--render cannot be combined with other options' };
    return { render: o.render, out: o.out };
  }
  if (o.validate) return o.url || o.direct || o.holdMs ? { error: '--validate cannot be combined with live options' } : o;
  if (!o.url) return { error: '--url is required' };
  if (!httpsUrl(o.url)) return { error: '--url must be an https address without credentials, query or fragment' };
  if (o.direct && !httpsUrl(o.direct)) return { error: '--direct must be an https address without credentials, query or fragment' };
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.error) {
    console.error(`${cli.error}\n${USAGE}`);
    process.exit(2);
  }
  if (cli.render !== undefined) {
    try {
      const out = renderProbe({ origin: cli.render, outDir: cli.out });
      console.log(`PASS  rendered and validated: ${out} (deploy from this folder, never commit it)`);
      process.exit(0);
    } catch (e) {
      console.error(`FAIL  ${e.message}`);
      process.exit(1);
    }
  }
  if (cli.validate) {
    const file = path.resolve(cli.config ?? DEFAULT_CONFIG);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`cannot read ${path.basename(file)}: ${e.message}`); process.exit(1); }
    const problems = validateVercelConfig(cfg);
    console.log(problems.length ? problems.map((p) => `FAIL  ${p}`).join('\n') : `PASS  ${path.basename(file)} has the expected shape`);
    process.exit(problems.length ? 1 : 0);
  }
  const r = await runChecks(cli);
  console.log(r.lines.join('\n'));
  process.exit(r.code);
}
