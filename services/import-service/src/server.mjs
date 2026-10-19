// Isolated import service (T-12, FR-SHP-13). The shop sends a product-import
// preview job over a unix socket (VM_IMPORT_SOCKET); the service runs EACH job in
// a FRESH child process with a timeout, so any state (a future C06 prototype
// pollution) dies with the job and never touches the next job or the service. The
// service has no network and no database access (the container runs network_mode
// none with no /data mount); the worker opens neither.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');
export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_JOB_BYTES = 1 << 20; // 1 MiB
const CONN_IDLE_MS = 10000; // a connection that never sends/finishes is dropped
// An ABSOLUTE per-connection deadline. The idle timeout above resets on every
// byte, so a client trickling one byte at a time (slowloris) would hold a
// connection slot forever and, at MAX_CONNS of them, starve real jobs; this fires
// regardless of activity. Must exceed a legitimate job (timeoutMs, default 5 s).
const CONN_DEADLINE_MS = Number(process.env.VM_IMPORT_CONN_DEADLINE_MS) || 15000;
// Cap concurrent workers so a burst cannot exhaust the container's pid budget
// (instance contract: pids_limit 64); excess jobs are refused, not queued. Kept
// small (the shop sends one preview at a time); raise with the env var if needed.
const MAX_INFLIGHT = Number(process.env.VM_IMPORT_MAX_INFLIGHT) || 3;
// Also cap concurrent connections, so a flood cannot each buffer up to
// MAX_JOB_BYTES before the per-job check runs. Headroom above MAX_INFLIGHT leaves
// room for liveness probes and the odd in-flight reply.
const MAX_CONNS = Number(process.env.VM_IMPORT_MAX_CONNS) || MAX_INFLIGHT * 4;

// C06 (story L-30): the audit token of this instance, a file that only THIS container mounts (read-only, placed by the injector). The parent reads it and hands it to the
// child; the child puts it in the preview only when the merge has set the audit flag. A job that does not touch the prototype never gets it. A container without the file
// (no C06 flag in this instance) runs the safe merge: the challenge is exploitable exactly when its flag is planted, like every other challenge.
export const PLACEMENT_PATH = process.env.VM_C06_PLACEMENT || '/run/placement/import/C06.placement';
export function readAuditToken(file = PLACEMENT_PATH) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text && text.length <= 200 && !/\s/.test(text) ? text : null;
  } catch { return null; }
}

// Run one job in a fresh child process, with a timeout. Always resolves (an error
// is a result, never a rejection); the child is killed when done or on timeout.
export function runJob(job, { timeoutMs = DEFAULT_TIMEOUT_MS, worker = WORKER, auditToken = readAuditToken() } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = fork(worker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); }
    catch { return resolve({ ok: false, error: 'spawn_failed' }); }
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);
    child.on('message', (m) => done(m));
    child.on('error', () => done({ ok: false, error: 'worker_error' }));
    child.on('exit', (code) => { if (!settled) done({ ok: false, error: `worker_exit_${code}` }); });
    try { child.send({ job, ctx: { audit_token: auditToken } }); } catch { done({ ok: false, error: 'send_failed' }); }
  });
}

// A unix-socket server: read one JSON job per connection, run it in a fresh
// process, write the result, close. One job per connection keeps framing trivial.
let inflight = 0;
let openConns = 0;

export function createImportServer({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, connDeadlineMs = CONN_DEADLINE_MS } = {}) {
  try { fs.rmSync(socketPath, { force: true }); } catch { /* no stale socket */ }
  // allowHalfOpen: the client sends the job then half-closes (FIN); we must keep
  // our write side open to reply AFTER the async worker finishes. Without this,
  // the server auto-ends on the client's FIN and the reply is never sent.
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    openConns += 1;
    let deadline = null;
    conn.on('close', () => { openConns -= 1; if (deadline) clearTimeout(deadline); });
    // Too many open connections: drop this one before buffering anything.
    if (openConns > MAX_CONNS) { conn.destroy(); return; }
    conn.setTimeout(CONN_IDLE_MS, () => conn.destroy());
    // Absolute deadline (slowloris defence); unref'd so it never keeps the process up.
    deadline = setTimeout(() => conn.destroy(), connDeadlineMs);
    deadline.unref();
    const chunks = [];
    let size = 0;
    let rejected = false;
    const reply = (obj) => { if (!conn.destroyed) conn.end(JSON.stringify(obj)); };
    conn.on('data', (c) => {
      if (rejected || conn.destroyed) return;
      // A job carries data (a liveness probe sends none, so it is never refused
      // here); if every worker slot is taken, refuse it now rather than buffer the
      // whole body first.
      if (inflight >= MAX_INFLIGHT) { rejected = true; return reply({ ok: false, error: 'busy' }); }
      size += c.length;
      if (size > MAX_JOB_BYTES) conn.destroy(); else chunks.push(c);
    });
    conn.on('end', async () => {
      if (conn.destroyed || rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      // A liveness probe connects and sends nothing: answer without forking a worker.
      if (raw.trim() === '') return reply({ ok: true, health: true });
      let job;
      try { job = JSON.parse(raw); } catch { return reply({ ok: false, error: 'bad_json' }); }
      if (inflight >= MAX_INFLIGHT) return reply({ ok: false, error: 'busy' });
      inflight += 1;
      let result;
      try { result = await runJob(job, { timeoutMs }); } finally { inflight -= 1; }
      reply(result);
    });
    conn.on('error', () => {});
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(socketPath); }); }),
  };
}
