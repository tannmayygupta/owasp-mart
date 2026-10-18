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
  // Send the result, then exit only once the IPC message has flushed: exiting
  // immediately after process.send can drop the message (the channel is async,
  // notably on Windows), which the parent would see as a crash, not a result.
  const done = (msg) => process.send(msg, () => process.exit(0));
  const run = () => {
    try {
      const result = preview(job);
      // Self-check that the merge did not pollute this process's Object.prototype.
      const protoCheck = ({}).polluted === undefined && ({}).x === undefined ? 'clean' : 'polluted';
      done({ ok: true, preview: result, worker_pid: process.pid, proto_check: protoCheck });
    } catch {
      done({ ok: false, error: 'preview_failed', worker_pid: process.pid });
    }
  };
  if (delay > 0) setTimeout(run, delay); else run();
});

// How deep safeMerge will recurse. A legitimate product patch is shallow; a
// deeply nested patch is bounded here so it cannot overflow the stack (a cheap
// denial of service), the value at the cap being taken as-is rather than merged.
const MAX_MERGE_DEPTH = 8;

// Merge the submitted product fields over the defaults. SAFE: keys that would
// pollute a prototype are dropped, arrays replace (not merge), and recursion is
// bounded to MAX_MERGE_DEPTH.
function safeMerge(base, patch, depth = 0) {
  const out = { ...base };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // A nested object at the depth cap is DROPPED, not assigned raw: assigning
        // it would copy its keys without the dangerous-key filter the recursion
        // applies at every shallower level. A legitimate product patch is shallow.
        if (depth >= MAX_MERGE_DEPTH) continue;
        out[k] = safeMerge(out[k] && typeof out[k] === 'object' ? out[k] : {}, v, depth + 1);
      } else {
        out[k] = v; // primitive or array: replace
      }
    }
  }
  return out;
}

// C06 — Vulnerable/Outdated Components (OWASP 2021 A06 / 2025 A03), CWE-1321.
// The DELIBERATELY VULNERABLE merge: a naive recursive merge with NO dangerous-key
// filter, so a product patch carrying `__proto__` pollutes Object.prototype. It is
// contained in this fresh per-job process (no network, no database), so the only
// effect is prototype pollution within a process that is about to exit — no code
// execution. Active only when VM_CHALLENGE_C06=vulnerable (default: the safe merge).
function unsafeMerge(base, patch) {
  const out = base;
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (out[k] == null || typeof out[k] !== 'object') out[k] = {};
        unsafeMerge(out[k], v); // recurses into out["__proto__"] -> pollutes the prototype
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function isC06Vulnerable() {
  return process.env.VM_CHALLENGE_C06 === 'vulnerable' || process.env.VM_CHALLENGE_MODE === 'vulnerable';
}

function preview(job) {
  const defaults = { title: '', description: '', price_cents: 0, tags: [] };
  const patch = job && typeof job.product === 'object' ? job.product : {};
  return isC06Vulnerable() ? unsafeMerge({ ...defaults }, patch) : safeMerge(defaults, patch);
}
