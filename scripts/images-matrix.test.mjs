// Tests of the image matrix and the release manifest (story L-12). No Docker, GitHub or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateImages, buildMatrix, loadImages, main } from './images-matrix.mjs';
import { buildRelease, main as releaseMain } from './images-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const good = () => ({ registry: 'ghcr.io', images: [{ name: 'hello', context: 'infra/hello', dockerfile: 'infra/hello/Dockerfile', platforms: ['linux/amd64'], public: true }] });
const two = () => {
  const d = good();
  d.images[0].platforms = ['linux/amd64', 'linux/arm64'];
  return d;
};

test('the repository file is valid and its files exist', () => {
  assert.deepEqual(validateImages(loadImages(), (p) => existsSync(path.join(ROOT, p))), []);
});

test('matrix: amd64 only by default, arm64 rows only with the switch', () => {
  assert.deepEqual(buildMatrix(two()).include.map((r) => r.arch), ['amd64']);
  const both = buildMatrix(two(), { arm64: true }).include;
  assert.deepEqual(both.map((r) => [r.arch, r.runner]), [['amd64', 'ubuntu-24.04'], ['arm64', 'ubuntu-24.04-arm']]);
  assert.equal(both[0].name, 'hello');
  assert.equal(both[0].public, true);
});

test('main prints the matrix as one JSON line, honours BUILD_ARM64, and exits 0', () => {
  const lines = [];
  assert.equal(main([], {}, (l) => lines.push(l)), 0);
  assert.equal(lines.length, 1);
  assert.ok(JSON.parse(lines[0]).include.length >= 1);
  assert.ok(JSON.parse(lines[0]).include.every((r) => r.arch === 'amd64'));
  assert.equal(main([], { BUILD_ARM64: 'true' }, () => {}), 0);
});

test('validation refuses each invalid entry (exit 1 path)', () => {
  const bad = (mutate, re) => {
    const d = good();
    mutate(d);
    assert.match(validateImages(d).join('\n'), re);
  };
  bad((d) => (d.images[0].name = 'Hello_1'), /name must be/);
  bad((d) => d.images.push({ ...d.images[0] }), /duplicate name/);
  bad((d) => (d.images[0].context = '../x'), /context must be a relative path/);
  bad((d) => (d.images[0].dockerfile = '/etc/Dockerfile'), /dockerfile must be a relative path/);
  bad((d) => (d.images[0].context = 'C:/x'), /context must be a relative path/);
  bad((d) => (d.images[0].platforms = []), /platforms must be/);
  bad((d) => (d.images[0].platforms = ['linux/riscv64']), /platforms must be/);
  bad((d) => (d.images[0].platforms = ['linux/amd64', 'linux/amd64']), /platforms must be/);
  bad((d) => (d.images[0].public = 'yes'), /public must be/);
  bad((d) => delete d.images[0].dockerfile, /missing "dockerfile"/);
  bad((d) => (d.images[0].extra = 1), /unknown key "extra"/);
  bad((d) => (d.images = []), /non-empty/);
  bad((d) => (d.registry = 'ghcr.io/x'), /registry must be/);
  assert.match(validateImages([]).join(), /must be an object/);
  assert.match(validateImages(good(), () => false).join('\n'), /does not exist/);
});

test('healthcheck is optional; a valid exec argv passes, bad shapes and shells fail', () => {
  const hc = ['/nodejs/bin/node', '-e', "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1))"];
  const withHc = () => { const d = good(); d.images[0].healthcheck = hc; return d; };
  assert.deepEqual(validateImages(withHc()), [], 'a node-exec healthcheck is valid');
  assert.deepEqual(validateImages(good()), [], 'an image without a healthcheck is still valid (optional)');
  const bad = (v, re) => { const d = good(); d.images[0].healthcheck = v; assert.match(validateImages(d).join('\n'), re); };
  bad([], /healthcheck must be a non-empty list/);
  bad('node -e x', /healthcheck must be a non-empty list/);
  bad(['/nodejs/bin/node', 42], /healthcheck must be a non-empty list/);
  bad(['/nodejs/bin/node', ''], /healthcheck must be a non-empty list/);
  bad(['/bin/sh', '-c', 'curl localhost'], /must exec a binary directly, not a shell/);
  bad(['wget', '-q', 'http://x'], /not a shell/);
  bad(['/usr/bin/bash', '-c', 'x'], /not a shell/);
});

const SHA = 'a'.repeat(40);
const D = `sha256:${'b'.repeat(64)}`;

test('release manifest: healthchecks map is emitted per role, and omitted when none declare one', () => {
  const noHc = buildRelease(good(), { hello: D }, { commit: SHA, repo: 'o/r' });
  assert.ok(!('healthchecks' in noHc), 'no healthchecks key when no image declares one');
  const d = good();
  d.images[0].healthcheck = ['/nodejs/bin/node', '-e', 'process.exit(0)'];
  const r = buildRelease(d, { hello: D }, { commit: SHA, repo: 'o/r' });
  assert.deepEqual(r.healthchecks, { hello: ['/nodejs/bin/node', '-e', 'process.exit(0)'] });
});

test('release manifest: a digest reference per image and the commit; lower-cases the repository', () => {
  const r = buildRelease(good(), { hello: D }, { commit: SHA, repo: 'Owner/Repo' });
  assert.deepEqual(r, { commit: SHA, repo: 'owner/repo', images: { hello: `ghcr.io/owner/repo/hello@${D}` } });
});

test('release manifest: a missing or malformed digest fails', () => {
  assert.throws(() => buildRelease(good(), {}, { commit: SHA, repo: 'o/r' }), /no valid digest for image "hello"/);
  assert.throws(() => buildRelease(good(), { hello: 'latest' }, { commit: SHA, repo: 'o/r' }), /no valid digest/);
  assert.throws(() => buildRelease(good(), { hello: D }, { commit: 'abc', repo: 'o/r' }), /commit/);
  assert.throws(() => buildRelease(good(), { hello: D }, { commit: SHA, repo: 'nope' }), /repo/);
});

test('release script: missing flags print the usage and exit 2 (no TypeError)', () => {
  const errs = [];
  assert.equal(releaseMain([], (l) => errs.push(l), () => {}), 2);
  assert.match(errs.join('\n'), /missing --digests, --commit, --repo, --out/);
  assert.match(errs.join('\n'), /usage: node scripts\/images-release\.mjs/);
  errs.length = 0;
  assert.equal(releaseMain(['--digests', 'd', '--commit', SHA, '--repo', 'o/r', '--out'], (l) => errs.push(l), () => {}), 2);
  assert.match(errs.join('\n'), /missing --out/);
});