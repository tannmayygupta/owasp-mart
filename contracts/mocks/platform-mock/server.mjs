// Mock of the browser API (IF-1 and IF-2) for the dashboards: a small Node server that reads the bundle
// contracts/api/bundle/openapi.json (no service to run; it uses ajv, ajv-formats and js-yaml from the pnpm workspace). It is NOT the real API.
//   - Platform routes (x-fragment: platform) answer the examples of the contract. The first success answer is the default;
//     `Prefer: code=NNN` selects another declared answer (for example the 401 or the 422) and `Prefer: example=NAME` a named example.
//     A `Prefer: code` answer is sent at once: the cookie, CSRF, Origin and body checks below are skipped for it.
//   - It enforces what the contract states, so the dashboards meet the failures early: an authenticated route needs the cookie
//     __Host-vm_session (401), a state-changing authenticated route needs a non-empty X-CSRF-Token (403), every POST, PATCH and DELETE needs
//     an Origin equal to --origin (403), a body must be JSON (415) and valid against its schema (422), bodies over 64 KiB are 413.
//     The CSRF token is only checked for presence here; the real one is signed and session bound (ADR 0019, M2).
//     A dashboard on another origin than --origin (for example http://localhost:3000) must start the mock with --origin. The session
//     cookie is Secure and __Host- prefixed, as in the contract; browsers keep it on http://localhost but Safari does not.
//   - Lab routes (x-fragment: lab) are forwarded to the fake lab of stream L (contracts/mocks/fake-lab/server.mjs, stateful, fake
//     sessions FAKE-SESSION-ADA and others), started as a child process unless --lab-url or --no-lab is given.
//   - Unknown routes and wrong methods answer IF-8 problems. Every answer carries Cache-Control: private, no-store.
// Usage: node server.mjs [--port 0] [--host 127.0.0.1] [--origin https://dashboard.example.invalid] [--bundle FILE] [--lab-url URL | --no-lab]
// Prints {"listening":true,"port":N} when ready.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_BUNDLE = path.join(ROOT, 'contracts', 'api', 'bundle', 'openapi.json');
export const DEFAULT_ERRORS = path.join(ROOT, 'contracts', 'errors', 'error-codes.yaml');
export const FAKE_LAB = path.join(ROOT, 'contracts', 'mocks', 'fake-lab', 'server.mjs');
export const DEFAULT_ORIGIN = 'https://dashboard.example.invalid';
export const MAX_BODY = 64 * 1024;
const SESSION_COOKIE = '__Host-vm_session';
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const HELP = `Mock of the browser API (IF-1 and IF-2)
Usage: node server.mjs [--port 0] [--host 127.0.0.1] [--origin ${DEFAULT_ORIGIN}] [--bundle FILE] [--lab-url URL | --no-lab] [--help]
Prints {"listening":true,"port":N} when ready. Platform routes answer their examples (Prefer: code=NNN picks another declared answer);
lab routes go to the fake lab (started as a child unless --lab-url or --no-lab).`;

const refsToBundle = (node) => {
  if (Array.isArray(node)) return node.map(refsToBundle);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `bundle${v}` : refsToBundle(v)]));
  return node;
};

function resolveRef(bundle, node) {
  let cur = node;
  for (let i = 0; i < 20 && cur && typeof cur === 'object' && typeof cur.$ref === 'string' && cur.$ref.startsWith('#/'); i++) {
    cur = cur.$ref.slice(2).split('/').reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], bundle);
  }
  return cur;
}

const toRegex = (template) => new RegExp('^' + template.split('/').map((seg) => (/^\{.+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');

function parsePrefer(value) {
  const out = {};
  for (const part of String(value || '').split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k && v !== undefined) out[k] = v;
  }
  return out;
}

export function createMock({ bundle, errors, origin = DEFAULT_ORIGIN, labUrl = null }) {
  const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
  ajv.addSchema(bundle, 'bundle');
  const codes = new Map((errors?.codes || []).map((c) => [c.code, c]));

  const routes = [];
  for (const [p, item] of Object.entries(bundle.paths)) {
    const ops = {};
    for (const m of METHODS) if (item[m]) ops[m.toUpperCase()] = item[m];
    routes.push({ template: p, regex: toRegex(p), ops });
  }

  const problem = (code, extra = {}) => {
    const c = codes.get(code);
    return { type: `urn:vulnmart:error:${code}`, title: c?.title ?? 'Error.', status: c?.status ?? 500, code, request_id: 'req-mock0001', ...extra };
  };

  const send = (res, status, body, headers = {}) => {
    const isJson = body !== undefined && body !== null && typeof body === 'object';
    const payload = body === undefined || body === null ? '' : isJson ? JSON.stringify(body) : String(body);
    res.writeHead(status, { 'cache-control': 'private, no-store', ...(payload ? { 'content-type': headers['content-type'] || 'application/json' } : {}), ...headers });
    res.end(status === 204 ? undefined : payload);
  };
  const sendProblem = (res, code, headers = {}, extra = {}) => {
    const p = problem(code, extra);
    send(res, p.status, p, { 'content-type': 'application/problem+json', ...headers });
  };

  // The declared answer of an operation: its status, content type, a chosen example and the headers it names.
  function declared(op, status, exampleName) {
    const resp = resolveRef(bundle, op.responses?.[status]);
    if (!resp) return null;
    const [ctype, media] = Object.entries(resp.content || {})[0] || [null, null];
    let value;
    let schema = null;
    if (media) {
      schema = media.schema;
      const examples = Object.entries(media.examples || {});
      const picked = exampleName ? examples.find(([n]) => n === exampleName) : examples[0];
      if (exampleName && !picked) return null; // a named example this answer does not have
      value = picked ? resolveRef(bundle, picked[1]).value : media.example;
    }
    return { status: Number(status), ctype, value, schema, headers: Object.keys(resp.headers || {}) };
  }

  // The declared answer whose example carries this error code (a status may declare several, for example 403: origin and e-mail not verified).
  function declaredByCode(op, status, code) {
    const resp = resolveRef(bundle, op.responses?.[status]);
    const media = Object.values(resp?.content || {})[0];
    for (const [name, ex] of Object.entries(media?.examples || {})) if (resolveRef(bundle, ex)?.value?.code === code) return declared(op, status, name);
    return null;
  }

  const answer = (res, op, d, ctx = {}) => {
    const headers = {};
    if (d.ctype) headers['content-type'] = d.ctype;
    if (d.headers.includes('Retry-After')) headers['retry-after'] = '30';
    if (d.headers.includes('X-Accel-Buffering')) headers['x-accel-buffering'] = 'no';
    // the first step of a login with a second factor sets no cookie yet
    if (d.headers.includes('Set-Cookie') && d.status < 300 && d.value?.status !== 'mfa_required') {
      headers['set-cookie'] = op.operationId === 'deleteSession' || ctx.clear
        ? `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
        : `${SESSION_COOKIE}=FAKE-SESSION-ADA; Path=/; Secure; HttpOnly; SameSite=Lax`;
    }
    send(res, d.status, d.value, headers);
  };

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) over = true; else chunks.push(c); });
      req.on('end', () => resolve({ over, text: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', () => resolve({ over, text: '' }));
    });
  }

  function proxyToLab(req, res, rawBody) {
    if (!labUrl) { sendProblem(res, 'REQ-ROUTE-UNKNOWN'); return; }
    const u = new URL(req.url, labUrl);
    const headers = { ...req.headers };
    delete headers.host;
    const up = http.request({ hostname: new URL(labUrl).hostname, port: new URL(labUrl).port, path: u.pathname + u.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => sendProblem(res, 'REQ-INTERNAL'));
    up.end(rawBody);
  }

  const validators = new WeakMap(); // request schema -> compiled validator, built once
  const validatorFor = (schema) => {
    if (!validators.has(schema)) validators.set(schema, ajv.compile(refsToBundle(schema)));
    return validators.get(schema);
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = routes.find((r) => r.regex.test(url.pathname));
    if (!route) { sendProblem(res, 'REQ-ROUTE-UNKNOWN'); return; }
    const method = req.method.toUpperCase();
    const op = route.ops[method];
    if (!op) { sendProblem(res, 'REQ-METHOD-NOT-ALLOWED', { allow: Object.keys(route.ops).join(', ') }); return; }
    const body = await readBody(req);
    if (op['x-fragment'] === 'lab') { proxyToLab(req, res, body.text); return; }

    const prefer = parsePrefer(req.headers.prefer);
    if (prefer.code) {
      const d = declared(op, prefer.code, prefer.example);
      if (d) { answer(res, op, d); return; }
      sendProblem(res, 'REQ-VALIDATION', {}, { errors: [{ pointer: '', detail: `The mock has no ${prefer.code} answer for this route.` }] });
      return;
    }

    const security = op.security ?? bundle.security ?? [];
    const names = new Set(security.flatMap((s) => Object.keys(s)));
    // The declared answer for this failure: the named example, else the example with this code, else a problem built from the registry.
    const fail = (status, code, exampleName) => {
      const d = (exampleName ? declared(op, status, exampleName) : null) ?? declaredByCode(op, status, code);
      if (d) answer(res, op, d); else sendProblem(res, code);
    };
    if (names.has('sessionCookie')) {
      const cookies = String(req.headers.cookie || '');
      if (!new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=[^;]+`).test(cookies)) { fail('401', 'AUTH-SESSION-REQUIRED', 'session_required'); return; }
    }
    if (CHANGING.has(method)) {
      if (req.headers.origin !== origin) { fail('403', 'AUTH-ORIGIN-FORBIDDEN'); return; }
      if (names.has('csrfHeader') && !String(req.headers['x-csrf-token'] || '').trim()) { fail('403', 'AUTH-CSRF-FAILED'); return; }
    }
    const reqBody = op.requestBody ? resolveRef(bundle, op.requestBody) : null;
    if (reqBody) {
      if (body.over) { fail('413', 'REQ-TOO-LARGE'); return; }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { fail('415', 'REQ-UNSUPPORTED-MEDIA-TYPE'); return; }
      let parsed;
      try { parsed = JSON.parse(body.text); } catch { fail('422', 'REQ-VALIDATION'); return; }
      const schema = reqBody.content?.['application/json']?.schema;
      if (schema) {
        if (!validatorFor(schema)(parsed)) { fail('422', 'REQ-VALIDATION'); return; }
      }
    }
    const success = Object.keys(op.responses).find((s) => s.startsWith('2'));
    const d = declared(op, success, prefer.example) ?? declared(op, success);
    answer(res, op, d);
  }

  // One odd request (an operation without a success answer, a broken schema) must not stop the mock.
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) sendProblem(res, 'REQ-INTERNAL'); else res.destroy(); });
  });

  return {
    server,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// Starts the fake lab as a child process and returns its URL and a stop function.
export function startFakeLab({ origin = DEFAULT_ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE_LAB, '--port', '0', '--origin', origin], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the fake lab did not start in 10 seconds')); }, 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${JSON.parse(line).port}`, stop: () => child.kill() }); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function main(argv = process.argv.slice(2), { log = console.log, err = console.error } = {}) {
  const o = { port: 0, host: '127.0.0.1', origin: DEFAULT_ORIGIN, bundle: DEFAULT_BUNDLE, labUrl: null, lab: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { log(HELP); return { code: 0 }; }
    if (a === '--no-lab') { o.lab = false; continue; }
    const map = { '--port': 'port', '--host': 'host', '--origin': 'origin', '--bundle': 'bundle', '--lab-url': 'labUrl' };
    if (map[a]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { err(`${a} needs a value.`); return { code: 2 }; }
      o[map[a]] = argv[++i];
      continue;
    }
    err(`Unknown argument "${a}". Run with --help.`);
    return { code: 2 };
  }
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { err('--port must be a whole number from 0 to 65535.'); return { code: 2 }; }
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(o.bundle, 'utf8')); } catch (e) { err(`cannot read the bundle ${o.bundle}: ${e.message}`); return { code: 1 }; }
  const errors = yaml.load(fs.readFileSync(DEFAULT_ERRORS, 'utf8'));
  let lab = null;
  let labUrl = o.labUrl;
  if (!labUrl && o.lab) { lab = await startFakeLab({ origin: o.origin }); labUrl = lab.url; }
  const mock = createMock({ bundle, errors, origin: o.origin, labUrl });
  const bound = await mock.listen(port, o.host);
  log(JSON.stringify({ listening: true, port: bound, lab: labUrl }));
  const stop = async () => { await mock.close(); lab?.stop(); };
  process.on('SIGINT', () => stop().then(() => process.exit(0)));
  return { code: 0, stop, port: bound };
}

if (import.meta.main) {
  main().then((r) => { if (r.code !== 0) process.exit(r.code); });
}
