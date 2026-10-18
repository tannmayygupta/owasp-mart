import assert from 'node:assert/strict';
import test from 'node:test';
import { currentIp, parseArgs, removeKey, setList } from './allow-my-ip.mjs';

test('arguments: dry run, public web on or off, nothing else', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, publicWeb: null });
  assert.deepEqual(parseArgs(['--dry-run', '--public-web']), { dryRun: true, publicWeb: true });
  assert.equal(parseArgs(['--no-public-web']).publicWeb, false);
  assert.match(parseArgs(['--zzz']).error, /unknown argument/);
});

test('setList replaces the list in place, keeps the other lines and appends a missing key', () => {
  const t = 'region = "ap-southeast-2"\nssh_source_cidrs = ["203.0.113.5/32"]\nname = "x"\n';
  assert.equal(setList(t, 'ssh_source_cidrs', ['198.51.100.7']), 'region = "ap-southeast-2"\nssh_source_cidrs = ["198.51.100.7/32"]\nname = "x"\n');
  assert.match(setList('a = 1\n', 'public_web_cidrs', ['0.0.0.0/0'], { cidr: false }), /public_web_cidrs = \["0\.0\.0\.0\/0"\]\n$/);
  assert.throws(() => setList(t, 'ssh_source_cidrs', ['not-an-ip']), /not an IPv4/);
  assert.throws(() => setList(t, 'ssh_source_cidrs', ['999.1.1.1']), /not an IPv4/);
});

test('removeKey drops the line and nothing else', () => {
  assert.equal(removeKey('a = 1\npublic_web_cidrs = ["0.0.0.0/0"]\nb = 2\n', 'public_web_cidrs'), 'a = 1\nb = 2\n');
  assert.equal(removeKey('a = 1\n', 'public_web_cidrs'), 'a = 1\n');
});

test('the address service must answer with an IPv4 address', async () => {
  assert.equal(await currentIp(async () => ({ text: async () => '198.51.100.7\n' })), '198.51.100.7');
  await assert.rejects(currentIp(async () => ({ text: async () => '<html>' })), /IPv4/);
});