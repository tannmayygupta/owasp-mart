// The sole-maintainer line of contracts/COMPAT.md (D-105, ADR 0095).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { soleMaintainer } from './check-contract-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the sole maintainer is read from the line and lower-cased', () => {
  assert.equal(soleMaintainer('x\n**Sole maintainer:** @TannmayGupta (why)\ny'), 'tannmaygupta');
  assert.equal(soleMaintainer('no such line'), null);
  assert.equal(soleMaintainer(undefined), null);
  assert.equal(soleMaintainer('Sole maintainer: @a'), null, 'only the bold form counts');
});

test('the real COMPAT.md names one sole maintainer that is also a listed approver', () => {
  const text = fs.readFileSync(path.join(ROOT, 'contracts', 'COMPAT.md'), 'utf8');
  const who = soleMaintainer(text);
  assert.ok(who, 'the line exists');
  assert.ok(new RegExp(`\\| @${who} \\|`, 'i').test(text.replace(/ \| /g, ' | ')) || text.toLowerCase().includes(`| @${who} |`), 'the maintainer is listed in the Approvals table');
});