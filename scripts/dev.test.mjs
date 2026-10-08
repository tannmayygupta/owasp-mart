import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { parseArgs, hello, up, down, doctor, portFree, MSG_DOCKER_DOWN, msgPortBusy, HELLO_PORT, PROFILES, COMPOSE_FILE } from './dev.mjs';

function assertHelloCompose(calls) {
  const upCall = calls.find((c) => c.includes('up -d --wait'));
  assert.ok(upCall && upCall.includes('--profile hello'), 'up call');
  const downCall = calls.find((c) => c.includes(' down'));
  assert.ok(downCall && downCall.includes('--profile hello') && downCall.includes('--remove-orphans'), 'down call');
}

const dockerDown = (cmd, args) => ({ status: cmd === 'docker' && args[0] === 'info' ? 1 : 0, stdout: '', stderr: '' });
const collect = () => { const out = []; return { out, fn: (m) => out.push(String(m)) }; };

test('parseArgs: help forms', () => {
  assert.equal(parseArgs([]).cmd, 'help');
  assert.equal(parseArgs(['--help']).cmd, 'help');
});
test('parseArgs: simple commands and extra args', () => {
  assert.equal(parseArgs(['hello']).cmd, 'hello');
  assert.match(parseArgs(['doctor', 'x']).error, /no arguments/);
});
test('parseArgs: up needs valid profiles, dedupes', () => {
  assert.match(parseArgs(['up']).error, /at least one profile/);
  assert.match(parseArgs(['up', 'bogus']).error, /Unknown profile: bogus/);
  assert.deepEqual(parseArgs(['up', 'lab', 'lab', 'mocks']).profiles, ['lab', 'mocks']);
});
test('parseArgs: unknown command', () => {
  assert.match(parseArgs(['nope']).error, /Unknown command/);
});

test('hello: Docker down gives exit 1, message, and no compose up', async () => {
  const calls = [];
  const e = collect();
  const code = await hello({ runner: (c, a) => { calls.push(a.join(' ')); return dockerDown(c, a); }, err: e.fn, log: () => {} });
  assert.equal(code, 1);
  assert.equal(e.out[0], MSG_DOCKER_DOWN);
  assert.ok(!calls.some((c) => c.includes(' up ')));
});

test('hello: busy port gives exit 1 naming the port, no compose up', async () => {
  const calls = [];
  const e = collect();
  const code = await hello({
    runner: (c, a) => { calls.push(a.join(' ')); return { status: 0, stdout: '29.0.0\n', stderr: '' }; },
    isPortFree: async () => false, err: e.fn, log: () => {},
  });
  assert.equal(code, 1);
  assert.equal(e.out[0], msgPortBusy(HELLO_PORT));
  assert.match(e.out[0], /18080/);
  assert.ok(!calls.some((c) => c.includes(' up ')));
});

test('hello: success removes stale first, prints hello, always tears down', async () => {
  const calls = [];
  const l = collect();
  const code = await hello({
    runner: (c, a) => { calls.push(a.join(' ')); return { status: 0, stdout: '29.0.0\n', stderr: '' }; },
    isPortFree: async () => true, get: async () => ({ status: 200, body: 'hello\n' }), log: l.fn, err: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(l.out, ['hello']);
  assert.match(calls[1], /^rm -f vulnmart-hello/);
  assertHelloCompose(calls);
});

test('hello: bad HTTP answer exits 1 and still tears down', async () => {
  const calls = [];
  const code = await hello({
    runner: (c, a) => { calls.push(a.join(' ')); return { status: 0, stdout: '29.0.0\n', stderr: '' }; },
    isPortFree: async () => true, get: async () => ({ status: 500, body: '' }), log: () => {}, err: () => {},
  });
  assert.equal(code, 1);
  assertHelloCompose(calls);
});

test('up: Docker down exits 1', () => {
  const e = collect();
  assert.equal(up(['lab'], { runner: dockerDown, err: e.fn, log: () => {} }), 1);
  assert.equal(e.out[0], MSG_DOCKER_DOWN);
});
test('up: profile with no services exits 1 with a clear message', () => {
  const e = collect();
  const runner = (c, a) => ({ status: 0, stdout: a[0] === 'info' ? '29.0.0\n' : '\n', stderr: '' });
  assert.equal(up(['lab'], { runner, err: e.fn, log: () => {} }), 1);
  assert.match(e.out[0], /no services yet/);
});
test('up: requested profiles are all passed, starts with up -d --wait, logs Started', () => {
  const calls = [];
  const l = collect();
  const runner = (c, a) => {
    calls.push(a.join(' '));
    return { status: 0, stdout: a[0] === 'info' ? '29.0.0\n' : 'svc1\nsvc2\n', stderr: '' };
  };
  assert.equal(up(['lab', 'mocks'], { runner, log: l.fn, err: () => {} }), 0);
  const upCall = calls.find((c) => c.includes('up -d --wait'));
  assert.ok(upCall.includes('--profile lab') && upCall.includes('--profile mocks'));
  assert.match(l.out[0], /^Started:/);
});
test('up: config failure exits 1', () => {
  const runner = (c, a) => (a.includes('config') ? { status: 1, stdout: '', stderr: 'bad' } : { status: 0, stdout: '29.0.0\n', stderr: '' });
  assert.equal(up(['lab'], { runner, log: () => {}, err: () => {} }), 1);
});
test('down: Docker down exits 1', () => {
  assert.equal(down({ runner: dockerDown, err: () => {}, log: () => {} }), 1);
});
test('down: passes every profile and --remove-orphans, returns 0', () => {
  const calls = [];
  const runner = (c, a) => { calls.push(a.join(' ')); return { status: 0, stdout: '29.0.0\n', stderr: '' }; };
  assert.equal(down({ runner, log: () => {}, err: () => {} }), 0);
  const d = calls.find((c) => c.includes(' down'));
  for (const p of ['hello', ...PROFILES]) assert.ok(d.includes(`--profile ${p}`), p);
  assert.ok(d.includes('--remove-orphans'));
});

test('compose.yaml: hello hardening and limits are present', () => {
  const y = readFileSync(COMPOSE_FILE, 'utf8');
  for (const s of ['read_only: true', 'cap_drop', '- ALL', 'no-new-privileges:true', '127.0.0.1:18080:8080', 'mem_limit', 'pids_limit'])
    assert.ok(y.includes(s), s);
  assert.match(y, /^\s+user:\s*\S+/m);
  assert.doesNotMatch(y, /^\s*volumes:/m);
});

const pins = { node: '24.21.0', pnpm: '1.2.3' };
const okRunner = () => ({ status: 0, stdout: '1.2.3\n', stderr: '' });

test('doctor: all pass gives 0, a missing tool gives 1', () => {
  const l = collect();
  assert.equal(doctor({ runner: okRunner, log: l.fn, nodeVersion: 'v24.0.0', pins }), 0);
  assert.ok(l.out.every((s) => s.startsWith('PASS')));
  const noUv = (c, a) => (c === 'uv' ? { status: 127, stdout: '', stderr: '' } : okRunner(c, a));
  const l2 = collect();
  assert.equal(doctor({ runner: noUv, log: l2.fn, nodeVersion: 'v24.0.0', pins }), 1);
  assert.ok(l2.out.some((s) => s.startsWith('FAIL') && s.includes('uv')));
});
test('doctor: a different Node major fails and names the pin', () => {
  const l = collect();
  assert.equal(doctor({ runner: okRunner, log: l.fn, nodeVersion: 'v22.1.0', pins }), 1);
  assert.ok(l.out.some((s) => s.startsWith('FAIL') && s.includes('Node') && s.includes('24.21.0')));
});
test('doctor: a different pnpm version fails and names the pin', () => {
  const l = collect();
  assert.equal(doctor({ runner: okRunner, log: l.fn, nodeVersion: 'v24.0.0', pins: { ...pins, pnpm: '9.9.9' } }), 1);
  assert.ok(l.out.some((s) => s.startsWith('FAIL') && s.includes('pnpm') && s.includes('9.9.9')));
});

test('portFree: false when something listens', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await portFree(port), false);
  await new Promise((r) => srv.close(r));
  assert.equal(await portFree(port), true);
});
