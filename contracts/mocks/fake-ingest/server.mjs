// HTTP front of the fake ingest (IF-4).
// Usage: node contracts/mocks/fake-ingest/server.mjs (--key <test key> | --master <64 hex>) [--instance <id>] [--epoch <n>] [--port <n>] [--host <addr>]
//   POST /internal/v1/events      one signed event per request (answers 202, 200, 401, 409, 413, 422, 503)
//   GET  /_fake/events            what was stored so far, ordered by (epoch, seq): [{ instance_id, epoch, seq, type }] (not part of IF-4)
//   POST /_fake/epoch             { "instance_id", "epoch" } sets the current epoch of an instance (test API, not part of IF-4)
// It stops reading a body once the cap is passed, answers 413 and drops the connection; a request that takes longer than
// 10 seconds is closed. It prints one line per answered event with type and seq only, never event data. Node built-ins only.
import http from 'node:http';
import { createIngest, LIMITS } from './ingest.mjs';
import { TEST_INSTANCE } from './sign.mjs';

export const REQUEST_TIMEOUT_MS = 10000;
export const HELP = `Fake ingest for instance events (IF-4)
Usage: node contracts/mocks/fake-ingest/server.mjs (--key <test key> | --master <64 hex characters>) [--instance <i-id>] [--epoch <n>] [--port <n>] [--host <addr>] [--help]
  --key       one fixed per-instance event key for every epoch (use a throwaway test key, never a real one)
  --master    a throwaway 32-byte master as 64 hex characters: the key of (instance, epoch) is derived with HKDF (contracts/events/app-events.md section 4)
  --epoch     the current epoch of the instance (default 1); an event of a later epoch is refused with 401
  --instance  the instance the key belongs to: i- plus 16 Base32 characters (default ${TEST_INSTANCE})
  --port      listen port (default 8081, 0 picks a free one); --host default 127.0.0.1
Exit code 2 on a usage error.`;

export function parseArgs(argv) {
  const o = { key: undefined, master: undefined, instance: TEST_INSTANCE, epoch: 1, port: 8081, host: '127.0.0.1', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (['--key', '--master', '--instance', '--epoch', '--port', '--host'].includes(a) && argv[i + 1] !== undefined) {
      const v = argv[++i];
      if (v.startsWith('--')) throw new Error(`the value of ${a} looks like another option: ${v}`);
      if (a === '--port') {
        if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`bad port: ${v}`);
        o.port = Number(v);
      } else if (a === '--epoch') {
        if (!/^[1-9][0-9]{0,15}$/.test(v)) throw new Error(`bad epoch: ${v}`);
        o.epoch = Number(v);
      } else if (a === '--master') {
        if (!/^[0-9a-f]{64}$/.test(v)) throw new Error('bad master (want 64 lowercase hex characters)');
        o.master = v;
      } else if (a === '--instance') {
        if (!/^i-[A-Z2-7]{16}$/.test(v)) throw new Error(`bad instance id (want i- plus 16 Base32 characters): ${v}`);
        o.instance = v;
      } else o[a.slice(2)] = v;
    } else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  return o;
}

export function startServer({ key, master, instance = TEST_INSTANCE, epoch = 1, port = 8081, host = '127.0.0.1', log = console.log, limits, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ingest = master !== undefined ? createIngest({ master, instances: { [instance]: epoch }, limits }) : createIngest({ keys: { [instance]: key }, limits });
  if (master === undefined) ingest.setEpoch(instance, epoch);
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
      return send({ status: 200, headers: { 'content-type': 'application/json' }, body: ingest.ordered().map(({ event }) => ({ instance_id: event.instance_id, epoch: event.epoch, seq: event.seq, type: event.type })) });
    }
    if (req.method === 'POST' && url === '/_fake/epoch') {
      const c = [];
      req.on('data', (x) => { if (c.length < 16) c.push(x); });
      req.on('end', () => {
        const json = { 'content-type': 'application/json' };
        try {
          const b = JSON.parse(Buffer.concat(c).toString('utf8'));
          ingest.setEpoch(b.instance_id, b.epoch);
          send({ status: 200, headers: json, body: { instance_id: b.instance_id, epoch: b.epoch } });
        } catch { send({ status: 422, headers: json, body: { title: 'Bad epoch request', status: 422 } }); }
      });
      return;
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
      log(`${r.status} ${r.body.code || r.body.status} ${r.body.instance_id || ''} ${r.body.epoch || ''} ${r.body.seq || ''}`.replace(/ +/g, ' ').trim());
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
  if (!o.key && !o.master) { console.error(`--key or --master is required\n${HELP}`); process.exit(2); }
  if (o.key && o.master) { console.error(`use --key or --master, not both\n${HELP}`); process.exit(2); }
  const { port } = await startServer(o);
  console.log(`fake ingest for ${o.instance} listening on http://${o.host}:${port}/internal/v1/events (Ctrl+C to stop)`);
}
