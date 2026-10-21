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
  assert.equal(m.commands.shop, undefined, 'the real shop runs its default command');
  assert.deepEqual(m.commands.injector, ['/app/src/instance/inject.mjs'], 'the injector is the shop image\'s inject script (IF-6 section 5)');
  assert.equal(m.images.shop, m.images.injector, 'the shop and its injector are one image');
  assert.ok(m.images.shop.includes('/shop@') && !m.images.shop.includes('stub'), 'the real shop, not the stub');
  assert.ok(m.healthchecks.shop.join(' ').includes('/readyz'), 'the shop is healthy only after the injector marker (/readyz)');
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


test('the lab deploy runs instances in gVisor by default, runc only when asked, and the environment says so (S-8, L-29)', async () => {
  const { labEnv, DEFAULT_RUNTIME, parseArgs } = await import('./live-deploy.mjs');
  const H = { i: { priv: '10.0.1.5' }, p: { priv: '10.0.0.5' } };
  assert.equal(DEFAULT_RUNTIME, 'runsc');
  assert.match(labEnv({ zone: 'z.example', H }), /(^| )VULNMART_ORCH_RUNTIME=runsc( |$)/);
  assert.match(labEnv({ zone: 'z.example', H, runtime: 'runsc' }), /VULNMART_ORCH_RUNTIME=runsc/);
  assert.doesNotMatch(labEnv({ zone: 'z.example', H, runtime: 'runc' }), /VULNMART_ORCH_RUNTIME/);
  assert.equal(parseArgs(['lab', '--runtime', 'runc']).runtime, 'runc');
  assert.match(parseArgs(['lab', '--runtime', 'kata']).error, /runsc \(gVisor\) or runc/);
});

test('the platform deploy ships and builds the dashboards image beside the API image (production hardening, ADR 0074)', () => {
  assert.deepEqual(IMAGES['vulnmart-web:prod'], ['apps/web/Dockerfile.prod', 'apps/web']);
  assert.ok(SHIP.p.includes('vulnmart-web:prod') && SHIP.p.includes('vulnmart-api:prod'));
});

test('mail: a Brevo key means Brevo, no key stops the deploy unless the catcher was asked for', async () => {
  const { mailMode, platformEnv, parseArgs } = await import('./live-deploy.mjs');
  assert.equal(mailMode({ keyText: 'some-key\n', allowCatcher: false }), 'brevo');
  assert.equal(mailMode({ keyText: '  \n', allowCatcher: true }), 'catcher');
  assert.throws(() => mailMode({ keyText: '', allowCatcher: false }), /no Brevo key/);
  assert.throws(() => mailMode({ keyText: undefined, allowCatcher: false }), /no Brevo key/);
  assert.equal(parseArgs(['platform', '--allow-mail-catcher']).allowMailCatcher, true);
  assert.equal(parseArgs(['platform']).allowMailCatcher, false);
  const H = { i: { priv: '10.0.1.5' }, p: { priv: '10.0.0.5' } };
  const base = { pg: { owner: 'o', app: 'a', keystore: 'k', valkey: 'v' }, platformHost: 'h.example', zone: 'z.example', H };
  const brevo = platformEnv({ ...base, mail: 'brevo' });
  assert.match(brevo, /^VULNMART_VALKEY_PASSWORD=v$/m);
  assert.match(brevo, /^VULNMART_EMAIL_PROVIDER=brevo$/m);
  assert.match(brevo, /^VULNMART_ALLOW_MAIL_CATCHER=false$/m);
  assert.doesNotMatch(brevo, /COMPOSE_PROFILES|mailpit/);
  const catcher = platformEnv({ ...base, mail: 'catcher' });
  assert.match(catcher, /^VULNMART_ALLOW_MAIL_CATCHER=true$/m);
  assert.match(catcher, /^COMPOSE_PROFILES=mail-catcher$/m);
  assert.throws(() => platformEnv({ ...base, mail: 'x' }), /brevo or catcher/);
});
