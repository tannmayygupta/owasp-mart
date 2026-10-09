// Self-test for the exploit-runner skeleton (T-05, TB-4): the demo exploit must
// PASS against the vulnerable stub and FAIL against the fixed stub, and ERROR
// when nothing is listening. Node built-ins only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStub } from './stub.mjs';
import exploit from './exploit.mjs';
import { runExploit, main } from '../runner/run-exploit.mjs';

// Absolute path to the demo exploit, for driving the CLI by --test.
const EXPLOIT = fileURLToPath(new URL('./exploit.mjs', import.meta.url));

function quiet(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

function listen(mode) {
  const server = createStub(mode);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('demo exploit PASSES against the vulnerable stub', async () => {
  const { server, baseUrl } = await listen('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'demo', test: exploit });
    assert.equal(r.passed, true, r.detail);
    assert.equal(r.errored, false);
  } finally {
    server.close();
  }
});

test('demo exploit FAILS against the fixed stub (not an error)', async () => {
  const { server, baseUrl } = await listen('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'demo', test: exploit });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'a fixed target is a clean fail, not an error');
    assert.equal(r.errored, false);
  } finally {
    server.close();
  }
});

test('runner reports ERROR when the target is unreachable', async () => {
  // Port 1 on loopback has nothing listening; the fetch is refused.
  const r = await runExploit({ baseUrl: 'http://127.0.0.1:1', name: 'demo', test: exploit, timeoutMs: 2000 });
  assert.equal(r.errored, true);
  assert.equal(r.passed, false);
});

test('CLI main(): --help is 0, missing args is 2', async () => {
  assert.equal(await quiet(() => main(['--help'])), 0);
  assert.equal(await quiet(() => main(['--url', 'http://x'])), 2);
  assert.equal(await quiet(() => main(['--bogus'])), 2);
  assert.equal(await quiet(() => main(['--url', 'http://x', '--test', EXPLOIT, '--timeout', 'abc'])), 2);
});

test('CLI main(): a missing exploit module errors (3), not fixed (1)', async () => {
  const code = await quiet(() => main(['--url', 'http://127.0.0.1:1', '--test', './does-not-exist.mjs']));
  assert.equal(code, 3);
});

test('CLI main(): exit code maps outcome (0 vulnerable, 1 fixed, 3 unreachable)', async () => {
  const vuln = await listen('vulnerable');
  try {
    assert.equal(await quiet(() => main(['--url', vuln.baseUrl, '--test', EXPLOIT])), 0);
  } finally {
    vuln.server.close();
  }
  const fixed = await listen('fixed');
  try {
    assert.equal(await quiet(() => main(['--url', fixed.baseUrl, '--test', EXPLOIT])), 1);
  } finally {
    fixed.server.close();
  }
  assert.equal(await quiet(() => main(['--url', 'http://127.0.0.1:1', '--test', EXPLOIT, '--timeout', '2000'])), 3);
});
