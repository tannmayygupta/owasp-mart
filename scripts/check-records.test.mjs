// Tests of scripts/check-records.mjs on small fake repositories (and one run on the real one, which must stay free of problems).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cells, checkRecords } from './check-records.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'records-'));
  const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('docs/prd/PRD.md', over.prd ?? 'FR-ABC-01 does a thing. FR-ABC-02 does another.');
  put('docs/traceability.md', over.trace ?? '| FR-ABC-01 | x | Done |\n| FR-ABC-02 | y | Partial |');
  put('docs/dev/HANDOFFS.md', over.handoffs ?? '| Id | Task(s) | What | Default | Source | Status | Answer |\n|---|---|---|---|---|---|---|\n| H-01 | L-01 | q | d | s | done | a |\n| H-02 | L-02 | q | d | s | open | |');
  put('docs/adr/README.md', over.adrIndex ?? '| 0001 | [One](0001-one.md) | Accepted |');
  put('docs/adr/0001-one.md', '# 1');
  if (over.plan) put('docs/bmad/initiative-lab/backlog/story-x-plan.md', over.plan);
  return root;
}

test('cells splits a table row and keeps escaped pipes', () => {
  assert.deepEqual(cells('| a | b \\| c | d |'), ['a', 'b | c', 'd']);
});

test('a consistent repository has no problem', () => {
  assert.deepEqual(checkRecords(fixture()).problems, []);
});

test('a PRD requirement without a traceability row is a problem', () => {
  const { problems } = checkRecords(fixture({ trace: '| FR-ABC-01 | x | Done |' }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /FR-ABC-02/);
});

test('a handoff with a made-up status is a problem; the five words are fine', () => {
  const rows = ['done', 'open', 'superseded', 'blocked-external', 'in-progress-wp (a)'].map((s, i) => `| H-0${i + 1} | T | w | d | s | ${s} | |`).join('\n');
  assert.deepEqual(checkRecords(fixture({ handoffs: rows })).problems, []);
  const bad = checkRecords(fixture({ handoffs: '| H-01 | T | w | d | s | partly | |\n| H-01 | T | w | d | s | done | |' }));
  assert.equal(bad.problems.length, 2);
  assert.match(bad.problems.join('\n'), /partly/);
  assert.match(bad.problems.join('\n'), /appears twice/);
});

test('an ADR file without an index row, or an index row without a file, is a problem', () => {
  assert.match(checkRecords(fixture({ adrIndex: '' })).problems.join('\n'), /no row for 0001-one\.md/);
  assert.match(checkRecords(fixture({ adrIndex: '| [One](0001-one.md) |\n| [Two](0002-two.md) |' })).problems.join('\n'), /0002-two\.md, which does not exist/);
});

test('a story plan needs a known status', () => {
  assert.match(checkRecords(fixture({ plan: '---\ntitle: x\nstatus: finished\n---\n' })).problems.join('\n'), /unknown status "finished"/);
  assert.match(checkRecords(fixture({ plan: '---\ntitle: x\n---\n' })).problems.join('\n'), /no status/);
  assert.deepEqual(checkRecords(fixture({ plan: '---\ntitle: x\nstatus: done\n---\n' })).problems, []);
});

test('the real repository records agree', () => {
  const { problems } = checkRecords(REPO);
  assert.deepEqual(problems, []);
});
