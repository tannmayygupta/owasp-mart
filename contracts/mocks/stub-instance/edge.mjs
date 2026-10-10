// Stub edge: pass-through only (the real Caddy edge belongs to L-12, L-15).
//   player listener (default 8080): every request goes to the gate, unchanged
//   relay listener (default 8081): only POST /internal/v1/events is forwarded to the ingest, byte for byte (IF-4 section 5);
//                                  any other path answers 404 here, so no other ingest route (for example /_fake/events) is reachable
import http from 'node:http';
import { closeServer, listen, passThrough, sendProblem } from './common.mjs';

export function createEdge({ gateUrl = 'http://gate:8080', ingestUrl = 'http://ingest:8081' } = {}) {
  const toGate = passThrough(gateUrl);
  const toIngest = passThrough(ingestUrl);
  const player = http.createServer(toGate);
  const relay = http.createServer((req, res) => {
    if ((req.url || '').split('?')[0] !== '/internal/v1/events') return sendProblem(res, 404, 'Not found');
    return toIngest(req, res);
  });
  return {
    player, relay,
    async listen({ playerPort = 8080, relayPort = 8081, host = '0.0.0.0' } = {}) {
      return { playerPort: await listen(player, playerPort, host), relayPort: await listen(relay, relayPort, host) };
    },
    stop: () => Promise.all([closeServer(player), closeServer(relay)]),
  };
}
