// Harness-only wrapper around the fake ingest (contracts/mocks/fake-ingest/server.mjs). It reads the same start document as the
// sidecar from standard input (instance_id and event_key are used, nothing else) so the test key never appears in a command line,
// an environment variable, a compose file or `docker inspect`. The fake ingest itself still takes the key through its `--key` option.
import { readStartDocument } from './sidecar.mjs';
import { startServer } from '../fake-ingest/server.mjs';

export async function runIngest({ stdin = process.stdin, port = 8081, host = '0.0.0.0', log = (m) => console.log(m) } = {}) {
  const r = await readStartDocument(stdin);
  if (!r.ok) { log('ingest: bad start document'); return null; }
  const s = await startServer({ key: r.start.event_key, instance: r.start.instance_id, port, host, log });
  log(`ingest: listening on ${s.port}`);
  return s;
}
