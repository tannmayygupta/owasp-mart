// Container entrypoint for the support-agent bot controller (T-13). Listens on
// port 9200 (instance contract section 1) on the instance network. The target it
// may visit, and the allow-listed path prefixes, come from the environment.
import { createBotController } from './controller.mjs';

const PORT = Number(process.env.PORT) || 9200;
const HOST = '0.0.0.0';
const target = process.env.VM_BOT_TARGET ?? 'http://shop:3000';
const allowPrefixes = (process.env.VM_BOT_ALLOW_PREFIXES ?? '/tickets/,/staff/tickets,/product/,/disputes/')
  .split(',').map((s) => s.trim()).filter(Boolean);
const maxVisitMs = Number(process.env.VM_BOT_MAX_VISIT_MS) || 5000;

process.on('unhandledRejection', (e) => console.error(`bot: unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => { console.error(`bot: uncaughtException: ${e?.message ?? e}`); process.exit(1); });

const { server } = createBotController({ target, allowPrefixes, maxVisitMs });
server.listen(PORT, HOST, () => console.log(`bot: listening on ${PORT}, target ${new URL(target).origin}, allow ${allowPrefixes.join(' ')}`));
server.on('error', (err) => { console.error(`bot: failed to start: ${err.message}`); process.exit(1); });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
}
