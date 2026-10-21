// The lint of the deployed stack (scripts/check-deployed-compose.mjs): it passes on the real files and fails, naming the fact, when each one is broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeployedCompose, defaultOf, webPageFolders } from './check-deployed-compose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A copy of the three files the lint reads, with one text replacement, in a temp folder shaped like the repository. */
function broken(file, from, to) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  for (const f of ['infra/deploy/platform.compose.yaml', 'infra/deploy/Caddyfile.platform']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  }
  fs.cpSync(path.join(ROOT, 'apps', 'web', 'app'), path.join(root, 'apps', 'web', 'app'), { recursive: true });
  const p = path.join(root, file);
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `the real file contains ${from}`);
  fs.writeFileSync(p, text.replace(from, to));
  return root;
}
const COMPOSE = 'infra/deploy/platform.compose.yaml';
const CADDY = 'infra/deploy/Caddyfile.platform';

test('the real deployed stack passes every check', () => {
  assert.deepEqual(checkDeployedCompose(ROOT), []);
});

test('defaultOf reads the default of a compose variable', () => {
  assert.equal(defaultOf('${A:-brevo}'), 'brevo');
  assert.equal(defaultOf('smtp'), 'smtp');
});

test('every page folder of the dashboards is routed by Caddy', () => {
  assert.ok(webPageFolders(ROOT).includes('invite') && webPageFolders(ROOT).includes('dashboard'));
  const root = broken(CADDY, '/invite /invite/* ', '');
  assert.ok(checkDeployedCompose(root).some((f) => /\/invite and \/invite\/\*/.test(f)));
});

for (const [name, from, to, expect] of [
  ['scheduler off', 'VULNMART_SCHEDULER_ENABLED: "true"', 'VULNMART_SCHEDULER_ENABLED: "false"', /SCHEDULER_ENABLED/],
  ['the catcher as the default provider', 'VULNMART_EMAIL_PROVIDER: ${VULNMART_EMAIL_PROVIDER:-brevo}', 'VULNMART_EMAIL_PROVIDER: smtp', /default mail provider/],
  ['the catcher allowed by default', 'VULNMART_ALLOW_MAIL_CATCHER: ${VULNMART_ALLOW_MAIL_CATCHER:-false}', 'VULNMART_ALLOW_MAIL_CATCHER: "true"', /ALLOW_MAIL_CATCHER defaults to false/],
  ['no orchestrator address', 'VULNMART_ORCH_URL: https://${VULNMART_VMI_PRIVATE_IP}:9443', 'VULNMART_ORCH_URL: ""', /ORCH_URL/],
  ['a fake host', 'VULNMART_ORCH_URL: https://${VULNMART_VMI_PRIVATE_IP}:9443', 'VULNMART_ORCH_URL: https://fake-host:9443', /ORCH_URL|fake/],
  ['the lab store in memory', 'VULNMART_LAB_STORE: postgres', 'VULNMART_LAB_STORE: memory', /LAB_STORE/],
  ['the sequence off', 'VULNMART_LAB_SEQUENCE: "1"', 'VULNMART_LAB_SEQUENCE: "0"', /LAB_SEQUENCE/],
  ['Valkey evicting everything', '--maxmemory-policy volatile-lru', '--maxmemory-policy allkeys-lru', /eviction policy/],
  ['Valkey without persistence', '--appendonly yes', '--appendonly no', /append-only/],
  ['Valkey without a password', '--requirepass \\"$$VALKEY_PASSWORD\\" ', '', /password is required/],
  ['a memory limit that does not fit the host', 'mem_limit: 384m', 'mem_limit: 1536m', /memory: the limits/],
  ['no http redirect', ':80 {\n\tredir https://{$VULNMART_PLATFORM_HOST}{uri} 308\n}', ':80 {\n\trespond 200\n}', /redirects to https/],
]) {
  test(`fails when: ${name}`, () => {
    const root = broken(name === 'no http redirect' ? CADDY : COMPOSE, from, to);
    const failures = checkDeployedCompose(root);
    assert.ok(failures.some((f) => expect.test(f)), `expected a failure matching ${expect}, got ${JSON.stringify(failures)}`);
  });
}

test('fails when the dashboards handler sets a CSP of its own', () => {
  const root = broken(CADDY, '\treverse_proxy web:3000 {', '\theader Content-Security-Policy "default-src \'self\'"\n\t\treverse_proxy web:3000 {');
  assert.ok(checkDeployedCompose(root).some((f) => /sets no CSP/.test(f)));
});
