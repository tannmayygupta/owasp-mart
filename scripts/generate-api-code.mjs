// Generates the typed API code from the bundle of the browser API (IF-1 and IF-2, contracts/api/bundle/openapi.json).
//   packages/ts-client/src/api.d.ts            TypeScript types (openapi-typescript), used by the client in src/index.ts
//   packages/py-models/src/vulnmart_models/api.py   Pydantic models (datamodel-code-generator)
// Usage: node scripts/generate-api-code.mjs [--check] [--bundle <file>] [--ts <file>] [--py <file>] [--help]
//   (no flag)  write both files
//   --check    write nothing; exit 1 when a file differs from what the bundle produces (used by CI)
// The bundle itself is checked first (`node scripts/bundle-openapi.mjs --check`): nothing is generated from a stale bundle.
// Exit code 0 when done or current, 1 when a file is stale or the generator failed, 2 on a usage error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_LAB, DEFAULT_OUT, DEFAULT_PLATFORM, run as bundleRun } from './bundle-openapi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BUNDLE = path.join(ROOT, 'contracts', 'api', 'bundle', 'openapi.json');
export const DEFAULT_TS = path.join(ROOT, 'packages', 'ts-client', 'src', 'api.d.ts');
export const DEFAULT_PY = path.join(ROOT, 'packages', 'py-models', 'src', 'vulnmart_models', 'api.py');
export const HELP = `Generate the typed API code from the bundle (IF-1 and IF-2)
Usage: node scripts/generate-api-code.mjs [--check] [--bundle <file>] [--ts <file>] [--py <file>] [--help]
Exit code 0 when done or current, 1 when a file is stale or a generator failed, 2 on a usage error.`;

const normalise = (s) => s.replace(/\r\n/g, '\n');

export async function renderTypeScript(bundleFile) {
  // openapi-typescript is a dev dependency of packages/ts-client, so it is loaded from there
  const req = createRequire(path.join(ROOT, 'packages', 'ts-client', 'package.json'));
  const esm = req.resolve('openapi-typescript').replace(/\.cjs$/, '.mjs'); // resolve() answers with the CommonJS entry
  const { default: openapiTS, astToString } = await import(pathToFileURL(esm).href);
  const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  const ast = await openapiTS(bundle, { alphabetize: false });
  const header = [
    '// GENERATED from contracts/api/bundle/openapi.json (IF-1 and IF-2). Do not edit: run `node scripts/generate-api-code.mjs`.',
    '',
  ].join('\n');
  return normalise(header + astToString(ast)).replace(/\s+$/, '') + '\n';
}

export function renderPython(bundleFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnmart-api-models-'));
  const out = path.join(tmp, 'api.py');
  try {
    const args = [
      'run', '--locked', '--package', 'vulnmart-models', 'datamodel-codegen',
      '--input', bundleFile, '--input-file-type', 'openapi',
      '--output-model-type', 'pydantic_v2.BaseModel', '--target-python-version', '3.14',
      '--use-annotated', '--use-union-operator', '--use-standard-collections', '--field-constraints',
      // an address is a plain string here: email-validator refuses the reserved names (.test, .local, .invalid) the dev and test mail uses
      '--type-mappings', 'string+email=string',
      '--disable-timestamp', '--custom-file-header',
      '# GENERATED from contracts/api/bundle/openapi.json (IF-1 and IF-2). Do not edit: run `node scripts/generate-api-code.mjs`.',
      '--output', out,
    ];
    const r = spawnSync('uv', args, { cwd: ROOT, encoding: 'utf8', env: process.env });
    if (r.status !== 0) throw new Error(`datamodel-codegen failed (exit ${r.status}): ${(r.stderr || r.error?.message || '').trim()}`);
    return normalise(fs.readFileSync(out, 'utf8')).replace(/\s+$/, '') + '\n';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function run({ check, bundle, ts, py }, { log = console.log, err = console.error } = {}) {
  if (!fs.existsSync(bundle)) { err(`Bundle not found: ${path.relative(ROOT, bundle)}. Run: node scripts/bundle-openapi.mjs`); return 1; }
  if (bundle === DEFAULT_BUNDLE) {
    // the committed bundle must be the bundle of the fragments; a bundle given with --bundle is taken as it is (tests)
    const quiet = { log: () => {}, err };
    if (bundleRun({ platform: DEFAULT_PLATFORM, lab: DEFAULT_LAB, out: DEFAULT_OUT, check: true }, quiet) !== 0) { err('The bundle is stale or invalid, nothing was generated. Run: pnpm run contracts:bundle'); return 1; }
  }
  let targets;
  try {
    targets = [
      [ts, await renderTypeScript(bundle)],
      [py, renderPython(bundle)],
    ];
  } catch (e) {
    err(`Generation failed: ${e.message}`);
    return 1;
  }
  let stale = 0;
  for (const [file, content] of targets) {
    const rel = path.relative(ROOT, file);
    const current = fs.existsSync(file) ? normalise(fs.readFileSync(file, 'utf8')) : null;
    if (check) {
      if (current !== content) { err(`STALE: ${rel} does not match the bundle. Run: node scripts/generate-api-code.mjs`); stale++; }
      continue;
    }
    if (current === content) { log(`unchanged ${rel}`); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    log(`wrote ${rel}`);
  }
  if (check) {
    if (stale) return 1;
    log('OK: generated API code is current.');
  }
  return 0;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const opts = { check: false, bundle: DEFAULT_BUNDLE, ts: DEFAULT_TS, py: DEFAULT_PY };
  const err = io.err || console.error;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { (io.log || console.log)(HELP); return 0; }
    if (a === '--check') { opts.check = true; continue; }
    if (['--bundle', '--ts', '--py'].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { err(`${a} needs a value.`); return 2; }
      opts[a.slice(2)] = path.resolve(argv[++i]);
      continue;
    }
    err(`Unknown argument "${a}". Run with --help.`);
    return 2;
  }
  return run(opts, io);
}

if (import.meta.main) process.exit(await main());
