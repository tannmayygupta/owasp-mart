// HTTP front of the fake ingest (IF-4).
// Usage: node contracts/mocks/fake-ingest/server.mjs --key <test key> [--instance <id>] [--port <n>] [--host <addr>]
//   POST /internal/v1/events      one signed event per request (answers 202, 200, 401, 409, 413, 422, 503)
//   GET  /_fake/events            what was stored so far: [{ instance_id, seq, type }] (not part of IF-4)
// It stops reading a body once the cap is passed, answers 413 and drops the connection; a request that takes longer than
// 10 seconds is closed. It prints one line per answered event with type and seq only, never event data. Node built-ins only.
import http from 'node:http';
import { createIngest, LIMITS } from './ingest.mjs';
import { TEST_INSTANCE } from './sign.mjs';

export const REQUEST_TIMEOUT_MS = 10000;
export const HELP = `Fake ingest for instance events (IF-4)
Usage: node contracts/mocks/fake-ingest/server.mjs --key <test key> [--instance <i-id>] [--port <n>] [--host <addr>] [--help]
  --key       the per-instance event key (use a throwaway test key, never a real one)
  --instance  the instance the key belongs to: i- plus 16 Base32 characters (default ${TEST_INSTANCE})
  --port      listen port (default 8081, 0 picks a free one); --host default 127.0.0.1
Exit code 2 on a usage error.`;

export function parseArgs(argv) {
  const o = { key: undefined, instance: TEST_INSTANCE, port: 8081, host: '127.0.0.1', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (['--key', '--instance', '--port', '--host'].includes(a) && argv[i + 1] !== undefined) {
      const v = argv[++i];
      if (v.startsWith('--')) throw new Error(`the value of ${a} looks like another option: ${v}`);
      if (a === '--port') {
        if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`bad port: ${v}`);
        o.port = Number(v);
      } else if (a === '--instance') {
        if (!/^i-[A-Z2-7]{16}$/.test(v)) throw new Error(`bad instance id (want i- plus 16 Base32 characters): ${v}`);
        o.instance = v;
      } else o[a.slice(2)] = v;
    } else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  return o;
}

export function startServer({ key, instance = TEST_INSTANCE, port = 8081, host = '127.0.0.1', log = console.log, limits, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ingest = createIngest({ keys: { [instance]: key }, limits });
  const max = (limits && limits.maxBodyBytes) || LIMITS.maxBodyBytes;
  const server = http.createServer((req, res) => {
    let answered = false;
    const send = (r, extra = {}) => {
      if (answered || res.destroyed) return;
      answered = true;
      res.writeHead(r.status, { ...r.headers, ...extra });
      res.end(JSON.stringify(r.body));
    };
    req.on('error', () => { answered = true; }); // aborted or reset by the client: nothing to answer
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/_fake/events') {
      return send({ status: 200, headers: { 'content-type': 'application/json' }, body: ingest.stored.map(({ event }) => ({ instance_id: event.instance_id, seq: event.seq, type: event.type })) });
    }
    if (url !== '/internal/v1/events') return send({ status: 404, headers: { 'content-type': 'application/problem+json' }, body: { title: 'Not found', status: 404 } });
    if (req.method !== 'POST') return send({ status: 405, headers: { 'content-type': 'application/problem+json', allow: 'POST' }, body: { title: 'Method not allowed', status: 405 } });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        // Too large: stop reading, answer 413, then drop the connection.
        chunks.length = 0;
        const r = ingest.handle({ headers: req.headers, body: Buffer.alloc(max + 1) });
        log(`${r.status} ${r.body.code}`);
        send(r, { connection: 'close' });
        res.once('finish', () => req.destroy());
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (answered) return;
      const r = ingest.handle({ headers: req.headers, body: Buffer.concat(chunks) });
      log(`${r.status} ${r.body.code || r.body.status} ${r.body.instance_id || ''} ${r.body.seq || ''}`.trim());
      send(r);
    });
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  server.timeout = timeoutMs;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, ingest, port: server.address().port }));
  });
}

if (import.meta.main) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${HELP}`); process.exit(2); }
  if (o.help) { console.log(HELP); process.exit(0); }
  if (!o.key) { console.error(`--key is required\n${HELP}`); process.exit(2); }
  const { port } = await startServer(o);
  console.log(`fake ingest for ${o.instance} listening on http://${o.host}:${port}/internal/v1/events (Ctrl+C to stop)`);
}
