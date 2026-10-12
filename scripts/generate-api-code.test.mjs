import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUNDLE, DEFAULT_PY, DEFAULT_TS, main } from './generate-api-code.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capture = () => { const out = []; const errs = []; return { out, errs, io: { log: (m) => out.push(m), err: (m) => errs.push(m) } }; };
const read = (f) => fs.readFileSync(f, 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vulnmart-gen-test-'));

test('--help prints the usage and exits 0', async () => {
  const c = capture();
  assert.equal(await main(['--help'], c.io), 0);
  assert.match(c.out.join('\n'), /Usage: node scripts\/generate-api-code\.mjs/);
});

test('an unknown argument or a missing value is a usage error (2)', async () => {
  let c = capture();
  assert.equal(await main(['--nope'], c.io), 2);
  assert.match(c.errs.join('\n'), /Unknown argument "--nope"/);
  c = capture();
  assert.equal(await main(['--ts'], c.io), 2);
  assert.match(c.errs.join('\n'), /--ts needs a value/);
  c = capture();
  assert.equal(await main(['--py', '--check'], c.io), 2);
});

test('a missing bundle is reported, not generated from', async () => {
  const c = capture();
  assert.equal(await main(['--check', '--bundle', path.join(tmp(), 'none.json')], c.io), 1);
  assert.match(c.errs.join('\n'), /Bundle not found/);
});

test('the checked-in generated files are current and carry the header', async () => {
  const c = capture();
  assert.equal(await main(['--check'], c.io), 0, c.errs.join('\n'));
  for (const f of [DEFAULT_TS, DEFAULT_PY]) {
    const text = read(f);
    assert.ok(text.split(/\r?\n/)[0].includes('GENERATED from contracts/api/bundle/openapi.json'), `${f} header`);
  }
});

test('a stale file is found by --check, written by the plain run, and CRLF alone is not stale', async () => {
  const dir = tmp();
  const ts = path.join(dir, 'api.d.ts');
  const py = path.join(dir, 'api.py');
  fs.writeFileSync(ts, read(DEFAULT_TS) + '// drift\n');
  fs.writeFileSync(py, read(DEFAULT_PY));
  let c = capture();
  assert.equal(await main(['--check', '--ts', ts, '--py', py], c.io), 1);
  assert.match(c.errs.join('\n'), /STALE: .*api\.d\.ts/);
  assert.ok(!c.errs.join('\n').includes('api.py'), 'only the drifted file is named');
  c = capture();
  assert.equal(await main(['--ts', ts, '--py', py], c.io), 0);
  assert.match(c.out.join('\n'), /wrote .*api\.d\.ts/);
  assert.match(c.out.join('\n'), /unchanged .*api\.py/);
  assert.equal(read(ts), read(DEFAULT_TS));
  fs.writeFileSync(ts, read(ts).replace(/\n/g, '\r\n'));
  fs.writeFileSync(py, read(py).replace(/\n/g, '\r\n'));
  c = capture();
  assert.equal(await main(['--check', '--ts', ts, '--py', py], c.io), 0, c.errs.join('\n'));
});

test('a changed bundle changes the generated code (the generators read the bundle, not a cache)', async () => {
  const dir = tmp();
  const bundle = JSON.parse(read(DEFAULT_BUNDLE));
  bundle.paths['/api/v1/health'].get.summary = 'Is the platform answering (changed in a test)';
  const file = path.join(dir, 'openapi.json');
  fs.writeFileSync(file, JSON.stringify(bundle));
  const ts = path.join(dir, 'api.d.ts');
  const py = path.join(dir, 'api.py');
  const c = capture();
  assert.equal(await main(['--bundle', file, '--ts', ts, '--py', py], c.io), 0, c.errs.join('\n'));
  assert.match(read(ts), /changed in a test/);
});

test('the generated Python models import and accept the examples (scripts/check_api_models.py)', () => {
  const r = spawnSync('uv', ['run', '--locked', '--package', 'vulnmart-models', 'python', 'scripts/check_api_models.py'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^OK: \d+ checks, 0 problem\(s\)\./m);
});

test('the TypeScript client compiles against the generated types (tsc over src and test)', () => {
  const tsc = path.join(ROOT, 'packages', 'ts-client', 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], { cwd: path.join(ROOT, 'packages', 'ts-client'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the type test fails to compile when the client no longer matches the bundle', () => {
  const dir = tmp();
  const pkg = path.join(ROOT, 'packages', 'ts-client');
  fs.cpSync(path.join(pkg, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(pkg, 'test'), path.join(dir, 'test'), { recursive: true });
  fs.copyFileSync(path.join(pkg, 'tsconfig.json'), path.join(dir, 'tsconfig.json'));
  fs.symlinkSync(path.join(pkg, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const api = path.join(dir, 'src', 'api.d.ts');
  fs.writeFileSync(api, read(api).replace('"/api/v1/health"', '"/api/v1/healthz"'));
  const r = spawnSync(process.execPath, [path.join(pkg, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'a renamed path must break the type test');
  assert.match(r.stdout, /error TS/);
});
