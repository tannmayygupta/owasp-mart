// Tests of scripts/deploy.mjs with injected ssh and docker runners (story L-12). No Docker, SSH or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { main, helloImage, parseTargets, remoteCommands, localCommands, InputError, CONTAINER } from './deploy.mjs';
import { parseHosts } from './cloud-hosts.mjs';

const DIGEST = `sha256:${'c'.repeat(64)}`;
const IMAGE = `ghcr.io/owner/repo/hello@${DIGEST}`;
const manifest = (hello = IMAGE) => JSON.stringify({ commit: 'a'.repeat(40), images: { hello } });
// Documentation-range and private addresses only: not real hosts.
const hosts = parseHosts({ vm_p_public_ip: '192.0.2.10', vm_p_private_ip: '10.0.0.11', vm_i_public_ip: '192.0.2.20', vm_i_private_ip: '10.0.0.12' });

function harness({ sshFail = () => null, localFail = () => null, health = 'healthy', running = 'sha256:img1', pulled = 'sha256:img1' } = {}) {
  const calls = { ssh: [], local: [] };
  const out = [];
  const errs = [];
  return {
    calls, out, errs,
    inject: {
      log: (l) => out.push(l),
      err: (l) => errs.push(l),
      read: (f) => (f.endsWith('hello-stack.yaml') ? 'name: x\n' : manifest()),
      loadHosts: () => hosts,
      wait: async () => {},
      ssh: async (a) => {
        calls.ssh.push(a);
        return sshFail(a) ?? { code: 0, stdout: '', stderr: '' };
      },
      local: async (argv, env) => {
        calls.local.push({ argv, env });
        if (argv[1] === 'inspect' && argv[3] === '{{.State.Health.Status}}') return { code: 0, stdout: `${health}\n`, stderr: '' };
        if (argv[1] === 'inspect') return { code: 0, stdout: `${running}\n`, stderr: '' };
        if (argv[1] === 'image') return { code: 0, stdout: `${pulled}\n`, stderr: '' };
        return localFail(argv) ?? { code: 0, stdout: '', stderr: '' };
      },
    },
  };
}
const base = ['--manifest', 'release.json', '--identity', 'key', '--hosts', 'h.json'];

test('helloImage accepts a digest reference and refuses a tag (exit 2 path)', () => {
  assert.equal(helloImage(manifest()), IMAGE);
  assert.throws(() => helloImage(manifest('ghcr.io/owner/repo/hello:abc123')), InputError);
  assert.throws(() => helloImage(manifest('ghcr.io/owner/repo/hello:latest@sha256:short')), /not a digest reference/);
  assert.throws(() => helloImage(manifest('hello@' + DIGEST)), /not a digest reference/);
  assert.throws(() => helloImage('{}'), /no image "hello"/);
  assert.throws(() => helloImage('nope'), /not valid JSON/);
});

test('main: a tag entry exits 2 and runs nothing', async () => {
  const h = harness();
  h.inject.read = () => manifest('ghcr.io/o/r/hello:v1');
  assert.equal(await main([...base, '--target', 'p'], h.inject), 2);
  assert.deepEqual([h.calls.ssh.length, h.calls.local.length], [0, 0]);
  assert.match(h.errs.join('\n'), /tags are refused/);
});

test('parseTargets: list, dedupe, refuse unknown', () => {
  assert.deepEqual(parseTargets('p,i,local,p'), ['p', 'i', 'local']);
  assert.throws(() => parseTargets('x'), /unknown target/);
  assert.throws(() => parseTargets(''), /--target needs/);
});

test('dry run prints the commands and runs nothing, even without a key or an address file', async () => {
  const h = harness();
  assert.equal(await main(['--manifest', 'release.json', '--target', 'p,i,local', '--dry-run'], h.inject), 0);
  assert.deepEqual([h.calls.ssh.length, h.calls.local.length], [0, 0]);
  const text = h.out.join('\n');
  assert.match(text, /DRY vm-p ssh: sudo -n docker pull ghcr\.io\/owner\/repo\/hello@sha256:/);
  assert.match(text, /DRY vm-i ssh:/);
  assert.match(text, /DRY local docker pull /);
  assert.ok(!/192\.0\.2|10\.0\.0/.test(text), 'no address printed');
});

test('deploy to both VMs: copy, pull by digest, compose up, health, one line per step', async () => {
  const h = harness();
  assert.equal(await main([...base, '--target', 'p,i'], h.inject), 0);
  assert.equal(h.calls.ssh.length, 10);
  assert.deepEqual(h.calls.ssh.slice(0, 5).map((c) => c.host), Array(5).fill('192.0.2.10'));
  assert.equal(h.calls.ssh[5].host, '192.0.2.20');
  assert.equal(h.calls.ssh[0].input, 'name: x\n');
  assert.equal(h.calls.ssh[0].identity, 'key');
  assert.equal(h.calls.ssh[1].command, remoteCommands(IMAGE).pull);
  assert.match(h.calls.ssh[2].command, /env HELLO_IMAGE=ghcr\.io\/owner\/repo\/hello@sha256:c+ docker compose .* up -d --force-recreate --pull never/);
  assert.equal(h.calls.ssh[3].command, remoteCommands(IMAGE).verify);
  assert.ok(h.calls.ssh.every((c) => c.timeoutMs === 600000), 'every ssh call has the default timeout');
  assert.ok(h.calls.ssh[4].command.includes(CONTAINER));
  assert.equal(h.out.filter((l) => l.startsWith('PASS')).length, 10);
  assert.equal(h.out.at(-1), 'RESULT PASS');
});

test('local target: same compose file on this machine, image passed in the environment', async () => {
  const h = harness();
  assert.equal(await main(['--manifest', 'release.json', '--target', 'local'], h.inject), 0);
  assert.deepEqual(h.calls.local[0].argv, localCommands(IMAGE).pull);
  assert.equal(h.calls.local[1].env.HELLO_IMAGE, IMAGE);
  assert.ok(h.calls.local[1].argv.some((a) => a.endsWith('hello-stack.yaml')));
  assert.equal(h.calls.ssh.length, 0);
  assert.match(h.out.join('\n'), /PASS local health check/);
});

test('local target: a container that never becomes healthy fails with exit 1', async () => {
  const h = harness({ health: 'starting' });
  assert.equal(await main(['--manifest', 'release.json', '--target', 'local'], { ...h.inject }), 1);
  assert.match(h.out.join('\n'), /FAIL local health check - status=starting/);
});

test('a failed step stops that target with exit 1; the next target runs only with --continue', async () => {
  const failPull = (a) => (a.host === '192.0.2.10' && /docker pull/.test(a.command ?? '') ? { code: 1, stdout: '', stderr: 'pull access denied for 192.0.2.10' } : null);
  const h1 = harness({ sshFail: failPull });
  assert.equal(await main([...base, '--target', 'p,i'], h1.inject), 1);
  assert.ok(h1.calls.ssh.every((c) => c.host === '192.0.2.10'), 'vm-i was not touched');
  assert.match(h1.out.join('\n'), /FAIL vm-p pull - pull access denied for <vm-p-public>/);
  const h2 = harness({ sshFail: failPull });
  assert.equal(await main([...base, '--target', 'p,i', '--continue'], h2.inject), 1);
  assert.ok(h2.calls.ssh.some((c) => c.host === '192.0.2.20'), 'vm-i ran');
  assert.match(h2.out.join('\n'), /RESULT FAIL \(1 target/);
});

test('an unreachable host gives a clear error without an address', async () => {
  const h = harness({ sshFail: () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host 192.0.2.10 port 22: Connection timed out' }) });
  assert.equal(await main([...base, '--target', 'p'], h.inject), 1);
  const text = h.out.join('\n');
  assert.match(text, /FAIL vm-p copy compose file - cannot reach the host over ssh/);
  assert.ok(!text.includes('192.0.2.10'));
});

test('options: ssh targets need a key, bad targets and a missing manifest exit 2', async () => {
  const h = harness();
  assert.equal(await main(['--manifest', 'release.json', '--target', 'p', '--hosts', 'h.json'], h.inject), 2);
  assert.match(h.errs.join(), /--identity/);
  assert.equal(await main(['--manifest', 'release.json', '--target', 'q'], harness().inject), 2);
  assert.equal(await main(['--target', 'p'], harness().inject), 2);
  const h3 = harness();
  h3.inject.read = () => {
    throw new Error('ENOENT');
  };
  assert.equal(await main(['--manifest', 'nope.json', '--target', 'p', '--dry-run'], h3.inject), 2);
  const h2 = harness();
  h2.inject.loadHosts = () => {
    throw new Error('no address file found');
  };
  assert.equal(await main([...base.slice(0, 4), '--target', 'p'], h2.inject), 2);
});

test('the manifest may start with a byte order mark', () => {
  assert.equal(helloImage(String.fromCharCode(0xfeff) + manifest()), IMAGE);
});

test('a ref from another registry exits 2', async () => {
  assert.throws(() => helloImage(manifest(`docker.io/owner/repo/hello@${DIGEST}`)), /not from the registry/);
  const h = harness();
  h.inject.read = () => manifest(`quay.io/o/r/hello@${DIGEST}`);
  assert.equal(await main([...base, '--target', 'p'], h.inject), 2);
  assert.equal(h.calls.ssh.length, 0);
});

test('--user and --identity are validated; an option that needs a value but has none exits 2', async () => {
  for (const bad of [['--user', 'root;x'], ['--user', '-oProxyCommand=x'], ['--user', 'Bob'], ['--identity', '-oProxyCommand=x']]) {
    const h = harness();
    const args = bad[0] === '--user' ? [...base, '--target', 'p', ...bad] : ['--manifest', 'release.json', '--hosts', 'h.json', '--target', 'p', ...bad];
    assert.equal(await main(args, h.inject), 2, bad.join(' '));
    assert.equal(h.calls.ssh.length, 0);
  }
  for (const last of ['--identity', '--user', '--target', '--timeout', '--manifest']) assert.equal(await main([...base, '--target', 'p', last], harness().inject), 2, last);
  assert.equal(await main([...base, '--target', 'p', '--timeout', 'abc'], harness().inject), 2);
  const h = harness();
  assert.equal(await main([...base, '--target', 'p', '--user', 'deploy_1'], h.inject), 0);
  assert.equal(h.calls.ssh[0].user, 'deploy_1');
});

test('--timeout reaches every ssh and local call', async () => {
  const h = harness();
  assert.equal(await main([...base, '--target', 'p,local', '--timeout', '5'], h.inject), 0);
  assert.ok(h.calls.ssh.every((c) => c.timeoutMs === 5000));
  assert.ok(h.calls.local.length > 0);
});

test('the error detail is redacted before it is truncated (an address that straddles the cut does not leak)', async () => {
  const long = `${'x'.repeat(290)} 192.0.2.10 tail`;
  const h = harness({ sshFail: (a) => (/docker pull/.test(a.command ?? '') ? { code: 1, stdout: '', stderr: long } : null) });
  assert.equal(await main([...base, '--target', 'p'], h.inject), 1);
  const text = h.out.join('\n');
  assert.ok(!/192\.0\.2|\b192\.0\b/.test(text), 'no address or address fragment');
});

test('after compose up the running container must use the pulled image, else the step fails (ssh and local)', async () => {
  const h = harness({ sshFail: (a) => (a.command === remoteCommands(IMAGE).verify ? { code: 1, stdout: 'the running container does not use the pulled image', stderr: '' } : null) });
  assert.equal(await main([...base, '--target', 'p'], h.inject), 1);
  assert.match(h.out.join('\n'), /FAIL vm-p verify image - the running container does not use the pulled image/);
  assert.ok(!h.calls.ssh.some((c) => c.command.includes('Health.Status')), 'no health check after a mismatch');
  const l = harness({ running: 'sha256:old', pulled: 'sha256:new' });
  assert.equal(await main(['--manifest', 'release.json', '--target', 'local'], l.inject), 1);
  assert.match(l.out.join('\n'), /FAIL local verify image - the running container does not use the pulled image/);
});