import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DIR, REGISTRY_FILE, errorPath, loadRegistry, main, semanticBody, semanticRegistry, validateDir } from './validate-errors.mjs';

// A throwaway copy of contracts/errors that a test may damage.
function copyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'if8-'));
  fs.cpSync(DEFAULT_DIR, dir, { recursive: true });
  return dir;
}
const edit = (dir, file, fn) => {
  const p = path.join(dir, file);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};
const registry = (dir, fn) => edit(dir, REGISTRY_FILE, fn);
const problemsOf = (dir) => validateDir(dir).problems.join('\n');
const FLAG = 'VM{' + 'A'.repeat(24) + '}'; // built here so no flag-like literal sits in this file

test('the committed contract is valid and every code and example is counted', () => {
  const r = validateDir(DEFAULT_DIR);
  assert.deepEqual(r.problems, []);
  const files = (sub) => fs.readdirSync(path.join(DEFAULT_DIR, 'examples', sub)).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  assert.equal(r.counts.codes, loadRegistry(DEFAULT_DIR).codes.length);
  assert.equal(r.counts.valid, files('valid').length);
  assert.equal(r.counts.invalid, files('invalid').length);
  assert.ok(r.counts.codes >= 48 && r.counts.valid >= 7 && r.counts.invalid >= 24, 'the seed and the example set are not shrunk');
});

test('every code named in the merged contracts is in the registry', () => {
  const codes = new Set(loadRegistry(DEFAULT_DIR).codes.map((c) => c.code));
  for (const c of ['INST-INJECT-BAD-DOCUMENT', 'INST-INJECT-SNAPSHOT-PATCH', 'INST-INJECT-PLACEMENT-WRITE', 'INST-INJECT-MARKER-WRITE', 'INST-INJECT-FAILED']) {
    assert.ok(codes.has(c), c);
  }
});

test('the injector exit codes 10 to 13 match the instance contract', () => {
  const byCode = Object.fromEntries(loadRegistry(DEFAULT_DIR).codes.map((c) => [c.code, c.exit_code]));
  assert.equal(byCode['INST-INJECT-BAD-DOCUMENT'], 10);
  assert.equal(byCode['INST-INJECT-SNAPSHOT-PATCH'], 11);
  assert.equal(byCode['INST-INJECT-PLACEMENT-WRITE'], 12);
  assert.equal(byCode['INST-INJECT-MARKER-WRITE'], 13);
  assert.equal(byCode['INST-INJECT-FAILED'], undefined, '"any other" exit has no fixed number');
});

test('a duplicate code is rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace(/^( {2}- \{ code: ATT-NOT-FOUND.*)$/m, '$1\n$1'));
  assert.match(problemsOf(dir), /duplicate code ATT-NOT-FOUND/);
});

test('codes out of order are rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => {
    const lines = t.split('\n');
    const i = lines.findIndex((l) => l.includes('code: ATT-NOT-FOUND'));
    [lines[i], lines[i - 1]] = [lines[i - 1], lines[i]];
    return lines.join('\n');
  });
  assert.match(problemsOf(dir), /must be sorted/);
});

test('a code whose family is not listed is rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('code: REQ-VALIDATION', 'code: ZZZ-VALIDATION'));
  assert.match(problemsOf(dir), /family ZZZ is not listed/);
});

test('a status outside 400 to 599 is rejected by the schema', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('status: 401, title: "Sign in', 'status: 200, title: "Sign in'));
  assert.match(problemsOf(dir), /error-codes\.yaml \/codes\/\d+\/status/);
});

test('a lowercase or malformed code is rejected by the schema', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('code: REQ-VALIDATION', 'code: req-validation'));
  assert.match(problemsOf(dir), /\/code/);
});

test('a title with a placeholder is rejected (a title is fixed text)', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('title: "Sign in to continue."', 'title: "Sign in, {user}."'));
  assert.match(problemsOf(dir), /no placeholder/);
});

test('a title that holds a flag-like value is rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('title: "Sign in to continue."', `title: "${FLAG}"`));
  assert.match(problemsOf(dir), /flag-like/);
});

test('an exit_code on a code outside INST-INJECT-* is rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('code: AUTH-SESSION-REQUIRED, status: 401,', 'code: AUTH-SESSION-REQUIRED, exit_code: 5, status: 401,'));
  assert.match(problemsOf(dir), /INST-INJECT-\* codes only/);
});

test('two codes with one exit code are rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('code: INST-INJECT-FAILED, status: null, title: "The injector failed.", retryable: false', 'code: INST-INJECT-FAILED, status: null, title: "The injector failed.", retryable: false, exit_code: 10'));
  assert.match(problemsOf(dir), /exit code 10 is already used/);
});

test('an unknown member in a registry entry is rejected (closed shape)', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('code: AUTH-SESSION-REQUIRED, status: 401,', 'code: AUTH-SESSION-REQUIRED, internal_note: "x", status: 401,'));
  assert.match(problemsOf(dir), /internal_note|additional/i);
});

test('an invalid example that passes the schema is reported', () => {
  const dir = copyDir();
  fs.copyFileSync(path.join(dir, 'examples', 'valid', 'auth-session-required.json'), path.join(dir, 'examples', 'invalid', 'missing-request-id.json'));
  assert.match(problemsOf(dir), /missing-request-id\.json should fail the schema but passes it/);
});

test('an invalid example that fails at another path is reported', () => {
  const dir = copyDir();
  edit(dir, 'examples/invalid/manifest.json', (t) => t.replace('"path": "/request_id",\n    "rule": "request_id is required"', '"path": "/title",\n    "rule": "request_id is required"'));
  assert.match(problemsOf(dir), /missing-request-id\.json should fail at \/title but fails at \/request_id/);
});

test('an invalid example missing from the manifest, and a manifest entry without a file, are reported', () => {
  const dir = copyDir();
  fs.writeFileSync(path.join(dir, 'examples', 'invalid', 'extra.json'), '{}');
  fs.rmSync(path.join(dir, 'examples', 'invalid', 'status-200.json'));
  const out = problemsOf(dir);
  assert.match(out, /extra\.json is not in manifest\.json/);
  assert.match(out, /names status-200\.json, which does not exist/);
});

test('a valid example that contradicts the registry is reported', () => {
  const dir = copyDir();
  edit(dir, 'examples/valid/auth-session-required.json', (t) => t.replace('"Sign in to continue."', '"Please log in"'));
  assert.match(problemsOf(dir), /auth-session-required\.json \/title: title must equal the registry title/);
});

test('semanticBody: unknown code, wrong status, wrong type, and a code that is never an HTTP answer', () => {
  const reg = loadRegistry(DEFAULT_DIR);
  const ok = { type: 'urn:vulnmart:error:AUTH-SESSION-REQUIRED', title: 'Sign in to continue.', status: 401, code: 'AUTH-SESSION-REQUIRED', request_id: 'req-0a1b2c3d' };
  assert.deepEqual(semanticBody(ok, reg), []);
  assert.equal(semanticBody({ ...ok, code: 'NOPE-NOPE' }, reg)[0].path, '/code');
  assert.equal(semanticBody({ ...ok, status: 403 }, reg)[0].path, '/status');
  assert.equal(semanticBody({ ...ok, type: 'urn:vulnmart:error:AUTH-CSRF-FAILED' }, reg)[0].path, '/type');
  const inst = { type: 'urn:vulnmart:error:INST-LOST', title: 'The instance was lost.', status: 500, code: 'INST-LOST', request_id: 'req-0a1b2c3d' };
  assert.match(semanticBody(inst, reg)[0].message, /never sent as an HTTP answer/);
});

test('semanticRegistry accepts the committed registry and errorPath builds JSON Pointers', () => {
  assert.deepEqual(semanticRegistry(loadRegistry(DEFAULT_DIR)), []);
  assert.equal(errorPath({ instancePath: '', params: { missingProperty: 'request_id' } }), '/request_id');
  assert.equal(errorPath({ instancePath: '/errors/0', params: { additionalProperty: 'value' } }), '/errors/0/value');
});

test('CLI: --help exits 0, an unknown argument exits 2, a missing folder exits 1, a good folder exits 0', () => {
  const out = [];
  const err = [];
  const io = { log: (m) => out.push(m), err: (m) => err.push(m) };
  assert.equal(main(['--help'], io), 0);
  assert.equal(main(['--nope'], io), 2);
  assert.equal(main(['--dir', path.join(os.tmpdir(), 'no-such-if8-folder')], io), 1);
  assert.equal(main([], io), 0);
  assert.match(out.join('\n'), /OK: \d+ codes/);
});

test('a title with a non-ASCII character is rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('title: "Sign in to continue."', 'title: "Sign in to continue\u2026"'));
  assert.match(problemsOf(dir), /printable ASCII/);
});

test('an exit_code on a code that is sent over HTTP is rejected', () => {
  const dir = copyDir();
  registry(dir, (t) => t.replace('code: INST-INJECT-FAILED, status: null,', 'code: INST-INJECT-FAILED, status: 500,'));
  registry(dir, (t) => t.replace('title: "The injector failed.", retryable: false', 'title: "The injector failed.", retryable: false, exit_code: 14'));
  assert.match(problemsOf(dir), /never an HTTP answer \(status null\)/);
});

test('errors or field on a non-422 body, and both together, are rejected by the registry stage', () => {
  const reg = loadRegistry(DEFAULT_DIR);
  const ok = { type: 'urn:vulnmart:error:REQ-VALIDATION', title: 'The request is not valid.', status: 422, code: 'REQ-VALIDATION', request_id: 'req-0a1b2c3d' };
  assert.deepEqual(semanticBody({ ...ok, field: '/x' }, reg), []);
  assert.deepEqual(semanticBody({ ...ok, errors: [{ pointer: '/x', detail: 'd' }] }, reg), []);
  assert.match(semanticBody({ ...ok, field: '/x', errors: [{ pointer: '/x', detail: 'd' }] }, reg)[0].message, /exclusive/);
  const auth = { type: 'urn:vulnmart:error:AUTH-SESSION-REQUIRED', title: 'Sign in to continue.', status: 401, code: 'AUTH-SESSION-REQUIRED', request_id: 'req-0a1b2c3d' };
  assert.match(semanticBody({ ...auth, field: '/x' }, reg)[0].message, /only for a 422/);
});

test('an example file that is not JSON is reported, not thrown', () => {
  const dir = copyDir();
  fs.writeFileSync(path.join(dir, 'examples', 'valid', 'broken.json'), '{ not json');
  assert.match(problemsOf(dir), /broken\.json is not valid JSON/);
});

test('a manifest entry with an unknown stage is reported', () => {
  const dir = copyDir();
  edit(dir, 'examples/invalid/manifest.json', (t) => t.replace('"stage": "schema"', '"stage": "schemas"'));
  assert.match(problemsOf(dir), /stage must be "schema" or "registry"/);
});

test('CLI: --dir without a value exits 2', () => {
  assert.equal(main(['--dir'], { log: () => {}, err: () => {} }), 2);
  assert.equal(main(['--dir', '--help'], { log: () => {}, err: () => {} }), 2);
});
