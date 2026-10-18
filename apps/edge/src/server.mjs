// The edge gate service (story edge-2): the gate of story 1 behind three listeners.
//   player  (8080)  decides each request with gate.decide(): a page, or a proxy to vm-<id>-e<epoch>-sidecar:8080 by its unique container name
//   admin   (9090)  the orchestrator's state push (admin.mjs); bound to ONE address only (see below), never published
//   relay   (8081)  the event relay (relay.mjs); instances reach it on their own network
// Configuration (environment; secrets only as FILES):
//   EDGE_ZONE                  the labs zone, e.g. labs.example (required)
//   EDGE_KEY_CURRENT_FILE      file with the current gate key: at least 64 hex characters (32 bytes), one line (required)
//   EDGE_KEY_PREVIOUS_FILE     optional; a missing file, a folder or an empty file means no previous key
//   EDGE_ADMIN_SECRET_FILE     file with the admin secret (read on every admin call, see admin.mjs) (required)
//   EDGE_INGEST_URL            origin of the ingest, e.g. http://ingest:8081 (required)
//   EDGE_PLAYER_BIND_HOST      address or Docker network alias to bind the player listener to (default 0.0.0.0)
//   EDGE_ADMIN_BIND_HOST       address or network alias to bind the admin listener to (default 127.0.0.1); a name is resolved at start with retries
//   EDGE_PLAYER_PORT / EDGE_ADMIN_PORT / EDGE_RELAY_PORT   defaults 8080 / 9090 / 8081
//   EDGE_RELAY_RATE_MAX / EDGE_RELAY_RATE_WINDOW_MS         relay limit per peer address (default 120 per 10000 ms)
// Why bind by alias: the edge is attached to many instance networks. A listener on 0.0.0.0 would be reachable from every one of them. The admin listener binds
// to the address the container has on labs-core (the alias exists on that network only) and the player listener to the address on the Caddy network, so an
// instance can reach the relay (by design) and nothing else of the edge. A name that does not resolve ends the process (fail closed; compose restarts it).
// No dependencies. Logs carry method and status only: never a path, a query (the ticket), a cookie or a header value.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import { createAdmin } from './admin.mjs';
import { createGate } from './gate.mjs';
import { createRelay } from './relay.mjs';
import { createStore } from './state.mjs';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'cookie']);
const UPSTREAM_RE = /^(vm-i-[a-z2-7]{16}-e[1-9][0-9]{0,15}-sidecar):8080$/;
const BAD_GATEWAY = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unavailable</title></head><body><h1>Unavailable</h1><p>This lab instance did not answer.</p></body></html>\n';

/** Reads a key file: at least 64 hex characters. Returns a Buffer. Throws a message without the file content. */
export function readKeyFile(file, { optional = false } = {}) {
  let text;
  try {
    if (optional && !fs.statSync(file).isFile()) return undefined; // Docker makes a folder for a missing bind mount
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    if (optional) return undefined;
    throw new Error(`cannot read the key file ${file}`);
  }
  if (optional && text === '') return undefined;
  if (!/^[0-9a-fA-F]{64,}$/.test(text) || text.length % 2 !== 0) throw new Error(`the key file ${file} must hold at least 64 hex characters`);
  return Buffer.from(text, 'hex');
}

function collect(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= limit + 1) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

export function createPlayerHandler({ gate, resolveUpstream = (name) => ({ hostname: name }), timeoutMs = 30000, log = () => {} }) {
  return (req, res) => {
    const d = gate.decide({ method: req.method, url: req.url, headers: req.headers });
    if (d.type === 'respond') {
      req.resume();
      res.writeHead(d.status, { ...d.headers, 'content-length': Buffer.byteLength(d.body) });
      res.end(req.method === 'HEAD' ? undefined : d.body);
      log(`player ${req.method} ${d.status}`);
      return;
    }
    const m = UPSTREAM_RE.exec(d.upstream);
    if (!m) { // the gate builds the name from validated fields; anything else is a bug and is refused
      req.resume();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(BAD_GATEWAY) });
      res.end(BAD_GATEWAY);
      return;
    }
    const to = resolveUpstream(m[1]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    if (d.cookie !== undefined) headers.cookie = d.cookie;
    const up = http.request({ hostname: to.hostname, port: to.port ?? 8080, method: req.method, path: req.url, headers, timeout: timeoutMs }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      r.on('error', () => res.destroy());
      r.on('close', () => { if (!r.complete) res.destroy(); });
      log(`player ${req.method} ${r.statusCode} proxied`);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(BAD_GATEWAY) });
      res.end(BAD_GATEWAY);
      log(`player ${req.method} 502`);
      return undefined;
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  };
}

export function createAdminHandler({ admin, limit = 1024 * 1024 }) {
  return async (req, res) => {
    const body = await collect(req, limit);
    const r = admin.handle({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(r.status, { ...r.headers, 'content-length': Buffer.byteLength(r.body) });
    res.end(r.body);
  };
}

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address().port); });
});
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

/**
 * Starts the three listeners. Hosts must be addresses (main() resolves aliases). Port 0 picks a free port.
 * @returns {{ ports: {player:number, admin:number, relay:number}, gate, stop: () => Promise<void> }}
 */
export async function startServer({
  zone, keys, adminSecretFile, ingestUrl,
  playerHost = '0.0.0.0', adminHost = '127.0.0.1', relayHost = '0.0.0.0',
  playerPort = 8080, adminPort = 9090, relayPort = 8081,
  relayRateMax, relayRateWindowMs, resolveUpstream, now, log = () => {},
}) {
  const store = createStore({ zone });
  const gate = createGate({ keys, zone, store, ...(now ? { now } : {}) });
  const admin = createAdmin({ store, secretFile: adminSecretFile });
  const relay = createRelay({ ingestUrl, rateMax: relayRateMax, rateWindowMs: relayRateWindowMs, log });
  const player = http.createServer(createPlayerHandler({ gate, resolveUpstream, log }));
  const adminServer = http.createServer(createAdminHandler({ admin }));
  for (const s of [player, adminServer]) { s.headersTimeout = 10000; s.requestTimeout = 30000; }
  const ports = {
    player: await listen(player, playerPort, playerHost),
    admin: await listen(adminServer, adminPort, adminHost),
    relay: await listen(relay.server, relayPort, relayHost),
  };
  return { ports, gate, stop: () => Promise.all([close(player), close(adminServer), close(relay.server)]).then(() => undefined) };
}

/** An address as it is, or a name resolved to its first IPv4 address (retried: Docker attaches the networks a moment after the start). */
export async function resolveBindHost(value, { tries = 20, waitMs = 500 } = {}) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value;
  let last;
  for (let i = 0; i < tries; i++) {
    try { return (await dns.lookup(value, { family: 4 })).address; } catch (e) { last = e; await new Promise((r) => setTimeout(r, waitMs)); }
  }
  throw new Error(`cannot resolve the bind name ${value} (${last?.code ?? 'error'})`);
}

export async function main(env = process.env) {
  const need = (name) => { if (!env[name]) throw new Error(`${name} is required`); return env[name]; };
  const keys = { current: readKeyFile(need('EDGE_KEY_CURRENT_FILE')) };
  const previous = env.EDGE_KEY_PREVIOUS_FILE ? readKeyFile(env.EDGE_KEY_PREVIOUS_FILE, { optional: true }) : undefined;
  if (previous) keys.previous = previous;
  const int = (name, d) => {
    if (!env[name]) return d;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`); // review finding C6
    return n;
  };
  const s = await startServer({
    zone: need('EDGE_ZONE'), keys, adminSecretFile: need('EDGE_ADMIN_SECRET_FILE'), ingestUrl: need('EDGE_INGEST_URL'),
    playerHost: await resolveBindHost(env.EDGE_PLAYER_BIND_HOST ?? '0.0.0.0'),
    adminHost: await resolveBindHost(env.EDGE_ADMIN_BIND_HOST ?? '127.0.0.1'),
    playerPort: int('EDGE_PLAYER_PORT', 8080), adminPort: int('EDGE_ADMIN_PORT', 9090), relayPort: int('EDGE_RELAY_PORT', 8081),
    relayRateMax: int('EDGE_RELAY_RATE_MAX', 120), relayRateWindowMs: int('EDGE_RELAY_RATE_WINDOW_MS', 10000),
    log: (m) => console.log(m),
  });
  console.log(`edge-gate: player ${s.ports.player}, admin ${s.ports.admin}, relay ${s.ports.relay}`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => s.stop().then(() => process.exit(0)));
  return s;
}

if (import.meta.main) {
  main().catch((e) => { console.error(`edge-gate: ${e.message}`); process.exit(1); });
}
