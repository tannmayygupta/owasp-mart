// Runs the CI commands of .github/workflows/ci.yml in a Linux container (Docker), so the first GitHub run is not the first Linux run.
// Usage: node scripts/ci-linux.mjs [--skip-image-build] [--only <step-name>]      (or: pnpm run ci:linux)
// The repository is copied into the container (node_modules, .venv and tools/.bin are left out, so Windows or Mac binaries never leak in; .git is kept,
// because the contract rules compare with origin/main);
// nothing in the working tree is changed. Needs Docker. Node 24.21.0 / pnpm 12.10.1 / uv 0.12.23 match .node-version, package.json and ci.yml.
//
// Steps are the commands of the CI jobs `skills`, `scripts`, `installs`, `contract-rules` and `e2e`. The job `compose` needs Docker itself and is not repeated here.
// The nested Python run of scripts/e2e/orchestrator.e2e.test.mjs is switched off through VULNMART_E2E_SKIP_NESTED_PYTEST=1, exactly as in the
// CI job `e2e`, because the step "pytest" already runs the same tests.
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_IMAGE = 'node:24.21.0-bookworm';
export const UV_IMAGE = 'ghcr.io/astral-sh/uv:0.12.23';
export const PNPM_VERSION = '12.10.1';
export const IMAGE_TAG = 'vulnmart-ci-linux:local';
export const NESTED_PYTEST_SWITCH = 'VULNMART_E2E_SKIP_NESTED_PYTEST';

// These are the `run:` commands of the CI jobs skills, scripts, installs, contract-rules and e2e (scripts/ci-linux.test.mjs checks both directions).
// Not repeated here: the job `compose` (it needs Docker, and Docker inside this container is not available). Not in the e2e job either:
// `scripts/e2e/contracts.e2e.test.mjs` (a fresh-checkout install run; the same commands already run in the job `scripts`) and
// `scripts/e2e/dev.e2e.test.mjs` (needs the host Docker; the job `compose` covers `dev.mjs hello`).
export const STEPS = [
  ['skills', 'node scripts/verify-skills.mjs'],
  ['pnpm-install', 'pnpm install --frozen-lockfile'],
  ['unit-tests', 'node --test "scripts/*.test.mjs"'],
  ['errors-check', 'pnpm run errors:check'],
  ['domain-events-check', 'pnpm run domain-events:check'],
  ['api-check', 'pnpm run api:check'],
  ['stub-instance-tests', 'node --test "contracts/mocks/stub-instance/**/*.test.mjs"'],
  ['pytest', 'uv run --locked --package vulnmart-api pytest -q'],
  ['contracts-check', 'pnpm run contracts:check'],
  ['uv-lock-check', 'uv lock --check'],
  // local form: no reviews file, so the rule `approvals` prints NOT-APPLICABLE (in CI a separate step fetches the reviews and passes --reviews --require-reviews)
  ['contract-rules', 'node scripts/check-contract-rules.mjs'],
  ['e2e', 'node --test scripts/e2e/lab.e2e.test.mjs scripts/e2e/orchestrator.e2e.test.mjs scripts/e2e/events.e2e.test.mjs'],
];

// Steps that need the packages installed by `pnpm-install` (ajv for the validators and end-to-end tests). With `--only`, the install runs first for them.
export const NEEDS_INSTALL = new Set(['unit-tests', 'errors-check', 'domain-events-check', 'api-check', 'stub-instance-tests', 'pytest', 'contracts-check', 'contract-rules', 'e2e']);

export const dockerfile = () => `FROM ${UV_IMAGE} AS uv
FROM ${NODE_IMAGE}
COPY --from=uv /uv /uvx /usr/local/bin/
RUN npm install --global pnpm@${PNPM_VERSION}
`;

export function containerScript(only) {
  const steps = STEPS.filter(([name]) => !only || name === only || (name === 'pnpm-install' && NEEDS_INSTALL.has(only)));
  const lines = [
    'set -u',
    'mkdir /work',
    'tar -C /src --exclude=node_modules --exclude=.venv --exclude=tools/.bin --exclude=__pycache__ --exclude=.pytest_cache -cf - . | tar -C /work -xf -',
    'cd /work',
    'git config --global --add safe.directory /work',
    'failed=0',
  ];
  for (const [name, command] of steps) {
    lines.push(`echo "=== STEP ${name}: ${command.replace(/"/g, '\\"')}"`);
    lines.push(`if ${command}; then echo "=== RESULT ${name}: PASS"; else echo "=== RESULT ${name}: FAIL"; failed=1; fi`);
  }
  lines.push('exit $failed');
  return lines.join('\n');
}

// The contract rules compare with origin/main inside the copy, so the repository must have a real .git folder and that ref. Returns a message or null.
export function preflight(root, { gitRunner = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }) } = {}) {
  let stat;
  try {
    stat = statSync(path.join(root, '.git'));
  } catch {
    return 'ci:linux needs a git repository: there is no .git here (the step contract-rules compares with origin/main).';
  }
  if (stat.isFile()) return 'ci:linux cannot copy a git worktree or submodule (.git is a file, not a folder): run it from the main clone, where .git is a folder.';
  const ref = gitRunner(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
  if (ref.status !== 0) return 'ci:linux needs the ref origin/main for the step contract-rules: run git fetch origin main first.';
  return null;
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const skipBuild = argv.includes('--skip-image-build');
  const i = argv.indexOf('--only');
  const only = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !STEPS.some(([n]) => n === only)) {
    process.stderr.write(`unknown step ${only}; steps: ${STEPS.map(([n]) => n).join(', ')}\n`);
    return 2;
  }
  const problem = !only || only === 'contract-rules' ? preflight(root) : null;
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return 2;
  }
  if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status !== 0) {
    process.stderr.write('Docker is not running or not installed; start Docker Desktop and try again.\n');
    return 2;
  }
  if (!skipBuild) {
    const b = spawnSync('docker', ['build', '--quiet', '-t', IMAGE_TAG, '-'], { input: dockerfile(), stdio: ['pipe', 'inherit', 'inherit'] });
    if (b.status !== 0) return 1;
  }
  const run = spawnSync('docker', ['run', '--rm', '-v', `${root}:/src:ro`, '-e', 'CI=true', '-e', 'UV_HTTP_TIMEOUT=180','-e', `${NESTED_PYTEST_SWITCH}=1`, IMAGE_TAG, 'bash', '-c', containerScript(only)], { stdio: 'inherit' });
  return run.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
