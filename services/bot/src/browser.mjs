// The browser visitor of the support bot (C03 part B). It plugs into the controller as `visit(href, opts)`; each visit runs in its own child process (visit-worker.mjs) that gets
// no environment, a capped heap and a hard time limit, and is killed when the visit is over. The visitor never throws.
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./visit-worker.mjs', import.meta.url));
// The worker may read its own files and its dependencies and nothing else (Node permission model: no writes, no child processes, no worker threads, no addons).
export function readableDirs(worker) {
  const root = path.resolve(path.dirname(worker), '..');
  const dirs = new Set([root]);
  try {
    const real = fs.realpathSync(path.join(root, 'node_modules', 'jsdom')); // pnpm links the package into a store directory
    const i = real.indexOf(`${path.sep}.pnpm${path.sep}`);
    dirs.add(i === -1 ? path.resolve(real, '..') : real.slice(0, i + '.pnpm'.length + 1));
  } catch { /* no dependency directory: the worker will fail to start and the visit ends */ }
  return [...dirs];
}

export const SESSION_COOKIE = 'vm_sess'; // the shop's session cookie (apps/shop/src/web/session.mjs)

/**
 * @param {object} o
 * @param {string[]} o.origins  the origins the page may reach: the shop and the collector, nothing else (challenge-specs 3.7)
 * @param {number} [o.dwellMs]  how long the agent keeps the page open after it has loaded (challenge-specs 3.2 gives 15 s as a placeholder)
 * @param {number} [o.heapMb]   heap limit of the child process
 * @param {string} [o.worker]   path of the worker (tests may pass their own)
 */
export function createBrowserVisitor({ origins, dwellMs = 5000, heapMb = 72, worker = WORKER } = {}) {
  return async function visitBrowser(href, { timeoutMs = 20000, session = null, visitId = `v-${crypto.randomUUID()}` } = {}) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child?.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, status: 0, timedOut: true }), timeoutMs);
      try {
        child = fork(worker, [], { execArgv: [`--max-old-space-size=${heapMb}`, '--permission', ...readableDirs(worker).map((d) => `--allow-fs-read=${d}`)], env: { NODE_ENV: 'production', TZ: 'UTC' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
      } catch { return finish({ ok: false, status: 0 }); }
      child.once('message', (m) => finish({ ok: !!m?.ok, status: Number(m?.status) || 0, requests: m?.requests ?? 0 }));
      child.once('error', () => finish({ ok: false, status: 0 }));
      child.once('exit', () => setTimeout(() => finish({ ok: false, status: 0 }), 150)); // a result sent just before the exit is still read first
      child.send({ href, cookie: session ? { name: SESSION_COOKIE, value: session } : null, visitId, origins, dwellMs: Math.min(dwellMs, Math.max(0, timeoutMs - 5000)) });
    });
  };
}
