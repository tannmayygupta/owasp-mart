// Entry point of the sidecar image.
//   node src/main.mjs [sidecar] [--relay URL] [--upstream URL] [--state FILE] [--outbox FILE] [--events-port N] [--player-port N]
// The flags are those of the stub sidecar, so the compose file and the instance template need no change. The one start document (event
// key, epoch, flag digests) arrives on standard input; a bad one ends the process with code 2 before any listener exists.
// Configuration is non-secret only; the event key never leaves memory.
import { parseFlags } from './common.mjs';
import { createSidecar, readStartDocument, DEFAULT_STATE_PATH, DEFAULT_OUTBOX_PATH } from './sidecar.mjs';
import { createCrs, DEFAULT_BINARY } from './crs.mjs';

const logLine = (...parts) => console.log(parts.join(' '));

// stdin and deps let the tests feed a start document and see that no listener was started on a bad one.
export async function main(argv = process.argv.slice(2), env = process.env, { stdin = process.stdin, deps = {} } = {}) {
  const { createSidecar: makeSidecar = createSidecar } = deps;
  const all = argv[0] === 'sidecar' ? argv.slice(1) : argv; // the stub took the word "sidecar"; both forms work
  const noCrs = all.includes('--no-crs'); // the one flag without a value: the detection helper is not started
  const rest = all.filter((a) => a !== '--no-crs');
  let o;
  try { o = parseFlags(rest, {}); } catch (e) { console.error(e.message); return 2; }
  const r = await readStartDocument(stdin);
  if (!r.ok) { console.error('sidecar: bad start document'); return 2; }
  let sc;
  // The helper is on by default only when its binary exists in the image; --no-crs turns it off. It is never allowed to stop the start.
  let crs = null;
  try { crs = createCrs({ enabled: !noCrs, binary: o['crs-binary'] ?? DEFAULT_BINARY, alarm: (m) => console.error(m) }); } catch { crs = null; }
  try { sc = makeSidecar({ start: r.start, relayUrl: o.relay, upstreamUrl: o.upstream, statePath: o.state ?? DEFAULT_STATE_PATH, outboxPath: o.outbox ?? DEFAULT_OUTBOX_PATH, crs }); } catch (e) { console.error(`sidecar: ${e.message}`); return 2; }
  const ports = await sc.listen({ ...(o['events-port'] ? { eventsPort: Number(o['events-port']) } : {}), ...(o['player-port'] ? { playerPort: Number(o['player-port']) } : {}) });
  logLine(`sidecar: listening on ${ports.playerPort} and ${ports.eventsPort}, epoch ${r.start.epoch}, next seq ${sc.nextSeq()}`);
  return null;
}

if (import.meta.main) {
  const code = await main();
  if (code !== null) process.exit(code);
}
