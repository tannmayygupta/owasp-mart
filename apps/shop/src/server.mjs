// VulnMart target shop — container entrypoint.
//
// Binds PORT (default 3000, the shop's port in the instance contract section 1)
// on all interfaces inside the container. The host publishes it on 127.0.0.1
// only; the shop has no egress of its own (that boundary is enforced in T-09).

import { createApp } from './app.mjs';
import { openDb } from './db/index.mjs';
import { migrate } from './db/migrate.mjs';
import { makeReadiness, lazyDb, makeEmitter } from './instance/instance.mjs';
// `seedAll` is imported dynamically in the local-run branch only: the seed data
// lives outside src/ and is NOT shipped in the instance image (the instance gets
// a pre-seeded snapshot from the injector), so the instance path must not load it.

// Resolve PORT once. An unset value defaults to 3000; a set-but-invalid value is
// a misconfiguration we fail loudly on rather than binding a random port. The
// Dockerfile healthcheck mirrors this default.
function resolvePort(raw) {
  if (raw === undefined) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${JSON.stringify(raw)} (expected an integer 1-65535)`);
  }
  return port;
}

const PORT = resolvePort(process.env.PORT);
const HOST = '0.0.0.0';

// Inside an instance the injector hands over a snapshot and a flags file and
// writes the marker last; the shop is ready only after that (T-04, IF-6 s5/6).
// The env names are the ones the instance contract allows. Outside an instance
// (no snapshot/flags configured) the shop is simply always-ready.
function instanceReadiness(env) {
  const snapshotPath = env.VM_SNAPSHOT_PATH;
  const flagsPath = env.VM_FLAGS_PATH;
  const dbPath = env.VM_DB_PATH;
  const set = [snapshotPath, flagsPath, dbPath].filter(Boolean).length;
  if (set === 0) return undefined; // not an instance: always-ready skeleton
  // A partially configured instance must fail loudly, not silently be always-ready.
  if (set !== 3) {
    throw new Error('instance mode needs all of VM_SNAPSHOT_PATH, VM_FLAGS_PATH and VM_DB_PATH (or none)');
  }
  return makeReadiness({ snapshotPath, flagsPath, dbPath });
}

// Reconcile the T-14 marketplace (needs an open db) with the T-04 instance
// readiness (db appears from the injected snapshot only after the marker). For a
// local / non-instance run we open, migrate and seed a fresh db and mount the
// full shop, always-ready, with no event emission (no sidecar). In an instance
// the db comes from the injected snapshot once ready, so the marketplace mounts
// on a lazy handle (the routes resolve the db per request, after /readyz is 200)
// and app events are posted to the sidecar (T-09, IF-4).
const readiness = instanceReadiness(process.env);
let db;
let emit;
if (!readiness) {
  db = openDb(process.env.VM_DB_PATH ?? ':memory:');
  migrate(db);
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
    const { seedAll } = await import('../seed/registry.mjs');
    await seedAll(db);
  }
  emit = () => {};
} else {
  db = lazyDb(readiness.getDb);
  emit = makeEmitter(process.env.VM_SIDECAR_EVENTS_URL);
}

const app = createApp({ db, isReady: readiness?.ready, emit });
const server = app.listen(PORT, HOST, () => {
  console.log(`vulnmart-shop listening on http://${HOST}:${PORT}`);
});

// A failed bind (EADDRINUSE, EACCES) emits 'error'; log and exit non-zero so the
// orchestrator sees a clean failure instead of an unhandled exception.
server.on('error', (err) => {
  console.error(`vulnmart-shop failed to start: ${err.message}`);
  process.exit(1);
});

// Stop promptly on a termination signal. If open keep-alive connections keep
// server.close() from completing, a short unref'd timer forces exit so the
// container never hangs until Docker sends SIGKILL.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
