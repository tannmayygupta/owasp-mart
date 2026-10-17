// Container entrypoint for the import service (T-12). Listens on the unix socket
// the instance contract allows (VM_IMPORT_SOCKET, default /run/import/import.sock).
// The container runs network_mode none with no /data mount, so the service has no
// network and no database access; jobs run in fresh child processes.
import { createImportServer } from './server.mjs';

const socketPath = process.env.VM_IMPORT_SOCKET ?? '/run/import/import.sock';

// A single bad job must never take the service down (the real work is isolated in
// child processes). A rejection is logged and swallowed; an uncaught exception in
// the parent may leave it in an undefined state, so log and exit — the orchestrator
// restarts a fresh process.
process.on('unhandledRejection', (e) => console.error(`import-service: unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => { console.error(`import-service: uncaughtException: ${e?.message ?? e}`); process.exit(1); });

const { server, listen } = createImportServer({ socketPath });
listen().then(() => console.log(`import-service: listening on ${socketPath}`)).catch((err) => {
  console.error(`import-service: failed to listen on ${socketPath}: ${err.message}`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
}
