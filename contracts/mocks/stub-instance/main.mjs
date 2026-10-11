// Entry point of the stub instance image (story L-06). Test-only; never a product image.
//   node main.mjs shop | inject | sidecar | edge | gate | ingest
// Configuration comes from the env names IF-6 allows (PORT, VM_*) and from non-secret options; secrets arrive on standard input only.
import { parseFlags, listen, logLine } from './common.mjs';
import { createShop } from './shop.mjs';
import { runInject } from './inject.mjs';
import { createSidecar, readStartDocument, DEFAULT_STATE_PATH } from './sidecar.mjs';
import { createEdge } from './edge.mjs';
import { createGate } from './gate.mjs';
import { runIngest } from './ingest.mjs';

export const COMMANDS = ['shop', 'inject', 'sidecar', 'edge', 'gate', 'ingest'];

// stdin and deps let the tests feed a start document and see that no listener was started on a bad one.
export async function main(argv = process.argv.slice(2), env = process.env, { stdin = process.stdin, deps = {} } = {}) {
  const { createSidecar: makeSidecar = createSidecar, runIngest: ingest = runIngest, runInject: inject = runInject } = deps;
  const [cmd, ...rest] = argv;
  let o;
  try { o = parseFlags(rest, {}); } catch (e) { console.error(e.message); return 2; }
  switch (cmd) {
    case 'inject': return inject({ env, stdin });
    case 'shop': {
      const { server } = createShop({
        flagsPath: env.VM_FLAGS_PATH, snapshotPath: env.VM_SNAPSHOT_PATH, dbPath: env.VM_DB_PATH,
        eventsUrl: env.VM_SIDECAR_EVENTS_URL,
      });
      const port = await listen(server, Number(env.PORT || 3000));
      logLine(`shop: listening on ${port}`);
      return null; // keep running
    }
    case 'sidecar': {
      const r = await readStartDocument(stdin);
      if (!r.ok) { console.error('sidecar: bad start document'); return 2; }
      let sc;
      try { sc = makeSidecar({ start: r.start, relayUrl: o.relay, upstreamUrl: o.upstream, statePath: o.state ?? DEFAULT_STATE_PATH }); } catch (e) { console.error(`sidecar: ${e.message}`); return 2; }
      const ports = await sc.listen({ ...(o['events-port'] ? { eventsPort: Number(o['events-port']) } : {}), ...(o['player-port'] ? { playerPort: Number(o['player-port']) } : {}) });
      logLine(`sidecar: listening on ${ports.playerPort} and ${ports.eventsPort}, epoch ${r.start.epoch}, next seq ${sc.nextSeq()}`);
      return null;
    }
    case 'edge': {
      const edge = createEdge({ gateUrl: o.gate, ingestUrl: o.ingest });
      const ports = await edge.listen();
      logLine(`edge: listening on ${ports.playerPort} and ${ports.relayPort}`);
      return null;
    }
    case 'gate': {
      const gate = createGate({ upstreamUrl: o.upstream });
      logLine(`gate: listening on ${await gate.listen()}`);
      return null;
    }
    case 'ingest': return (await ingest({ stdin })) ? null : 2;
    default:
      console.error(`Unknown command "${cmd ?? ''}". Commands: ${COMMANDS.join(', ')}`);
      return 2;
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== null) process.exit(code);
}
