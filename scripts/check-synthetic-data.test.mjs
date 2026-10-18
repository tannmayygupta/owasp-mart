// Story P-24 (FR-PRV-17): the synthetic-data check finds what it says it finds and passes the shop's real seed folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { luhn, scanText, scanTree, main, SEED_FOLDERS } from './check-synthetic-data.mjs';

const kinds = (text) => scanText(text, 'x').map((f) => f.kind);

test('an email address is fine on a reserved domain and a finding on any other', () => {
  for (const ok of ['a@vulnmart.test', 'b@x.example', 'c@mail.invalid', 'd@host.localhost', 'e@example.com', 'f@sub.example.org', 'g@EXAMPLE.NET']) assert.deepEqual(kinds(ok), [], ok);
  for (const bad of ['jane.doe@gmail.com', 'a@company.in', 'b@examples.com', 'c@notexample.com', 'd@vulnmart.dev']) assert.equal(kinds(bad).length, 1, bad);
});

test('a number that passes the card check is a finding, in any of the usual spellings, and an ordinary long number is not', () => {
  assert.equal(luhn('4242424242424242'), true);
  assert.equal(luhn('4242424242424241'), false);
  for (const card of ['4242424242424242', '4242 4242 4242 4242', '4242-4242-4242-4242', 'card: 5555555555554444', '378282246310005']) assert.equal(kinds(card).length, 1, card);
  for (const fine of ['1234567890123456', 'order 1700000000000', '12345', '4242 4242 4242 4243', 'a'.repeat(20)]) assert.deepEqual(kinds(fine), [], fine);
});

test('the formats of well-known secrets are findings and a weak made-up password is not', () => {
  // built at test time, so that this file itself holds no secret-shaped text (the repository's own scan would flag it)
  assert.equal(kinds('key = ' + 'AKIA' + 'ABCDEFGHIJKLMNOP').length, 1);
  assert.equal(kinds('-----BEGIN RSA ' + 'PRIVATE KEY-----').length, 1);
  assert.equal(kinds('t = ghp_' + 'a'.repeat(36)).length, 1);
  assert.equal(kinds('sk_live_' + 'b'.repeat(24)).length, 1);
  assert.deepEqual(kinds("password: 'hunter2'"), []);
  assert.deepEqual(kinds("const secret = 'demo-not-a-secret'"), []);
});

test('a finding names the file and the line and kind, never the value', () => {
  const [finding] = scanText('line one\nmail jane.doe@gmail.com now', 'seed/a.sql');
  assert.deepEqual(Object.keys(finding).sort(), ['file', 'kind', 'line']);
  assert.equal(finding.line, 2);
  assert.ok(!JSON.stringify(finding).includes('jane.doe'));
});

test('a folder is scanned recursively, skipping node_modules, and only text files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'synthetic-'));
  try {
    mkdirSync(path.join(dir, 'seed', 'deep'), { recursive: true });
    mkdirSync(path.join(dir, 'seed', 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'seed', 'ok.sql'), "INSERT INTO u VALUES ('a@vulnmart.test');\n");
    writeFileSync(path.join(dir, 'seed', 'deep', 'bad.json'), '{"email": "real.person@gmail.com"}\n');
    writeFileSync(path.join(dir, 'seed', 'node_modules', 'ignored.js'), 'x@real.com');
    writeFileSync(path.join(dir, 'seed', 'image.png'), 'x@real.com');
    const { found, scanned } = scanTree(dir, ['seed', 'missing-folder']);
    assert.equal(scanned, 2);
    assert.deepEqual(found.map((f) => [f.file, f.line]), [['seed/deep/bad.json', 1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real seed folders of the shop hold only synthetic data', () => {
  const lines = [];
  assert.equal(main((l) => lines.push(l)), 0, lines.join('\n'));
  const { scanned } = scanTree();
  assert.ok(scanned >= 5, `the check looked at ${scanned} files in ${SEED_FOLDERS.join(', ')}`);
});
