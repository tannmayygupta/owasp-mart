// VulnMart target shop — container entrypoint.
//
// Binds PORT (default 3000, the shop's port in the instance contract section 1)
// on all interfaces inside the container. The host publishes it on 127.0.0.1
// only; the shop has no egress of its own (that boundary is enforced in T-09).

import { createApp } from './app.mjs';
import { openDb } from './db/index.mjs';
import { migrate } from './db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';

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

// Open the shop database. In an instance the injector supplies a seeded snapshot
// at VM_DB_PATH (T-04/T-09); for local running we migrate and seed a fresh db.
const db = openDb(process.env.VM_DB_PATH ?? ':memory:');
migrate(db);
if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  await seedAll(db);
}

const app = createApp({ db });
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
