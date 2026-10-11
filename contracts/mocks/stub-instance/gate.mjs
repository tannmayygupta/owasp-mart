// Stub gate: always allows (the real access gate belongs to L-12 and L-15). Pass-through to the sidecar's player port.
import http from 'node:http';
import { closeServer, listen, passThrough } from './common.mjs';

export function createGate({ upstreamUrl = 'http://sidecar:8080' } = {}) {
  const server = http.createServer(passThrough(upstreamUrl));
  return { server, listen: (port = 8080, host = '0.0.0.0') => listen(server, port, host), stop: () => closeServer(server) };
}
