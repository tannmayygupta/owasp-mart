// Tiny stub target for the exploit-runner skeleton (T-05). Node http only.
//
// MODE=vulnerable: GET /orders/:id returns any order, including another store's
//                  (the broken-access-control weakness the demo exploit checks).
// MODE=fixed:      GET /orders/:id returns 403 unless the order belongs to the
//                  caller's store.
//
// This is a throwaway demonstration target, not the real shop. No real flag.
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const MODE = process.env.MODE === 'fixed' ? 'fixed' : 'vulnerable';
// The caller is "store-a"; order 999 belongs to "store-b" (a foreign order).
const ORDERS = {
  '999': { id: '999', store: 'store-b', note: 'EXPLOIT-MARKER-FOREIGN-ORDER' },
};
const CALLER_STORE = 'store-a';

export function createStub(mode = MODE) {
  return http.createServer((req, res) => {
    const m = req.url.match(/^\/orders\/([^/?]+)(?:\?.*)?$/);
    if (req.method === 'GET' && m) {
      const order = ORDERS[m[1]];
      if (!order) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      if (mode === 'fixed' && order.store !== CALLER_STORE) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(order));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

// Run standalone: `MODE=vulnerable node challenges/tests/_example/stub.mjs [port]`
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 0);
  const server = createStub();
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`stub (${MODE}) listening on http://127.0.0.1:${addr.port}`);
  });
}
