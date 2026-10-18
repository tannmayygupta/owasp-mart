import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGES, MANIFEST_EXTRAS, ROLE_IMAGE, SHIP, buildManifest, parseArgs } from './live-deploy.mjs';

test('arguments: a known command, known options, a value for each', () => {
  assert.equal(parseArgs(['lab', '--secrets', 'x', '--zone', 'z.example', '--dry-run']).dryRun, true);
  assert.match(parseArgs([]).error, /usage/);
  assert.match(parseArgs(['fly']).error, /usage/);
  assert.match(parseArgs(['lab', '--secrets']).error, /needs a value/);
  assert.match(parseArgs(['lab', '--nope']).error, /unknown/);
});

test('every image of a host and every instance role has an image that is built', () => {
  for (const tags of Object.values(SHIP)) for (const t of tags) assert.ok(IMAGES[t], t);
  for (const img of Object.values(ROLE_IMAGE)) assert.ok(SHIP.i.includes(img), img);
  assert.deepEqual(Object.keys(ROLE_IMAGE).sort(), ['bot-controller', 'import-service', 'injector', 'mock-services', 'shop', 'sidecar', 'volume-keeper']);
});

test('the manifest names every role by digest and carries what the stub and the product images need', () => {
  const d = (n) => `localhost:5000/vulnmart/${n}@sha256:${n.length.toString(16).padStart(64, 'a')}`;
  const digests = Object.fromEntries([...new Set(Object.values(ROLE_IMAGE))].map((img) => [img, d(img.replace('vulnmart-', '').split(':')[0])]));
  const m = buildManifest(digests);
  assert.equal(Object.keys(m.images).length, 7);
  assert.ok(Object.values(m.images).every((r) => /@sha256:[0-9a-f]{64}$/.test(r)));
  assert.deepEqual(m.commands.shop, ['shop']);
  assert.deepEqual(m.commands.injector, ['inject']);
  assert.ok(m.commands.sidecar.includes('--relay') && m.commands.sidecar.includes('--upstream'));
  assert.ok(Object.keys(m.healthchecks).every((r) => ['CMD', '/nodejs/bin/node'].every((x, i) => m.healthchecks[r][i] === x)), 'distroless roles check with node by absolute path');
  assert.deepEqual(Object.keys(MANIFEST_EXTRAS).sort(), ['commands', 'entrypoints', 'healthchecks']);
  assert.throws(() => buildManifest({}), /no digest-pinned reference/);
  assert.throws(() => buildManifest({ ...digests, 'vulnmart-bot:local': 'sha256:' + 'a'.repeat(64) }), /bot-controller/);
});
test('the demo template only changes the memory of the six roles and keeps everything else of the example', async () => {
  const fs = await import('node:fs');
  const { demoTemplate, DEMO_MEMORY_MB, DEMO_CAPACITY_MB } = await import('./live-deploy.mjs');
  const example = JSON.parse(fs.readFileSync(new URL('../contracts/instance/examples/valid/instance-template/shop-template.json', import.meta.url), 'utf8'));
  const demo = demoTemplate(example);
  assert.equal(demo.components.length, 6);
  for (const [i, c] of demo.components.entries()) {
    assert.equal(c.memory_mb, DEMO_MEMORY_MB[c.role]);
    assert.deepEqual({ ...c, memory_mb: 0 }, { ...example.components[i], memory_mb: 0 }, `${c.role}: nothing but the memory changed`);
  }
  const per = demo.components.reduce((n, c) => n + c.memory_mb, 0) + 64;
  assert.ok(per < 900 && Math.floor(DEMO_CAPACITY_MB / per) >= 6, `${per} MB an instance, room for ${Math.floor(DEMO_CAPACITY_MB / per)}`);
  assert.throws(() => demoTemplate({ components: [{ role: 'strange' }] }), /do not know/);
  assert.equal(example.components[0].memory_mb, 512, 'the example is not touched');
});

test('hooks is a command', () => { assert.equal(parseArgs(['hooks']).cmd, 'hooks'); });
