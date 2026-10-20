// Container entrypoint for the support-agent bot controller (T-13). Listens on
// port 9200 (instance contract section 1) on the instance network. The target it
// may visit, and the allow-listed path prefixes, come from the environment.
//
// The visitor is the jsdom browser of browser.mjs (C03 part B); VM_BOT_BROWSER=0 switches back to the plain HTTP GET. The pages the browser may reach are the shop and the
// collector of mock-services (port 9104 on VM_MOCK_URL) and nothing else.
import { createBotController, visitHttp } from './controller.mjs';
import { createBrowserVisitor } from './browser.mjs';

const PORT = Number(process.env.PORT) || 9200;
const HOST = '0.0.0.0';
const target = process.env.VM_BOT_TARGET ?? 'http://shop:3000';
const allowPrefixes = (process.env.VM_BOT_ALLOW_PREFIXES ?? '/tickets/,/staff/tickets,/product/,/disputes/')
  .split(',').map((s) => s.trim()).filter(Boolean);
const useBrowser = process.env.VM_BOT_BROWSER !== '0';
const maxVisitMs = Number(process.env.VM_BOT_MAX_VISIT_MS) || (useBrowser ? 25000 : 5000);
const dwellMs = Number(process.env.VM_BOT_DWELL_MS) || 5000;
const mockBase = process.env.VM_MOCK_URL ?? 'http://mock-services';
const eventsUrl = process.env.VM_SIDECAR_EVENTS_URL;

process.on('unhandledRejection', (e) => console.error(`bot: unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => { console.error(`bot: uncaughtException: ${e?.message ?? e}`); process.exit(1); });

// bot.visit events go to the sidecar (IF-4): source bot, session kind bot, never a credit. Best effort; no URL means no events (a local run).
function makeEmit(url) {
  if (!url) return () => {};
  return (type, data) => {
    const event = { schema_version: '0.1', type, source: 'bot', session_kind: 'bot', user_id: null, ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), data };
    fetch(new URL('/v1/events', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(3000) }).catch(() => {});
  };
}

let collectorOrigin = null;
try { collectorOrigin = new URL(`${mockBase.replace(/\/$/, '')}:9104`).origin; } catch { /* no collector reachable */ }
const visit = useBrowser
  ? createBrowserVisitor({ origins: [new URL(target).origin, collectorOrigin].filter(Boolean), dwellMs })
  : visitHttp;

const { server } = createBotController({ target, allowPrefixes, maxVisitMs, visit, emit: makeEmit(eventsUrl) });
server.listen(PORT, HOST, () => console.log(`bot: listening on ${PORT}, target ${new URL(target).origin}, allow ${allowPrefixes.join(' ')}, visitor ${useBrowser ? 'browser' : 'http'}`));
server.on('error', (err) => { console.error(`bot: failed to start: ${err.message}`); process.exit(1); });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
}