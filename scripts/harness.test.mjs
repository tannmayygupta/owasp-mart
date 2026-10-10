import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runHarness, harnessDown, leftovers, scrub, containerName, SERVICES, PROJECT, liveChecks } from './harness.mjs';
import { goodConfig } from './conformance-fixtures.mjs';
import { freshValues, injectionDocument, sidecarStartDocument } from '../contracts/mocks/stub-instance/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = /^VM\{[A-Z2-7]{24}\}$/;

// A fake Docker: records every command and every spawned `docker start -a -i`, answers health as healthy.
function fake({ injectorExit = 0, buildStatus = 0 } = {}) {
  const t = { commands: [], spawned: [], stdin: {}, events: [] };
  const runner = (cmd, args) => {
    const line = args.join(' ');
    t.commands.push(line);
    t.events.push(line);
    if (line.includes(' build ')) return { status: buildStatus, stdout: '', stderr: 'build failed' };
    if (line.includes('Health.Status')) return { status: 0, stdout: 'healthy\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const spawner = (cmd, args) => {
    const name = args.at(-1);
    t.spawned.push(name);
    t.events.push(`spawn ${name}`);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let doc = '';
    child.stdin.on('data', (c) => { doc += c; t.stdin[name] = doc; });
    child.stdin.on('end', () => { if (name.endsWith('-injector')) setTimeout(() => { t.events.push('injector-exited'); child.emit('close', injectorExit); }, 5); });
    return child;
  };
  return { t, runner, spawner };
}
const base = (f, over = {}) => ({ runner: f.runner, spawner: f.spawner, sleepFn: async () => {}, portPicker: async () => 18123, resolveConfig: () => goodConfig(), log: () => {}, err: () => {}, ...over });
const downCalls = (f) => f.t.commands.filter((c) => c.includes(' down ') || c.endsWith(' down')).length;

test('start order: the injector exits before the shop, gate, sidecar and edge start; volume keeper and ingest first', async () => {
  const f = fake();
  const values = freshValues();
  const errs = [];
  const code = await runHarness(base(f, { values, err: (m) => errs.push(m), live: async () => [{ rule: 'x', ok: true, detail: '' }] }));
  assert.equal(code, 0, errs.join('|'));
  const idx = (s) => f.t.events.findIndex((e) => e.includes(s));
  assert.ok(idx('start vulnmart-harness-volume-keeper') < idx('spawn vulnmart-harness-ingest'));
  assert.ok(idx('spawn vulnmart-harness-ingest') < idx('spawn vulnmart-harness-injector'));
  assert.ok(idx('injector-exited') < idx('start vulnmart-harness-shop'));
  assert.ok(idx('injector-exited') < idx('start vulnmart-harness-gate'));
  assert.ok(idx('injector-exited') < idx('spawn vulnmart-harness-sidecar'));
  assert.ok(idx('injector-exited') < idx('start vulnmart-harness-edge'));
  assert.ok(idx(' build ') < idx(' create '), 'build before create');
  assert.equal(downCalls(f), 1, 'the teardown at the end (nothing is removed at the start)');
  assert.match(f.t.commands.at(-1), /down --volumes --remove-orphans/);
  // standard input carries the documents, and only there
  assert.deepEqual(JSON.parse(f.t.stdin['vulnmart-harness-injector']), injectionDocument(values));
  assert.deepEqual(JSON.parse(f.t.stdin['vulnmart-harness-sidecar']), sidecarStartDocument(values));
  assert.deepEqual(JSON.parse(f.t.stdin['vulnmart-harness-ingest']), sidecarStartDocument(values));
});

test('no secret ever appears in a docker command line, a log line or an error line', async () => {
  const f = fake();
  const values = freshValues();
  const out = [];
  await runHarness(base(f, { values, log: (m) => out.push(m), err: (m) => out.push(m), live: async () => [{ rule: 'x', ok: true, detail: '' }] }));
  const secrets = [values.seed, values.event_key, ...values.flags.map((x) => x.flag)];
  const seen = [...f.t.commands, ...out].join('\n');
  for (const s of secrets) assert.ok(!seen.includes(s));
});

test('a failing injector stops the run: names the step and the exit, the shop is never started, everything is torn down', async () => {
  for (const [exit, word] of [[10, 'bad document'], [11, 'snapshot patch failed'], [12, 'placement write failed'], [13, 'flags file or marker write failed']]) {
    const f = fake({ injectorExit: exit });
    const errs = [];
    const code = await runHarness(base(f, { err: (m) => errs.push(m) }));
    assert.equal(code, 1);
    assert.ok(errs.some((e) => e.startsWith('FAIL step injector') && e.includes(`exited ${exit} (${word})`)), errs.join('|'));
    assert.ok(!f.t.events.some((e) => e.includes('start vulnmart-harness-shop') || e.includes('spawn vulnmart-harness-sidecar') || e.includes('start vulnmart-harness-edge')), 'nothing else started');
    assert.equal(downCalls(f), 1);
  }
});

test('a build failure stops before create and still tears down', async () => {
  const f = fake({ buildStatus: 1 });
  const errs = [];
  assert.equal(await runHarness(base(f, { err: (m) => errs.push(m) })), 1);
  assert.ok(errs[0].startsWith('FAIL step build'));
  assert.ok(!f.t.commands.some((c) => c.includes(' create')));
  assert.equal(downCalls(f), 1);
});

test('a resolved config that breaks the profile stops before create and names the rule', async () => {
  const f = fake();
  const bad = goodConfig();
  bad.services.shop.read_only = false;
  const errs = [];
  assert.equal(await runHarness(base(f, { resolveConfig: () => bad, err: (m) => errs.push(m) })), 1);
  assert.ok(errs.some((e) => e.includes('FAIL  read-only-root')));
  assert.ok(errs.some((e) => e.startsWith('FAIL step conformance-config')));
  assert.ok(!f.t.commands.some((c) => c.includes(' create')));
  assert.equal(downCalls(f), 1);
});

test('a failed live check fails the run (exit 1) and tears down; a passed run with --keep leaves the stack up', async () => {
  const f = fake();
  const errs = [];
  assert.equal(await runHarness(base(f, { err: (m) => errs.push(m), live: async () => [{ rule: 'live-planted-flag', ok: false, detail: 'nope' }] })), 1);
  assert.ok(errs.some((e) => e.includes('FAIL  live-planted-flag: nope')));
  assert.equal(downCalls(f), 1);
  const k = fake();
  const logs = [];
  assert.equal(await runHarness(base(k, { keep: true, log: (m) => logs.push(m), live: async () => [{ rule: 'x', ok: true, detail: '' }] })), 0);
  assert.equal(downCalls(k), 0, 'nothing is torn down with --keep');
  assert.ok(logs.some((l) => l.includes('harness down')));
});

test('a container that never becomes healthy fails the run naming it', async () => {
  const f = fake();
  const runner = (cmd, args) => (args.join(' ').includes('Health.Status') ? { status: 0, stdout: 'starting\n', stderr: '' } : f.runner(cmd, args));
  const errs = [];
  assert.equal(await runHarness(base(f, { runner, healthTimeoutMs: 1, err: (m) => errs.push(m) })), 1);
  assert.ok(errs[0].includes('FAIL step start ingest') && errs[0].includes('did not become healthy'));
});

test('harnessDown removes containers, networks and volumes of the harness project', () => {
  const calls = [];
  const code = harnessDown({ runner: (c, a) => { calls.push(a.join(' ')); return { status: 0, stdout: '', stderr: '' }; }, log: () => {}, err: () => {} });
  assert.equal(code, 0);
  assert.match(calls[0], new RegExp(`-p ${PROJECT} down --volumes --remove-orphans`));
  assert.equal(harnessDown({ runner: () => ({ status: 1, stdout: '', stderr: 'boom' }), log: () => {}, err: () => {} }), 1);
});

test('leftovers lists what remains of the project', () => {
  const r = (c, a) => ({ status: 0, stdout: a[0] === 'ps' ? 'vulnmart-harness-shop\n' : '', stderr: '' });
  assert.deepEqual(leftovers(r), { containers: ['vulnmart-harness-shop'], networks: [], volumes: [] });
});

test('scrub replaces every secret value', () => {
  assert.equal(scrub('a SECRET b SECRET', ['SECRET', '']), 'a <redacted> b <redacted>');
});

test('service names: the harness has the five stub roles plus the two helpers', () => {
  assert.deepEqual([...SERVICES].sort(), ['edge', 'gate', 'ingest', 'injector', 'shop', 'sidecar', 'volume-keeper']);
  assert.equal(containerName('shop'), 'vulnmart-harness-shop');
});

test('fresh values: new at every run, flags in the contract format, the key obviously fake', () => {
  const a = freshValues();
  const b = freshValues();
  assert.notEqual(a.seed, b.seed);
  assert.notEqual(a.event_key, b.event_key);
  assert.notEqual(a.flags[0].flag, b.flags[0].flag);
  assert.notEqual(a.instance_id, b.instance_id);
  assert.equal(a.flags.length, 11);
  for (const f of a.flags) assert.match(f.flag, FLAG);
  assert.match(a.instance_id, /^i-[A-Z2-7]{16}$/);
  assert.match(a.event_key, /^FAKE-TEST-KEY-/);
  assert.ok(a.first_seq > 1);
  assert.ok(a.seed.length >= 32 && a.seed.length <= 128);
});

test('no flag-looking literal in the stub sources, the harness or the compose files', () => {
  const dirs = [path.join(ROOT, 'contracts', 'mocks', 'stub-instance'), path.join(ROOT, 'infra', 'compose')];
  const files = [path.join(ROOT, 'scripts', 'harness.mjs'), path.join(ROOT, 'scripts', 'check-instance-conformance.mjs'), path.join(ROOT, 'scripts', 'conformance-fixtures.mjs')];
  for (const d of dirs) for (const n of fs.readdirSync(d)) if (fs.statSync(path.join(d, n)).isFile()) files.push(path.join(d, n));
  assert.ok(files.length > 10);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/VM\{[A-Z2-7]{24}\}/.test(text), `${path.relative(ROOT, f)} holds a flag-looking value`);
    assert.ok(!text.includes('VM{'), `${path.relative(ROOT, f)} holds the literal VM{`);
  }
});

// ---- liveChecks against a fake stack: each check can fail, and a leaked secret is found ----
function fakeStack(values, over = {}) {
  const flagsFile = JSON.stringify({ schema_version: '0.1', instance_id: values.instance_id, epoch: 1, flags: values.flags });
  const good = (name) => ({ Name: `/${name}`, Config: { User: '65532:65532', Env: ['TZ=UTC'], Labels: { 'vm.kind': name.endsWith('ingest') || name.endsWith('keeper') ? 'harness' : 'inst' } }, HostConfig: { ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges:true'], CapDrop: ['ALL'], Privileged: false, PortBindings: {}, NetworkMode: name.endsWith('injector') ? 'none' : 'x' }, Mounts: [], NetworkSettings: { Networks: name.endsWith('injector') ? { none: {} } : { x: {} } } });
  const state = { ingest: [], logs: '', ...over };
  const runner = (cmd, args) => {
    const line = args.join(' ');
    const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
    if (line.includes('cat /run/vm/flags.json')) return ok(state.flagsFile ?? flagsFile);
    if (line.includes('stat -c')) return ok(state.stat ?? '400\n444\n');
    if (line.includes('_fake/events')) return ok(JSON.stringify(state.ingest));
    if (line.startsWith('logs')) return ok(state.logs);
    if (line.startsWith('inspect')) return ok(JSON.stringify(SERVICES.map((s) => good(containerName(s)))));
    if (line.includes('cat /data/shop.db') || line.includes('cat /run/vm/snapshot.db')) return ok(state.db ?? '{}');
    return ok('');
  };
  const get = async (p, o = {}) => {
    if (p === '/healthz') return { status: 200, text: '{"status":"ok"}' };
    if (p === '/readyz') return { status: 200, text: '{"status":"ready"}' };
    if (p === '/version') return { status: 200, text: state.version ?? '{"build_id":"stub","catalogue_version":"x"}' };
    if (p.startsWith('/_stub/planted-flag')) return { status: 200, text: JSON.stringify({ flag: state.served ?? values.flags[2].flag }) };
    const kind = JSON.parse(o.body).kind;
    const answers = { valid: 202, 'too-big': 413, 'wrong-type': 415, 'bad-json': 400, 'forbidden-source': 422, get: 405, ...(state.answers || {}) };
    if (kind === 'valid') state.ingest = [{ instance_id: values.instance_id, seq: values.first_seq, type: 'shop.catalog_query_error' }];
    return { status: 200, text: JSON.stringify({ sidecar_status: answers[kind] }) };
  };
  return { runner, get };
}
const failedRules = async (values, over) => { const s = fakeStack(values, over); return (await liveChecks({ runner: s.runner, values, port: 1, get: s.get })).filter((r) => !r.ok).map((r) => r.rule); };

test('liveChecks: a conforming stack passes every check', async () => {
  assert.deepEqual(await failedRules(freshValues()), []);
});
test('liveChecks: each deviation fails the check that names it', async () => {
  const v = freshValues();
  assert.deepEqual(await failedRules(v, { served: 'something else' }), ['live-planted-flag']);
  assert.deepEqual(await failedRules(v, { stat: '644\n644\n' }), ['live-flags-file-and-marker-modes']);
  assert.deepEqual(await failedRules(v, { answers: { 'too-big': 202 } }), ['live-event-error-answers']);
  assert.deepEqual(await failedRules(v, { logs: `oops ${v.flags[0].flag}` }), ['live-no-secret-in-logs']);
  assert.deepEqual(await failedRules(v, { db: v.seed }), ['live-no-secret-in-files']);
  assert.deepEqual(await failedRules(v, { version: JSON.stringify({ build_id: v.event_key }) }), ['live-version', 'live-no-secret-in-answers']);
});
// ---- fail fast, teardown result, feeder exit, existing instance ----
test('a container that has exited fails the run at once with its exit code (no waiting for the timeout)', async () => {
  const f = fake();
  const runner = (cmd, args) => {
    const line = args.join(' ');
    if (line.includes('Health.Status')) return { status: 0, stdout: 'starting\n', stderr: '' };
    if (line.includes('{{.State.Status}}')) return { status: 0, stdout: 'exited\n', stderr: '' };
    if (line.includes('{{.State.ExitCode}}')) return { status: 0, stdout: '3\n', stderr: '' };
    return f.runner(cmd, args);
  };
  let sleeps = 0;
  const errs = [];
  assert.equal(await runHarness(base(f, { runner, healthTimeoutMs: 600000, sleepFn: async () => { sleeps++; }, err: (m) => errs.push(m) })), 1);
  assert.equal(sleeps, 0, 'returned at once');
  assert.ok(errs[0].includes('FAIL step start ingest') && errs[0].includes('exited') && errs[0].includes('exit code 3'), errs[0]);
});

test('a teardown that fails after a passing run makes the run exit 1', async () => {
  const f = fake();
  const runner = (cmd, args) => (args.join(' ').includes(' down ') ? { status: 1, stdout: '', stderr: 'cannot remove' } : f.runner(cmd, args));
  const errs = [];
  assert.equal(await runHarness(base(f, { runner, err: (m) => errs.push(m), live: async () => [{ rule: 'x', ok: true, detail: '' }] })), 1);
  assert.ok(errs.some((e) => e.startsWith('FAIL step teardown')));
});

test('a start-document feeder that exits non-zero before the service is healthy fails with that exit code, not a timeout', async () => {
  const f = fake();
  const spawner = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', () => {});
    child.stdin.on('end', () => setTimeout(() => child.emit('close', 2), 1));
    return child;
  };
  const runner = (cmd, args) => (args.join(' ').includes('Health.Status') ? { status: 0, stdout: 'starting\n', stderr: '' } : f.runner(cmd, args));
  const errs = [];
  let sleeps = 0;
  assert.equal(await runHarness(base(f, { runner, spawner, healthTimeoutMs: 600000, sleepFn: async () => { sleeps++; await new Promise((r) => setTimeout(r, 5)); }, err: (m) => errs.push(m) })), 1);
  assert.ok(errs[0].includes('feeder exited with code 2'), errs[0]);
  assert.ok(sleeps < 50);
});

test('an existing harness instance is refused with a message naming `harness down`, and nothing of it is removed', async () => {
  const f = fake();
  const runner = (cmd, args) => (args[0] === 'ps' ? { status: 0, stdout: 'vulnmart-harness-shop\n', stderr: '' } : f.runner(cmd, args));
  const errs = [];
  assert.equal(await runHarness(base(f, { runner, err: (m) => errs.push(m) })), 1);
  assert.ok(errs[0].includes('harness down') && errs[0].includes('already exists'), errs[0]);
  assert.equal(downCalls(f), 0, 'no down');
  assert.ok(!f.t.commands.some((c) => c.includes(' build ') || c.includes(' create')));
});