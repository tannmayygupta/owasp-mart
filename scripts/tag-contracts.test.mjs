// Tests of scripts/tag-contracts.mjs (story L-09). Every test builds a temporary git repository; the real repository is never tagged.
// The last test proves, in a temporary repository only, that creating the tag switches the tag baseline rules of the contract checker on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPreconditions, checklist, run, tagMessage, CHECKLIST_HEADING, DEFAULT_TAG } from './tag-contracts.mjs';
import { runRules, formatResults, PASS, FAIL, NA } from './check-contract-rules.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tag-contracts.mjs');
const X = 'Contract X, `contracts/x/`';
const REGISTRY = {
  version: 1,
  containers: ['api'],
  reserved: [],
  generated: [],
  mockRoot: 'contracts/mocks',
  contracts: [{ id: 'X', name: 'X', owner: 'L', folders: ['contracts/x'], schemas: [], openapi: [], changelog: X, mocks: [], noMock: 'no mock by design: test', conformance: [] }],
};
const CHANGELOG = `# Contracts changelog\n\n## ${X}\n\n### 1.0.0 (2026-10-11)\n- First stable release, no content change.\n\n### 0.1.0 (2026-10-01)\n- First draft.\n`;
const compat = (status = 'approved', version = '1.0.0') => `# Compatibility

## Versions

| Contract | Version | Owner |
|---|---|---|
| X | 1.0.0 | L |

## Approvals

| Contract | Stream | Handle | Role | Version | Date | Status |
|---|---|---|---|---|---|---|
| X | L | @alice | owner | ${version} | 2026-10-11 | approved |
| X | P | @bob | consumer | ${version} | 2026-10-11 | ${status} |
`;
const handoffs = (box = 'x') => `# Handoffs\n\n## Something else\n\n- [ ] not part of the checklist\n\n## ${CHECKLIST_HEADING}\n\nIntro line.\n\n- [x] H-01 one\n- [${box}] H-02 two\n`;

const write = (root, rel, content) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const sh = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
function makeRepo({ status, version, box, branch = 'main' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-tag-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.invalid');
  sh(root, 'config', 'user.name', 'test');
  sh(root, 'config', 'core.autocrlf', 'false');
  write(root, 'contracts/registry.json', REGISTRY);
  write(root, 'contracts/CHANGELOG.md', CHANGELOG);
  write(root, 'contracts/x/x.md', '# X\n');
  write(root, 'contracts/COMPAT.md', compat(status, version));
  write(root, 'docs/dev/HANDOFFS.md', handoffs(box));
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  if (branch !== 'main') sh(root, 'checkout', '-q', '-b', branch);
  return root;
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));
const capture = (argv, root) => {
  const lines = [];
  const code = run(argv, { root, out: (s) => lines.push(s) });
  return { code, text: lines.join('\n') };
};
const tags = (root) => sh(root, 'tag', '--list', 'contracts-v*').trim();

test('all green: --dry-run exits 0, prints the git tag -a command and the push command, and creates nothing', () => {
  const root = makeRepo();
  try {
    const { code, text } = capture(['--dry-run'], root);
    assert.equal(code, 0, text);
    assert.match(text, /READY \(dry run, nothing was created\)/);
    assert.match(text, /git tag -a contracts-v1\.0\.0 -m "contracts-v1\.0\.0: X 1\.0\.0"/);
    assert.match(text, /git push origin contracts-v1\.0\.0/);
    assert.equal(tags(root), '');
    const bare = capture([], root);
    assert.equal(bare.code, 0, 'no flag is a dry run too');
    assert.equal(tags(root), '');
  } finally {
    cleanup(root);
  }
});

test('all green: --create makes one annotated local tag and never pushes (the repository has no remote and the output says the push is by hand)', () => {
  const root = makeRepo();
  try {
    const { code, text } = capture(['--create'], root);
    assert.equal(code, 0, text);
    assert.equal(tags(root), DEFAULT_TAG);
    assert.equal(sh(root, 'cat-file', '-t', `refs/tags/${DEFAULT_TAG}`).trim(), 'tag', 'annotated');
    assert.match(sh(root, 'tag', '-n1', DEFAULT_TAG), /contracts-v1\.0\.0: X 1\.0\.0/);
    assert.match(text, /It is not pushed\. To publish it, run by hand: git push origin contracts-v1\.0\.0/);
    assert.equal(sh(root, 'remote').trim(), '');
    const again = capture(['--create'], root);
    assert.equal(again.code, 1, 'a second run is refused');
    assert.match(again.text, /FAIL {2}tag-absent: the tag contracts-v1\.0\.0 already exists/);
    assert.equal(tags(root), DEFAULT_TAG);
  } finally {
    cleanup(root);
  }
});

test('red: a pending sign-off is listed with the person and the contract; the run exits 1 and creates nothing', () => {
  const root = makeRepo({ status: 'pending' });
  try {
    const { code, text } = capture(['--dry-run'], root);
    assert.equal(code, 1);
    assert.match(text, /FAIL {2}approvals: 1 sign-off\(s\) still pending: X @bob \(consumer, stream P\)/);
    assert.match(text, /NOT READY: 1 of 8 preconditions failed \(approvals\)\. No tag was created\./);
    assert.equal(tags(root), '');
  } finally {
    cleanup(root);
  }
});

test('red: an unchecked handoff line is listed with its line number; other sections of the file do not count', () => {
  const root = makeRepo({ box: ' ' });
  try {
    const { code, text } = capture(['--dry-run'], root);
    assert.equal(code, 1);
    assert.match(text, /FAIL {2}handoffs: 1 of 2 checklist line\(s\) are not ticked:\n\s+line 12: H-02 two/);
    assert.ok(!/not part of the checklist/.test(text));
  } finally {
    cleanup(root);
  }
});

test('red: a dirty working tree (also an untracked file), a branch other than main and a version mismatch are each named', () => {
  const dirty = makeRepo();
  try {
    write(dirty, 'untracked.txt', 'x\n');
    const d = capture(['--dry-run'], dirty);
    assert.equal(d.code, 1);
    assert.match(d.text, /FAIL {2}clean-tree: the working tree is not clean \(1 path\(s\)\): \?\? untracked\.txt/);
  } finally {
    cleanup(dirty);
  }
  const feature = makeRepo({ branch: 'sprint-2-tanmay' });
  try {
    const f = capture(['--dry-run'], feature);
    assert.equal(f.code, 1);
    assert.match(f.text, /FAIL {2}on-main: the current branch is sprint-2-tanmay, not main/);
  } finally {
    cleanup(feature);
  }
  const mismatch = makeRepo({ version: '0.2.0' });
  try {
    const m = capture(['--dry-run'], mismatch);
    assert.equal(m.code, 1);
    assert.match(m.text, /FAIL {2}approvals: line 13: X @alice signs version 0\.2\.0, but the Versions table says 1\.0\.0 \(version mismatch\)/);
    write(mismatch, 'contracts/COMPAT.md', compat().replace('| X | 1.0.0 | L |', '| X | 0.4.0 | L |'));
    sh(mismatch, 'commit', '-qam', 'wrong version');
    const v = byName(checkPreconditions(mismatch));
    assert.equal(v.versions.ok, false);
    assert.match(v.versions.details[0], /X: COMPAT\.md says 0\.4\.0 but the newest changelog entry is 1\.0\.0 \(version mismatch\)/);
  } finally {
    cleanup(mismatch);
  }
});

test('red: a Versions table that is not all 1.0.0 fails release-labels for the tag contracts-v1.0.0 and says what to do; another tag does not need it', () => {
  const root = makeRepo();
  try {
    write(root, 'contracts/CHANGELOG.md', CHANGELOG.replace('### 1.0.0 (2026-10-11)\n- First stable release, no content change.\n\n', ''));
    write(root, 'contracts/COMPAT.md', compat('approved', '0.1.0').replace('| X | 1.0.0 | L |', '| X | 0.1.0 | L |'));
    sh(root, 'commit', '-qam', 'not relabelled');
    const r = byName(checkPreconditions(root));
    assert.equal(r['release-labels'].ok, false);
    assert.match(r['release-labels'].details[0], /not every contract is labelled 1\.0\.0 \(X 0\.1\.0\): relabel every contract 1\.0\.0 in a release commit first, see docs\/runbooks\/contracts-tag\.md/);
    assert.equal(r.versions.ok, true, 'the versions themselves match the changelog');
    assert.equal(byName(checkPreconditions(root, { tag: 'contracts-v0.9.0' }))['release-labels'].ok, true);
  } finally {
    cleanup(root);
  }
});

test('red: HEAD must equal origin/main; a repository with no origin/main passes with a note (a local bare remote that is equal, then ahead)', () => {
  const root = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-tag-remote-'));
  try {
    assert.match(byName(checkPreconditions(root))['up-to-date'].details[0], /no origin\/main ref/);
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    sh(root, 'remote', 'add', 'origin', bare);
    sh(root, 'push', '-q', 'origin', 'main');
    sh(root, 'fetch', '-q', 'origin');
    const equal = byName(checkPreconditions(root))['up-to-date'];
    assert.equal(equal.ok, true);
    assert.match(equal.details[0], /^HEAD is origin\/main/);
    write(root, 'later.txt', 'x\n');
    sh(root, 'add', '-A');
    sh(root, 'commit', '-qm', 'local commit not on origin');
    const ahead = byName(checkPreconditions(root))['up-to-date'];
    assert.equal(ahead.ok, false);
    assert.match(ahead.details[0], /is not origin\/main .*run `git fetch origin` first/);
    const { code, text } = capture(['--dry-run'], root);
    assert.equal(code, 1);
    assert.match(text, /FAIL {2}up-to-date:/);
  } finally {
    cleanup(root);
    cleanup(bare);
  }
});
test('red: every failed precondition is listed in one run, not only the first', () => {
  const root = makeRepo({ status: 'pending', box: ' ', branch: 'feature' });
  try {
    write(root, 'untracked.txt', 'x\n');
    sh(root, 'tag', '-a', DEFAULT_TAG, '-m', 'earlier');
    const { code, text } = capture(['--dry-run'], root);
    assert.equal(code, 1);
    for (const n of ['clean-tree', 'on-main', 'tag-absent', 'approvals', 'handoffs']) assert.match(text, new RegExp(`FAIL {2}${n}:`), n);
    assert.match(text, /PASS {2}versions:/);
    assert.match(text, /NOT READY: 5 of 8 preconditions failed/);
  } finally {
    cleanup(root);
  }
});

test('red: missing files, a missing checklist section and an empty one are named, never a crash', () => {
  const root = makeRepo();
  try {
    fs.rmSync(path.join(root, 'contracts/COMPAT.md'));
    fs.rmSync(path.join(root, 'docs/dev/HANDOFFS.md'));
    sh(root, 'add', '-A');
    sh(root, 'commit', '-qm', 'remove');
    const r = byName(checkPreconditions(root));
    assert.match(r.versions.details[0], /contracts\/COMPAT\.md does not exist/);
    assert.equal(r.approvals.ok, false);
    assert.match(r.handoffs.details[0], /HANDOFFS\.md does not exist/);
  } finally {
    cleanup(root);
  }
  assert.equal(checklist('# x\n'), null);
  assert.deepEqual(checklist(`## ${CHECKLIST_HEADING}\n\nno boxes\n`), []);
  assert.deepEqual(checklist(`## ${CHECKLIST_HEADING}\n- [X] a\n- [ ] b\n## Next\n- [ ] c\n`).map((i) => i.done), [true, false]);
});

test('usage: --dry-run with --create is refused, and so is a tag name of the wrong form', () => {
  const root = makeRepo();
  try {
    assert.equal(capture(['--dry-run', '--create'], root).code, 2);
    assert.equal(capture(['--tag', 'v1.0.0'], root).code, 2);
    assert.equal(tags(root), '');
    assert.equal(tagMessage(root, 'contracts-v1.0.0'), 'contracts-v1.0.0: X 1.0.0');
  } finally {
    cleanup(root);
  }
});

test('the command line: exit 1 and a NOT READY line on a red repository (a real child process)', () => {
  const root = makeRepo({ status: 'pending' });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /NOT READY/);
    assert.equal(tags(root), '');
  } finally {
    cleanup(root);
  }
});

test('proof in a temporary repository: after the tag, the checker compares with the tag and the rule approvals switches on', async () => {
  const root = makeRepo();
  try {
    const before = await runRules({ root, base: 'main', skip: ['table-owners', 'alembic'] });
    assert.equal(byName(before).approvals.status, NA, 'no tag: not applicable');
    assert.match(byName(before).base.details.join('\n'), /NOTICE: no tag contracts-v\*/);
    assert.equal(capture(['--create'], root).code, 0);

    sh(root, 'checkout', '-q', '-b', 'pr');
    write(root, 'contracts/x/x.md', '# X, changed\n');
    write(root, 'contracts/CHANGELOG.md', CHANGELOG.replace(`## ${X}\n`, `## ${X}\n\n### 0.2.0 (2026-10-12)\n- Additive: a note.\n`));
    sh(root, 'add', '-A');
    sh(root, 'commit', '-qm', 'change X');
    const head = sh(root, 'rev-parse', 'HEAD').trim();
    const review = (login, state, commit) => [{ id: 1, user: { login }, state, commit_id: commit, submitted_at: '2026-10-12T10:00:00Z' }];
    const go = async (reviews) => byName(await runRules({ root, base: 'main', skip: ['table-owners', 'alembic'], reviews, requireReviews: true, prAuthor: 'alice' }));

    const none = await go([]);
    assert.equal(none.approvals.status, FAIL, formatResults(Object.values(none)));
    assert.match(none.approvals.details[0], /^X \(additive\): needs one approval from @bob/);
    assert.ok(none['breaking-since-tag[X]'], 'the comparison with the tag runs');
    assert.ok(!/NOTICE: no tag/.test(none.base.details.join('\n')), 'the baseline notice is gone');
    const ok = await go(review('bob', 'APPROVED', head));
    assert.equal(ok.approvals.status, PASS, ok.approvals.details.join('\n'));
    const self = await go(review('alice', 'APPROVED', head));
    assert.equal(self.approvals.status, FAIL);
  } finally {
    cleanup(root);
  }
});
