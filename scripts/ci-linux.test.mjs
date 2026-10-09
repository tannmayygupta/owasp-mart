// scripts/ci-linux.mjs repeats the CI commands in a Linux container. These tests keep it in step with .github/workflows/ci.yml
// (no Docker needed): every command it runs is a `run:` line of the workflow, and the e2e job has the nested-pytest switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, NEEDS_INSTALL, NESTED_PYTEST_SWITCH, containerScript, dockerfile, NODE_IMAGE, UV_IMAGE, PNPM_VERSION } from './ci-linux.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
// The text of each job, cut at the next job key (a line of two spaces and a name ending in a colon).
const jobsText = ci.split(/^jobs:\n/m)[1];
const jobs = Object.fromEntries(jobsText.split(/^(?=  [a-z0-9_-]+:\n)/m).map((block) => [block.match(/^  ([a-z0-9_-]+):/)[1], block]));
const MIRRORED = ['skills', 'scripts', 'installs', 'e2e'];
const runsOf = (job) => [...job.matchAll(/^\s+- run: (.*)$/gm)].map((m) => m[1].trim());

test('every command ci:linux runs is a run line of ci.yml', () => {
  const runs = Object.values(jobs).flatMap(runsOf);
  for (const [name, command] of STEPS) assert.ok(runs.includes(command), `${name}: ${command}`);
});

test('every run command of the jobs skills, scripts, installs and e2e is a step of ci:linux', () => {
  const commands = STEPS.map(([, c]) => c);
  for (const name of MIRRORED) {
    assert.ok(jobs[name], `job ${name} exists`);
    for (const run of runsOf(jobs[name])) {
      assert.ok(!/^[|>]/.test(run), `job ${name} has a multi-line run block that this test cannot parse: add it to STEPS by hand and extend the test`);
      assert.ok(commands.includes(run), `job ${name}: "${run}" is not in STEPS`);
    }
  }
});

test('--only runs the install first for the steps that need it', () => {
  for (const [name] of STEPS) {
    const script = containerScript(name);
    assert.equal(script.includes('=== STEP pnpm-install'), NEEDS_INSTALL.has(name) || name === 'pnpm-install', name);
  }
  assert.ok(containerScript('e2e').indexOf('STEP pnpm-install') < containerScript('e2e').indexOf('STEP e2e'));
});

test('the e2e job runs the three files and switches off the nested pytest', () => {
  const job = jobs.e2e;
  assert.ok(job, 'job e2e exists');
  assert.ok(job.includes(`${NESTED_PYTEST_SWITCH}: '1'`));
  for (const file of ['lab', 'orchestrator', 'events']) assert.ok(job.includes(`scripts/e2e/${file}.e2e.test.mjs`), file);
  assert.ok(!job.includes('contracts.e2e') && !job.includes('dev.e2e'));
});

test('the tool versions of the image match the repository', () => {
  assert.ok(NODE_IMAGE.includes(readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim()));
  assert.ok(UV_IMAGE.endsWith(ci.match(/version: (\d+\.\d+\.\d+)/)[1]));
  assert.ok(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).packageManager.endsWith(`@${PNPM_VERSION}`));
  assert.ok(dockerfile().includes(UV_IMAGE) && containerScript().includes('=== RESULT'));
});

test('every action in ci.yml is pinned by commit SHA', () => {
  for (const m of ci.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});
