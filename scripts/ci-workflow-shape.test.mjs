// Shape of the contract-rules jobs in .github/workflows/ci.yml (D-46, story 1.15, docs/adr/0026). The workflow cannot run here, so these tests
// pin what makes it safe: the base commit is the trusted source, the head is data, no pull_request_target, no stored credentials, minimal permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const ci = fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

// The text of one job: from "  <name>:" to the next two-space job key (a line "  x:" at indent 2) or the end.
function job(name) {
  const lines = ci.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `job ${name} exists`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}
const stripComments = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('no workflow uses the pull_request_target trigger', () => {
  for (const f of fs.readdirSync(WORKFLOWS).filter((x) => /\.ya?ml$/.test(x))) {
    const text = stripComments(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'));
    assert.ok(!/pull_request_target/.test(text), `${f} must not use pull_request_target (pwn-request risk)`);
  }
});

test('contract-rules: base commit is the trusted source, the head goes to head/, nothing is persisted, permissions are read-only', () => {
  const j = stripComments(job('contract-rules'));
  assert.match(j, /permissions:\n\s+contents: read/);
  assert.match(j, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(j, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(j, /path: head/);
  assert.match(j, /path: base/);
  assert.match(j, /fetch-depth: 0/);
  assert.equal((j.match(/uses: actions\/checkout@/g) ?? []).length, 2);
  assert.equal((j.match(/persist-credentials: false/g) ?? []).length, 2, 'both checkouts drop the token');
  assert.match(j, /working-directory: base\n\s+run: pnpm install --frozen-lockfile/);
  assert.match(j, /node base\/scripts\/check-contract-rules\.mjs --root head --base "\$BASE_SHA" --tools base\/tools\/oasdiff\.json/);
  assert.match(j, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(j, /grep -q 'trusted-base-checker-v1' base\/scripts\/check-contract-rules\.mjs/, 'the bootstrap fallback is explicit');
  assert.match(j, /bootstrap/);
});

test('contract-rules: no step runs code from head/ except the declared bootstrap fallback, and no secret is used', () => {
  const j = stripComments(job('contract-rules'));
  const runs = j.split('\n').filter((l) => /node head\/|pnpm .*head|working-directory: head|uv run|python/.test(l));
  assert.deepEqual(runs.filter((l) => !/--bootstrap/.test(l)), [], 'only the bootstrap line may run head code');
  assert.ok(!/secrets\./.test(j));
  assert.ok(!/GITHUB_TOKEN/.test(j));
});

test('contract-rules-untrusted: head code runs here, with no credentials and read-only permissions', () => {
  const j = stripComments(job('contract-rules-untrusted'));
  assert.match(j, /permissions:\n\s+contents: read/);
  assert.equal((j.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(j, /--untrusted-only/);
  assert.ok(!/secrets\./.test(j));
});

test('every action in the contract-rules jobs is pinned by a full commit SHA, the same ones as the rest of ci.yml', () => {
  const uses = [...stripComments(job('contract-rules') + job('contract-rules-untrusted')).matchAll(/uses: ([^\s@]+)@(\S+)/g)];
  assert.ok(uses.length >= 8);
  for (const [, action, ref] of uses) assert.match(ref, /^[0-9a-f]{40}$/, `${action} is pinned by SHA`);
  const known = new Map();
  for (const [, action, ref] of ci.matchAll(/uses: ([^\s@]+)@([0-9a-f]{40})/g)) {
    if (known.has(action)) assert.equal(known.get(action), ref, `${action} is pinned to one SHA throughout ci.yml`);
    known.set(action, ref);
  }
});

test('CODEOWNERS covers the files that define the rules engine', () => {
  const owners = fs.readFileSync(path.join(ROOT, '.github', 'CODEOWNERS'), 'utf8');
  for (const p of ['/scripts/check-contract-rules.mjs', '/scripts/schema-diff.mjs', '/scripts/oasdiff.mjs', '/tools/oasdiff.json', '/contracts/registry.json', '/.github/workflows/']) {
    const line = owners.split('\n').find((l) => l.startsWith(`${p} `) || l.startsWith(`${p}\t`));
    assert.ok(line, `${p} has a CODEOWNERS entry`);
    assert.match(line, /@\w+/);
  }
});
