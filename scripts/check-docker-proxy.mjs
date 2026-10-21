#!/usr/bin/env node
// Conformance check of the Docker socket proxy (story 4.2, ADR 0010 and 0038, handoff H-125): the proxy answers what SdkBackend calls and refuses everything else.
// It sends only requests that change nothing: the allowed calls are reads; every other row must be refused by the proxy (403) before it reaches Docker, so a proxy that is
// too open would be CAUGHT by the row that is not refused, but the row itself could then act: the denied rows use ids and names that exist nowhere ("vm-conformance-none",
// "nothing-here") and a `build`/`exec`/`swarm` that Docker answers with an error to an empty body, never with an action.
//   node scripts/check-docker-proxy.mjs [--url http://127.0.0.1:2375] [--listen]
//     --listen   also run `ss -ltn` (Linux, the host of vm-i) and require that port 2375 is bound on loopback only (the line is printed with the address removed)
// Exit 0 when every row conforms, 1 with the failing rows, 2 on a usage error. No address and no secret is printed except the loopback URL given.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

/** [method, path, expected]: 'allow' means "not 403" (Docker's own answer, 200 or 404), 'deny' means exactly 403 from the proxy. */
export const ROWS = [
  ['GET', '/_ping', 'allow'], ['GET', '/version', 'allow'], ['GET', '/v1.45/containers/json', 'allow'], ['GET', '/networks', 'allow'], ['GET', '/volumes', 'allow'],
  ['GET', '/containers/vm-conformance-none/json', 'allow'],
  ['GET', '/images/json', 'deny'], ['GET', '/info', 'deny'], ['GET', '/events', 'deny'], ['GET', '/system/df', 'deny'], ['GET', '/secrets', 'deny'], ['GET', '/swarm', 'deny'],
  ['POST', '/build', 'deny'], ['POST', '/commit', 'deny'], ['POST', '/swarm/init', 'deny'], ['POST', '/images/create', 'deny'], ['POST', '/auth', 'deny'],
  ['POST', '/containers/nothing-here/exec', 'deny'], ['POST', '/containers/vm-conformance-none/exec', 'deny'],
  ['POST', '/containers/vm-conformance-none/stop', 'deny'], ['POST', '/containers/vm-conformance-none/kill', 'deny'], ['POST', '/containers/vm-conformance-none/restart', 'deny'],
  ['GET', '/containers/vm-conformance-none/archive?path=/', 'deny'],
  // names outside vm-*: start, attach, remove, network connect, create and remove are refused
  ['POST', '/containers/create?name=conformance-not-vm', 'deny'], ['POST', '/containers/create', 'deny'],
  ['POST', '/containers/nothing-here/start', 'deny'], ['POST', '/containers/nothing-here/attach', 'deny'], ['DELETE', '/containers/nothing-here', 'deny'],
  ['POST', '/networks/nothing-here/connect', 'deny'], ['POST', '/networks/nothing-here/disconnect', 'deny'], ['DELETE', '/networks/nothing-here', 'deny'],
  ['DELETE', '/volumes/nothing-here', 'deny'], ['POST', '/volumes/prune', 'deny'], ['POST', '/containers/prune', 'deny'], ['POST', '/networks/prune', 'deny'],
  ['PUT', '/containers/vm-conformance-none/archive', 'deny'],
];

/** One request: resolves to the HTTP status, rejects on a network error. */
export function request(base, method, path, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: method === 'GET' || method === 'DELETE' ? {} : { 'Content-Length': '0' }, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function checkProxy(base, rows = ROWS, send = request) {
  const failures = [];
  for (const [method, path, expected] of rows) {
    let status;
    try { status = await send(base, method, path); } catch (e) { failures.push(`${method} ${path}: no answer (${e.message})`); continue; }
    if (expected === 'deny' && status !== 403) failures.push(`${method} ${path}: expected 403 from the proxy, got ${status}`);
    if (expected === 'allow' && status === 403) failures.push(`${method} ${path}: refused (403) but SdkBackend needs it`);
  }
  return failures;
}

/** `ss -ltn` lines that name port 2375: every one must be loopback. Returns the failures; `lines` is the output of ss. */
export function checkListeners(ssOutput, port = 2375) {
  const rows = ssOutput.split('\n').filter((l) => new RegExp(`[:\\]]${port}\\s`).test(l));
  if (rows.length === 0) return [`nothing listens on ${port} (is the proxy started?)`];
  const failures = [];
  for (const l of rows) {
    const local = l.trim().split(/\s+/)[3] ?? '';
    if (!(local.startsWith('127.') || local.startsWith('[::1]'))) failures.push(`port ${port} is bound beyond loopback: ${local.replace(/[0-9a-f:.]+(?=:\d+$)/i, '<address removed>')}`);
  }
  return failures;
}

async function main(argv) {
  let url = 'http://127.0.0.1:2375';
  let listen = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') url = argv[++i];
    else if (argv[i] === '--listen') listen = true;
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(url ?? '')) { console.error('--url must be http://127.0.0.1:<port> (the proxy has no login and is never reached beyond loopback)'); return 2; }
  const failures = await checkProxy(url);
  if (listen) {
    try { failures.push(...checkListeners(execFileSync('ss', ['-ltn'], { encoding: 'utf8' }))); } catch (e) { failures.push(`ss -ltn could not run (${e.code ?? e.message})`); }
  }
  if (failures.length) { for (const f of failures) console.error(`FAIL ${f}`); console.error(`${failures.length} row(s) do not conform`); return 1; }
  console.log(`PASS docker proxy: ${ROWS.length} rows conform${listen ? ', port 2375 is loopback only' : ''}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
