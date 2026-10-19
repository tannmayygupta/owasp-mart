// Tests of scripts/sandbox-probe.mjs (story L-29). A stub Docker; the real run is done on the lab host and recorded in docs/assets/production-readiness.
import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, parseFacts, PROGRAM, PROBE_LABEL, runProbe } from './sandbox-probe.mjs';

const HOST = '7.0.0-1014-aws';
const RUNC = 'kernel_release=7.0.0-1014-aws\nproc_version=Linux version 7.0.0-1014-aws (buildd)\ndmesg_first=dmesg: read kernel buffer failed: Operation not permitted\nkcore_read=refused\nmodules_listed=212\ndebugfs_listed=0\nmount_tmpfs=refused\nuser_namespace=refused\ncap_eff=0000000000000000\nprocesses_visible=3\ndev_nodes=14\n';
const RUNSC = 'kernel_release=4.4.0\nproc_version=Linux version 4.4.0 #1 SMP Sun Jan 10 15:06:54 PST 2016\ndmesg_first=[    0.000000] Starting gVisor...\nkcore_read=refused\nmodules_listed=0\ndebugfs_listed=0\nmount_tmpfs=refused\nuser_namespace=refused\ncap_eff=0000000000000000\nprocesses_visible=3\ndev_nodes=12\n';

function stub({ out, fail = false, socket = 'pong' } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (args[0] === 'version') return { code: 0, stdout: '29.0.0', stderr: '' };
    if (args[0] === 'image') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'volume' || args[0] === 'exec' || args[0] === 'rm') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'run' && args.includes('--rm') && args.some((a) => /\/v\/s\.sock/.test(String(a)))) return { code: 0, stdout: socket, stderr: '' };
    if (args[0] === 'run' && args.includes('-d')) return { code: 0, stdout: 'id', stderr: '' };
    if (args[0] === 'run') return fail ? { code: 125, stdout: '', stderr: 'docker: Error response from daemon: unknown or invalid runtime name: runsc' } : { code: 0, stdout: out, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

test('parseFacts reads key=value lines and ignores the rest', () => {
  assert.deepEqual(parseFacts('a=1\nnoise\nb=x=y\n'), { a: '1', b: 'x=y' });
});

test('under runsc the verdict is a user-space kernel; under runc it is the shared host kernel; a mix-up is a problem', () => {
  assert.deepEqual(judge('runsc', parseFacts(RUNSC), HOST), { ok: true, boundary: 'user-space kernel', problems: [] });
  assert.deepEqual(judge('runc', parseFacts(RUNC), HOST), { ok: true, boundary: 'shared host kernel', problems: [] });
  assert.match(judge('runsc', parseFacts(RUNC), HOST).problems.join(), /under runsc the container still sees the host kernel/);
  assert.match(judge('runc', parseFacts(RUNSC), HOST).problems.join(), /does not see the host kernel/);
});

test('a capability, an allowed mount or readable kernel memory fails the run whatever the runtime', () => {
  assert.match(judge('runsc', { ...parseFacts(RUNSC), cap_eff: '00000000a80425fb' }, HOST).problems.join(), /capabilities/);
  assert.match(judge('runsc', { ...parseFacts(RUNSC), mount_tmpfs: 'allowed' }, HOST).problems.join(), /mount was allowed/);
  const kc = judge('runsc', { ...parseFacts(RUNSC), kcore_read: 'readable' }, HOST);
  assert.equal(kc.ok, false);
  assert.equal(kc.boundary, 'shared host kernel');
});

test('the probe container has the instance profile, the runtime and the sandbox room; it is labelled and removed; the program only reads', () => {
  const d = stub({ out: RUNSC });
  const { exitCode, report } = runProbe({ docker: d, runtime: 'runsc', image: 'img', hostRelease: HOST, nonce: 'n1' });
  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(report.boundary, 'user-space kernel');
  const run = d.calls.find((c) => c[0] === 'run');
  for (const f of ['--read-only', '--cap-drop', 'no-new-privileges:true', '--pids-limit', '--memory', '--network', 'none']) assert.ok(run.includes(f), f);
  assert.equal(run[run.indexOf('--runtime') + 1], 'runsc');
  assert.equal(run[run.indexOf('--pids-limit') + 1], '128');
  assert.ok(run.includes(PROBE_LABEL) && !run.includes('--privileged') && !run.includes('-v') && !run.some((a) => /docker\.sock/.test(a)));
  for (const word of ['rm ', 'dd ', 'mkfs', 'chmod', 'kill ', 'curl', 'wget', 'nc ', 'ssh']) assert.ok(!PROGRAM.includes(word), `the program must only ask questions: `);
  assert.equal(runProbe({ docker: stub({ out: RUNC }), runtime: 'runc', image: 'img', hostRelease: HOST }).exitCode, 0);
  assert.equal(runProbe({ docker: stub({ out: RUNC }), runtime: 'runsc', image: 'img', hostRelease: HOST }).exitCode, 1);
});

test('a daemon without the runtime, a bad runtime name and a missing Docker are exit 2 with a plain message', () => {
  assert.equal(runProbe({ docker: stub({ fail: true }), runtime: 'runsc', image: 'img' }).exitCode, 2);
  assert.match(runProbe({ docker: stub({ fail: true }), runtime: 'runsc', image: 'img' }).report.error, /unknown or invalid runtime name/);
  assert.equal(runProbe({ docker: stub(), runtime: 'kata' }).exitCode, 2);
  assert.equal(runProbe({ docker: () => ({ code: -1, stdout: '', stderr: 'docker not found' }), runtime: 'runc' }).exitCode, 2);
});


test('the shared-socket check: two containers on one volume must talk through a unix socket under every runtime, or the import path would break', () => {
  const good = runProbe({ docker: stub({ out: RUNSC }), runtime: 'runsc', image: 'img', hostRelease: HOST, nonce: 's1' });
  assert.equal(good.report.facts.shared_socket, 'works');
  assert.equal(good.exitCode, 0, JSON.stringify(good.report));
  const broken = runProbe({ docker: stub({ out: RUNSC, socket: 'error ENOENT' }), runtime: 'runsc', image: 'img', hostRelease: HOST, nonce: 's2' });
  assert.equal(broken.exitCode, 1);
  assert.match(broken.report.problems.join(), /unix socket shared through a volume .* does not work \(fails \(error ENOENT\)\)/);
  const d = stub({ out: RUNSC });
  runProbe({ docker: d, runtime: 'runsc', image: 'img', hostRelease: HOST, nonce: 's3' });
  assert.ok(d.calls.some((c) => c[0] === 'volume' && c[1] === 'create') && d.calls.some((c) => c[0] === 'volume' && c[1] === 'rm'), 'the volume is made and removed');
  assert.ok(d.calls.filter((c) => c[0] === 'run').every((c) => c.includes('--cap-drop') && c.includes('--read-only') && !c.includes('--privileged')), 'every container of the check has the instance profile');
});