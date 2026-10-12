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

const SHA = 'a'.repeat(40);
const D = `sha256:${'b'.repeat(64)}`;

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