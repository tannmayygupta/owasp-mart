// Container entrypoint for mock-services (T-11). Starts the four mocks on their
// fixed instance ports (IF-6 section 1), on all interfaces inside the container.
// The ports are published only on the instance network, never to the host.
import { createMockServices, PORTS } from './server.mjs';

const HOST = '0.0.0.0';

// Safety net: a single bad request must never take all four mocks down. The
// handlers are written not to throw, but an unexpected rejection/throw is logged
// and swallowed rather than crashing the shared process.
process.on('unhandledRejection', (e) => console.error(`mock-services: unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => console.error(`mock-services: uncaughtException: ${e?.message ?? e}`));

const services = createMockServices();
const started = [];

for (const [name, port] of Object.entries(PORTS)) {
  const { server } = services[name];
  server.listen(port, HOST, () => console.log(`mock-services: ${name} on ${port}`));
  server.on('error', (err) => { console.error(`mock-services: ${name} failed: ${err.message}`); process.exit(1); });
  started.push(server);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const s of started) s.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
