// C06 self-test (Vulnerable Components / prototype pollution, CWE-1321). A product
// import patch carrying `__proto__` pollutes Object.prototype in the worker on the
// vulnerable build and is dropped on the fixed build. The import service is a
// socket/worker service (not HTTP), so this drives runJob directly rather than the
// HTTP exploit runner. The pollution is contained in the fresh per-job worker
// process (no network, no database), so there is no code execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../../../services/import-service/src/server.mjs';

// A patch with an OWN `__proto__` key (as JSON.parse / the socket server produce).
const pollutingJob = () => JSON.parse('{"product":{"title":"widget","__proto__":{"polluted":true}}}');

async function runWith(mode, job) {
  const prev = process.env.VM_CHALLENGE_C06;
  process.env.VM_CHALLENGE_C06 = mode; // the forked worker inherits this
  try {
    return await runJob(job, {});
  } finally {
    if (prev === undefined) delete process.env.VM_CHALLENGE_C06; else process.env.VM_CHALLENGE_C06 = prev;
  }
}

test('C06 vulnerable build: the import merge pollutes the worker prototype', async () => {
  const r = await runWith('vulnerable', pollutingJob());
  assert.equal(r.ok, true);
  assert.equal(r.proto_check, 'polluted', 'expected prototype pollution on the vulnerable build');
});

test('C06 fixed build: the safe merge drops the dangerous key (no pollution)', async () => {
  const r = await runWith('fixed', pollutingJob());
  assert.equal(r.ok, true);
  assert.equal(r.proto_check, 'clean', 'the fixed safe merge must not pollute');
});

test('C06: the pollution is confined to the worker — this test process is clean', () => {
  // runJob forks a separate process; nothing it merges can touch this one.
  assert.equal({}.polluted, undefined, 'the parent/test process prototype is untouched');
});
