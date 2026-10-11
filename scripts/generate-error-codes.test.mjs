import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DIR, loadRegistry, REGISTRY_FILE } from './validate-errors.mjs';
import { DEFAULT_PY, DEFAULT_TS, main, renderPython, renderTypeScript } from './generate-error-codes.mjs';

const reg = loadRegistry(DEFAULT_DIR);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'if8gen-'));
const quiet = () => ({ log: () => {}, err: () => {} });

test('the committed generated files are current (what CI runs)', () => {
  assert.equal(main(['--check'], quiet()), 0);
});

test('the Python output names every code, in registry order, with its status and exit code', () => {
  const py = renderPython(reg);
  for (const c of reg.codes) assert.ok(py.includes(`"${c.code}"`), c.code);
  assert.match(py, /ErrorCode\.INST_INJECT_BAD_DOCUMENT: ErrorInfo\(ErrorCode\.INST_INJECT_BAD_DOCUMENT, None, .*, False, exit_code=10\)/);
  assert.match(py, /ErrorCode\.REQ_ROUTE_UNKNOWN: ErrorInfo\(ErrorCode\.REQ_ROUTE_UNKNOWN, 404, "Route not found\.", False\)/);
  assert.ok(py.indexOf('ATT_CHALLENGE_NOT_FOUND') < py.indexOf('REQ_VALIDATION'));
  assert.ok(!py.includes('\r'), 'LF line endings');
});

test('the TypeScript output names every code and is valid TypeScript (loaded under Node)', async () => {
  const ts = renderTypeScript(reg);
  for (const c of reg.codes) assert.ok(ts.includes(`"${c.code}"`), c.code);
  const mod = await import(pathToFileURL(DEFAULT_TS).href); // Node strips the types; a syntax error would throw here
  assert.equal(Object.keys(mod.ERROR_CODES).length, reg.codes.length);
  assert.equal(mod.ERROR_CODES.AUTH_SESSION_REQUIRED, 'AUTH-SESSION-REQUIRED');
  assert.deepEqual(mod.ERRORS['INST-INJECT-MARKER-WRITE'], { status: null, title: 'The flags file or the marker could not be written.', retryable: false, exitCode: 13 });
  assert.equal(mod.problemType('REQ-VALIDATION'), 'urn:vulnmart:error:REQ-VALIDATION');
});

test('writing then checking in a scratch folder works, and a changed file is reported stale', () => {
  const dir = tmp();
  const py = path.join(dir, 'a', 'error_codes.py');
  const ts = path.join(dir, 'b', 'error-codes.ts');
  const base = ['--py', py, '--ts', ts];
  assert.equal(main(['--check', ...base], quiet()), 1, 'missing files are stale');
  assert.equal(main(base, quiet()), 0);
  assert.equal(main(['--check', ...base], quiet()), 0);
  fs.appendFileSync(py, '# hand edit\n');
  const err = [];
  assert.equal(main(['--check', ...base], { log: () => {}, err: (m) => err.push(m) }), 1);
  assert.match(err.join('\n'), /STALE: .*error_codes\.py/);
  assert.equal(main(base, quiet()), 0, 'regenerating repairs it');
  assert.equal(main(['--check', ...base], quiet()), 0);
});

test('CRLF in a checked-out file does not make it stale (Windows checkouts)', () => {
  const dir = tmp();
  const py = path.join(dir, 'error_codes.py');
  const ts = path.join(dir, 'error-codes.ts');
  assert.equal(main(['--py', py, '--ts', ts], quiet()), 0);
  for (const f of [py, ts]) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(main(['--check', '--py', py, '--ts', ts], quiet()), 0);
});

test('nothing is generated from an invalid registry', () => {
  const dir = tmp();
  fs.cpSync(DEFAULT_DIR, dir, { recursive: true });
  const f = path.join(dir, REGISTRY_FILE);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('code: REQ-VALIDATION', 'code: ZZZ-VALIDATION'));
  const py = path.join(dir, 'out', 'error_codes.py');
  const err = [];
  assert.equal(main(['--dir', dir, '--py', py, '--ts', path.join(dir, 'out', 'e.ts')], { log: () => {}, err: (m) => err.push(m) }), 1);
  assert.match(err.join('\n'), /not valid, nothing was generated/);
  assert.equal(fs.existsSync(py), false);
});

test('usage: --help exits 0 and an unknown argument exits 2', () => {
  assert.equal(main(['--help'], quiet()), 0);
  assert.equal(main(['--nope'], quiet()), 2);
});

test('the default output paths are the two package files', () => {
  assert.match(DEFAULT_PY.replace(/\\/g, '/'), /packages\/py-models\/src\/vulnmart_models\/error_codes\.py$/);
  assert.match(DEFAULT_TS.replace(/\\/g, '/'), /packages\/ts-client\/src\/error-codes\.ts$/);
});

test('usage: a flag that needs a value and has none exits 2 with a clear message', () => {
  const err = [];
  assert.equal(main(['--py'], { log: () => {}, err: (m) => err.push(m) }), 2);
  assert.match(err.join('\n'), /--py needs a value/);
  assert.equal(main(['--dir', '--check'], quiet()), 2);
});
