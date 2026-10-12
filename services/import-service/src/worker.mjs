// Per-job worker (T-12). A fresh process is forked for each job, so anything it
// does — including a future C06 prototype pollution — dies when it exits. It
// computes a product-import PREVIEW with a SAFE merge (prototype-polluting keys
// are dropped); the deliberate vulnerable merge (lodash) is the C06 challenge,
// added later in an isolated path. The worker opens no network and no database.
process.on('message', (m) => {
  const job = (m && m.job) || {};
  // `__delay_ms` is a TEST-ONLY hook to exercise the timeout path; it is honored
  // only when VM_IMPORT_TEST_HOOKS=1, so a client cannot pin a worker in production.
  const delay = process.env.VM_IMPORT_TEST_HOOKS === '1' ? Math.min(Number(job.__delay_ms) || 0, 60000) : 0;
  const run = () => {
    try {
      const result = preview(job);
      // Self-check that the merge did not pollute this process's Object.prototype.
      const protoCheck = ({}).polluted === undefined && ({}).x === undefined ? 'clean' : 'polluted';
      process.send({ ok: true, preview: result, worker_pid: process.pid, proto_check: protoCheck });
    } catch {
      process.send({ ok: false, error: 'preview_failed', worker_pid: process.pid });
    }
    process.exit(0);
  };
  if (delay > 0) setTimeout(run, delay); else run();
});

// Merge the submitted product fields over the defaults. SAFE: keys that would
// pollute a prototype are dropped, and arrays replace (not merge).
function safeMerge(base, patch) {
  const out = { ...base };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? safeMerge(out[k] && typeof out[k] === 'object' ? out[k] : {}, v) : v;
    }
  }
  return out;
}

function preview(job) {
  const defaults = { title: '', description: '', price_cents: 0, tags: [] };
  return safeMerge(defaults, job && typeof job.product === 'object' ? job.product : {});
}
