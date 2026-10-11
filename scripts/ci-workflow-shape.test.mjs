// Shape of the contract-rules jobs in .github/workflows/ci.yml (D-46, story 1.15, docs/adr/0026). The workflow cannot run here, so these tests
// pin what makes it safe: the base commit is the trusted source, the head is data, no pull_request_target, no stored credentials, minimal permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
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

// Story L-09 (docs/adr/0029): the rule `approvals` needs the pull request reviews. The one place that holds a token is a step that only runs `gh api`
// and writes a file; the checker steps get the file path and never the token. The token is the read-only token of the job. Asserted on the parsed
// workflow, not on the text layout.
const doc = yaml.load(ci);
const allSteps = Object.entries(doc.jobs).flatMap(([jobName, j]) => (j.steps ?? []).map((s) => ({ jobName, ...s })));
test('contract-rules: the reviews are fetched with a read-only token in one step that runs no repository code; the checker never holds it', () => {
  const j = doc.jobs['contract-rules'];
  assert.deepEqual(j.permissions, { contents: 'read', 'pull-requests': 'read' });
  const holders = j.steps.filter((s) => s.env && 'GH_TOKEN' in s.env);
  assert.equal(holders.length, 1, 'exactly one step of the job has GH_TOKEN');
  const [fetch] = holders;
  assert.match(fetch.name, /^Fetch the pull request reviews/);
  assert.equal(fetch.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(fetch.env.REVIEWS_URL, 'repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/reviews');
  assert.equal(fetch.run, 'gh api --paginate --slurp "$REVIEWS_URL" > "$RUNNER_TEMP/reviews.json"');
  assert.ok(!fetch.uses && !fetch['working-directory'], 'the token step runs no repository code');
  assert.equal(fetch['continue-on-error'], true, 'a failed fetch must not fail every pull request before the tag; the checker then sees no file (NOT-APPLICABLE before the tag, FAIL after it)');
  assert.deepEqual(j.steps.filter((s) => s['continue-on-error'] !== undefined).map((s) => s.name), [fetch.name], 'continue-on-error on that step only');
  const checker = j.steps.find((s) => /Run the contract rules from the base commit/.test(s.name));
  assert.ok(checker && !('GH_TOKEN' in (checker.env ?? {})) && !JSON.stringify(checker).includes('github.token'));
  assert.equal((checker.run.match(/--reviews "\$RUNNER_TEMP\/reviews\.json" --require-reviews --pr-author "\$PR_AUTHOR"/g) ?? []).length, 2, 'both the trusted and the bootstrap run pass the reviews');
  assert.equal(checker.env.PR_AUTHOR, '${{ github.event.pull_request.user.login }}');
  assert.ok(j.steps.indexOf(fetch) < j.steps.indexOf(checker));
});

test('no step of any job uses secrets, only that one step uses gh or a token, and no other job asks for more than contents: read', () => {
  for (const s of allSteps) assert.ok(!/secrets\./.test(JSON.stringify(s)), `${s.jobName}: ${s.name ?? s.uses} uses secrets`);
  const ghUsers = allSteps.filter((s) => /(^|[\s;&|(])gh\s/.test(s.run ?? ''));
  assert.deepEqual(ghUsers.map((s) => `${s.jobName}/${s.name}`), ['contract-rules/Fetch the pull request reviews (read-only token, this step only)']);
  const tokenUsers = allSteps.filter((s) => /github\.token|GH_TOKEN|GITHUB_TOKEN/.test(JSON.stringify(s)));
  assert.equal(tokenUsers.length, 1);
  assert.deepEqual(doc.permissions, { contents: 'read' });
  for (const [name, j] of Object.entries(doc.jobs)) if (name !== 'contract-rules' && j.permissions) assert.deepEqual(j.permissions, { contents: 'read' }, name);
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
  for (const p of ['/scripts/check-contract-rules.mjs', '/scripts/schema-diff.mjs', '/scripts/oasdiff.mjs', '/tools/oasdiff.json', '/contracts/registry.json', '/contracts/COMPAT.md', '/.github/workflows/']) {
    const line = owners.split('\n').find((l) => l.startsWith(`${p} `) || l.startsWith(`${p}\t`));
    assert.ok(line, `${p} has a CODEOWNERS entry`);
    assert.match(line, /@\w+/);
  }
});

// Story LE-3 (docs/adr/0031): the gate test runs in job `compose` (it needs Docker), and the vm-p compose file pins both images by digest.
test('compose job runs the Caddy origin e2e test; vm-p compose pins the stock Caddy and the probe node image by digest, with no plugin build', () => {
  const steps = doc.jobs.compose.steps.map((s) => s.run).filter(Boolean);
  assert.ok(steps.includes('node --test scripts/e2e/caddy-origin.e2e.test.mjs'));
  const compose = yaml.load(fs.readFileSync(path.join(ROOT, 'infra', 'caddy', 'compose.p.yaml'), 'utf8'));
  for (const [name, svc] of Object.entries(compose.services)) {
    assert.match(svc.image, /@sha256:[0-9a-f]{64}$/, `${name} image is pinned by digest`);
    assert.ok(!svc.build, `${name} has no build (stock image, D-49)`);
  }
  assert.match(compose.services.caddy.image, /^caddy:/);
});