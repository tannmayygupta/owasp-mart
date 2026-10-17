import assert from 'node:assert/strict';
import test from 'node:test';
import { LAB_PORT, PROJECT, checkExit, collisions, composeArgs, formatCheck, labArgs, labEnv, parseArgs, portsFor, profilesFor, urlsFor } from './fallback.mjs';

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['up']), { cmd: 'up', noWeb: false, lab: false });
  assert.deepEqual(parseArgs(['up', '--no-web', '--lab']), { cmd: 'up', noWeb: true, lab: true });
  assert.equal(parseArgs(['check']).cmd, 'check');
  assert.match(parseArgs(['up', '--x']).error, /Unknown option/);
  assert.match(parseArgs(['down', '--lab']).error, /Unknown option/);
  assert.match(parseArgs([]).error, /Unknown or missing command/);
});

test('profiles, ports and urls follow the options', () => {
  assert.deepEqual(profilesFor({ noWeb: false }), ['platform', 'web']);
  assert.deepEqual(profilesFor({ noWeb: true }), ['platform']);
  assert.deepEqual(portsFor({ noWeb: false, lab: false }), [8000, 8025, 3000]);
  assert.deepEqual(portsFor({ noWeb: true, lab: true }), [8000, 8025, LAB_PORT]);
  assert.ok(urlsFor({ noWeb: false, lab: false }).some((u) => u.name === 'web'));
  assert.ok(!urlsFor({ noWeb: true, lab: false }).some((u) => u.name === 'web'));
  assert.ok(urlsFor({ noWeb: true, lab: true }).some((u) => u.url.endsWith(`:${LAB_PORT}/healthz`)));
  for (const u of urlsFor({ noWeb: false, lab: true })) assert.match(u.url, /^http:\/\/127\.0\.0\.1:/, 'loopback only');
});

test('composeArgs always names the fallback project', () => {
  const a = composeArgs(['platform', 'web'], ['down']);
  assert.deepEqual(a.slice(0, 3), ['compose', '-p', PROJECT]);
  assert.equal(PROJECT, 'vulnmart-fallback');
  assert.deepEqual(a.slice(-1), ['down']);
  assert.equal(a.filter((x) => x === '--profile').length, 2);
});

test('labEnv carries the token and the lab switches; labArgs binds loopback', () => {
  const e = labEnv('tok');
  assert.equal(e.VULNMART_LAB_RUNTIME, '1');
  assert.equal(e.VULNMART_LAB_DEMO, '1');
  assert.equal(e.VULNMART_LAB_DEMO_TOKEN, 'tok');
  const a = labArgs();
  assert.equal(a[a.indexOf('--host') + 1], '127.0.0.1');
});

test('collisions finds only fixed-name platform containers', () => {
  assert.deepEqual(collisions('vulnmart-postgres\nvulnmart-api\nn8n\nvm-i-x-shop\nvulnmart-edge-caddy\n'), ['vulnmart-postgres', 'vulnmart-api']);
  assert.deepEqual(collisions(''), []);
});

test('formatCheck and checkExit', () => {
  const rows = [{ name: 'a', ok: true, detail: 'HTTP 200' }, { name: 'b', ok: false, detail: 'HTTP 500' }];
  assert.equal(formatCheck(rows), 'PASS a: HTTP 200\nFAIL b: HTTP 500');
  assert.equal(checkExit(rows), 1);
  assert.equal(checkExit([rows[0]]), 0);
  assert.equal(checkExit([]), 1, 'no checks is not a pass');
});
