import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { BUNDLE_FILE, DEFAULT_LAB, DEFAULT_OUT, DEFAULT_PLATFORM, REPORT_FILE, bundleFragments, main, rewriteRefs, sameIgnoringCosmetics, unresolvedRefs } from './bundle-openapi.mjs';

const capture = () => { const out = []; const errs = []; return { out, errs, io: { log: (m) => out.push(m), err: (m) => errs.push(m) } }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vulnmart-bundle-test-'));
const doc = (over = {}) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1.0.0' },
  servers: [{ url: '/' }],
  security: [],
  paths: {},
  components: { schemas: {} },
  ...over,
});
const op = (operationId, extra = {}) => ({ operationId, responses: { 200: { description: 'ok' } }, ...extra });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });

test('rewriteRefs renames only the references named in the map', () => {
  const out = rewriteRefs({ a: ref('Problem'), b: [ref('Cursor')], c: { $ref: '#/components/responses/NotFound' } }, { 'schemas/Problem': 'LabProblem' });
  assert.equal(out.a.$ref, '#/components/schemas/LabProblem');
  assert.equal(out.b[0].$ref, '#/components/schemas/Cursor');
  assert.equal(out.c.$ref, '#/components/responses/NotFound');
});

test('sameIgnoringCosmetics ignores descriptions and examples but not structure', () => {
  assert.ok(sameIgnoringCosmetics({ type: 'string', description: 'a', example: 'x' }, { type: 'string', description: 'b' }));
  assert.ok(!sameIgnoringCosmetics({ type: 'string' }, { type: 'integer' }));
  assert.ok(!sameIgnoringCosmetics({ type: 'string', pattern: '^a$' }, { type: 'string', pattern: '^b$' }));
});

test('unresolvedRefs lists a reference to a component that does not exist', () => {
  const d = doc({ paths: { '/api/v1/x': { get: op('x', { responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref('Missing') } } } } }) } } });
  assert.deepEqual(unresolvedRefs(d), ['#/components/schemas/Missing']);
  assert.deepEqual(unresolvedRefs(doc()), []);
});

test('an identical shared component is defined once and listed as shared (a changed description does not make it differ)', () => {
  const a = doc({ components: { schemas: { Cursor: { type: 'string', description: 'platform text' } } } });
  const b = doc({ components: { schemas: { Cursor: { type: 'string', description: 'lab text' } } } });
  const r = bundleFragments(a, b);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.bundle.components.schemas.Cursor, { type: 'string', description: 'platform text' }, 'the platform definition is authoritative');
  assert.deepEqual(r.report.shared_components, [{ section: 'schemas', name: 'Cursor' }]);
  assert.deepEqual(r.report.renamed_components, []);
});

test('a differing component of the second fragment is kept under the Lab prefix and its references follow', () => {
  const a = doc({ components: { schemas: { Problem: { type: 'object', required: ['code'] } } } });
  const b = doc({
    paths: { '/api/v1/lab': { get: op('lab', { responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref('Problem') } } } } }) } },
    components: { schemas: { Problem: { type: 'object', required: ['error'] } } },
  });
  const r = bundleFragments(a, b);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.bundle.components.schemas.Problem, { type: 'object', required: ['code'] });
  assert.deepEqual(r.bundle.components.schemas.LabProblem, { type: 'object', required: ['error'] });
  assert.equal(r.bundle.paths['/api/v1/lab'].get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/LabProblem');
  assert.deepEqual(r.report.renamed_components.map((x) => x.renamed_to), ['LabProblem']);
});

test('a component that refers to a renamed one is renamed too (fixpoint), even when it looks the same', () => {
  const a = doc({ components: { schemas: { Problem: { type: 'object', required: ['code'] }, Wrapper: { type: 'array', items: ref('Problem') } } } });
  const b = doc({ components: { schemas: { Problem: { type: 'object', required: ['error'] }, Wrapper: { type: 'array', items: ref('Problem') } } } });
  const r = bundleFragments(a, b);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(Object.keys(r.bundle.components.schemas).sort(), ['LabProblem', 'LabWrapper', 'Problem', 'Wrapper']);
  assert.equal(r.bundle.components.schemas.LabWrapper.items.$ref, '#/components/schemas/LabProblem');
  assert.equal(r.bundle.components.schemas.Wrapper.items.$ref, '#/components/schemas/Problem');
});

test('sameIgnoringCosmetics compares a member called title but not a title keyword', () => {
  const a = { type: 'object', properties: { title: { type: 'string', maxLength: 10 } } };
  assert.ok(sameIgnoringCosmetics(a, { type: 'object', properties: { title: { type: 'string', maxLength: 10 } } }));
  assert.ok(!sameIgnoringCosmetics(a, { type: 'object', properties: { title: { type: 'string', maxLength: 99 } } }));
  assert.ok(!sameIgnoringCosmetics(a, { type: 'object', properties: { title: { type: 'string', maxLength: 10 }, description: { type: 'string' } } }));
  assert.ok(sameIgnoringCosmetics({ type: 'string', title: 'x' }, { type: 'string', title: 'y' }));
});

test('two components that differ only in a member called title are not the same, so the lab one is renamed', () => {
  const a = doc({ components: { schemas: { Problem: { type: 'object', properties: { title: { type: 'string', maxLength: 10 } } } } } });
  const b = doc({ components: { schemas: { Problem: { type: 'object', properties: { title: { type: 'string', maxLength: 99 } } } } } });
  const r = bundleFragments(a, b);
  assert.deepEqual(r.report.renamed_components.map((x) => x.renamed_to), ['LabProblem']);
});

test('fragments whose top-level security or servers differ are refused (a lab operation would inherit the platform default)', () => {
  const a = doc({ security: [{ sessionCookie: [] }] });
  assert.match(bundleFragments(a, doc({ security: [] })).problems.join('\n'), /top-level security of the two fragments differ/);
  assert.match(bundleFragments(doc(), doc({ servers: [{ url: '/other' }] })).problems.join('\n'), /top-level servers of the two fragments differ/);
  assert.deepEqual(bundleFragments(a, doc({ security: [{ sessionCookie: [] }] })).problems, []);
});

test('a rename that would overwrite an existing component is refused', () => {
  const a = doc({ components: { schemas: { Problem: { type: 'object' }, LabProblem: { type: 'string' } } } });
  const b = doc({ components: { schemas: { Problem: { type: 'integer' } } } });
  assert.match(bundleFragments(a, b).problems.join('\n'), /schemas\/Problem would be renamed to LabProblem, which already exists/);
});

test('a security scheme that differs cannot be renamed (requirements name it)', () => {
  const a = doc({ components: { securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'a' } } } });
  const b = doc({ components: { securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'b' } } } });
  assert.match(bundleFragments(a, b).problems.join('\n'), /security scheme sessionCookie differs between the fragments/);
});

test('every operation carries x-fragment and the counts are reported', () => {
  const a = doc({ paths: { '/api/v1/a': { get: op('a'), post: op('aPost') } } });
  const b = doc({ paths: { '/api/v1/b': { get: op('b') } } });
  const r = bundleFragments(a, b);
  assert.equal(r.bundle.paths['/api/v1/a'].get['x-fragment'], 'platform');
  assert.equal(r.bundle.paths['/api/v1/b'].get['x-fragment'], 'lab');
  assert.equal(r.report.operations, 3);
  assert.deepEqual(r.report.fragments.map((f) => [f.name, f.operations]), [['platform', 2], ['lab', 1]]);
});

test('a method of the same path may come from both fragments, the same method may not', () => {
  const a = doc({ paths: { '/api/v1/x': { get: op('xGet') } } });
  const ok = bundleFragments(a, doc({ paths: { '/api/v1/x': { post: op('xPost') } } }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(Object.keys(ok.bundle.paths['/api/v1/x']).sort(), ['get', 'post']);
  const clash = bundleFragments(a, doc({ paths: { '/api/v1/x': { get: op('other') } } }));
  assert.match(clash.problems.join('\n'), /\/api\/v1\/x GET is defined in both fragments/);
});

test('the bundle refuses what the rules forbid, naming the problem', () => {
  const cases = [
    [doc({ paths: { '/internal/v1/events': { post: op('ev') } } }), /internal route/],
    [doc({ paths: { '/api/v1/internal/x': { get: op('ix') } } }), /internal route/],
    [doc({ paths: { '/api/v1/internal': { get: op('i0') } } }), /internal route/],
    [doc({ paths: { '/api/v1/Internal/x': { get: op('i1') } } }), /internal route/],
    [doc({ paths: { '/health': { get: op('h') } } }), /not under \/api\/v1\//],
    [doc({ openapi: '3.0.3' }), /openapi must be 3\.1\.0/],
  ];
  for (const [bad, pattern] of cases) {
    const r = bundleFragments(bad, doc());
    assert.match(r.problems.join('\n'), pattern);
    assert.equal(r.bundle, undefined);
    const swapped = bundleFragments(doc(), bad);
    assert.match(swapped.problems.join('\n'), pattern, 'the second fragment is checked too');
  }
});

test('a duplicate or missing operationId and an unresolved reference fail the bundle', () => {
  const a = doc({ paths: { '/api/v1/a': { get: op('same') } } });
  const dup = bundleFragments(a, doc({ paths: { '/api/v1/b': { get: op('same') } } }));
  assert.match(dup.problems.join('\n'), /operationId same is used by platform \/api\/v1\/a and by lab \/api\/v1\/b/);
  const none = bundleFragments(a, doc({ paths: { '/api/v1/b': { get: { responses: { 200: { description: 'ok' } } } } } }));
  assert.match(none.problems.join('\n'), /lab GET \/api\/v1\/b has no operationId/);
  const dangling = bundleFragments(doc({ paths: { '/api/v1/a': { get: op('a', { responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref('Nope') } } } } }) } } }), doc());
  assert.match(dangling.problems.join('\n'), /unresolved reference #\/components\/schemas\/Nope/);
});

test('the output is deterministic: the same input twice gives the same bytes, and the inputs are not changed', () => {
  const a = doc({ paths: { '/api/v1/a': { get: op('a') } }, components: { schemas: { P: { type: 'object' } } } });
  const b = doc({ paths: { '/api/v1/b': { get: op('b') } }, components: { schemas: { P: { type: 'string' } } } });
  const before = JSON.stringify([a, b]);
  const one = JSON.stringify(bundleFragments(a, b));
  const two = JSON.stringify(bundleFragments(a, b));
  assert.equal(one, two);
  assert.equal(JSON.stringify([a, b]), before);
});

// ---- the command and the committed files ----

const fragments = () => {
  const dir = tmp();
  const platform = path.join(dir, 'platform.yaml');
  const lab = path.join(dir, 'lab.yaml');
  fs.writeFileSync(platform, yaml.dump(doc({ paths: { '/api/v1/a': { get: op('a') } } })));
  fs.writeFileSync(lab, yaml.dump(doc({ paths: { '/api/v1/b': { get: op('b') } } })));
  return { dir, platform, lab, out: path.join(dir, 'out') };
};
const args = (f, ...more) => ['--platform', f.platform, '--lab', f.lab, '--out', f.out, ...more];

test('write, then check: current exits 0; a changed fragment or a missing file is stale (1)', () => {
  const f = fragments();
  let c = capture();
  assert.equal(main(args(f, '--check'), c.io), 1, 'nothing written yet');
  assert.match(c.errs.join('\n'), /STALE: .*openapi\.json is missing/);
  c = capture();
  assert.equal(main(args(f), c.io), 0);
  assert.match(c.out.join('\n'), /wrote .*openapi\.json/);
  c = capture();
  assert.equal(main(args(f), c.io), 0);
  assert.match(c.out.join('\n'), /unchanged .*openapi\.json/);
  c = capture();
  assert.equal(main(args(f, '--check'), c.io), 0, c.errs.join('\n'));
  assert.match(c.out.join('\n'), /OK: the bundle is current \(2 operations/);

  fs.writeFileSync(f.platform, yaml.dump(doc({ paths: { '/api/v1/a': { get: op('a'), post: op('aPost') } } })));
  c = capture();
  assert.equal(main(args(f, '--check'), c.io), 1);
  assert.match(c.errs.join('\n'), /STALE: .*openapi\.json does not match the fragments/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, BUNDLE_FILE), 'utf8')).paths['/api/v1/a'].post, undefined, '--check writes nothing');

  fs.rmSync(path.join(f.out, REPORT_FILE));
  fs.writeFileSync(f.platform, yaml.dump(doc({ paths: { '/api/v1/a': { get: op('a') } } })));
  c = capture();
  assert.equal(main(args(f, '--check'), c.io), 1);
  assert.match(c.errs.join('\n'), /STALE: .*bundle-report\.json is missing/);
});

test('CRLF line endings in the committed bundle (a Windows checkout) are not stale', () => {
  const f = fragments();
  assert.equal(main(args(f), capture().io), 0);
  for (const name of [BUNDLE_FILE, REPORT_FILE]) {
    const file = path.join(f.out, name);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  }
  const c = capture();
  assert.equal(main(args(f, '--check'), c.io), 0, c.errs.join('\n'));
});

test('a fragment that breaks a rule exits 1 and writes nothing; an unreadable one exits 1', () => {
  const f = fragments();
  fs.writeFileSync(f.lab, yaml.dump(doc({ paths: { '/internal/v1/orch/state': { post: op('orchState') } } })));
  let c = capture();
  assert.equal(main(args(f), c.io), 1);
  assert.match(c.errs.join('\n'), /internal route/);
  assert.ok(!fs.existsSync(f.out), 'nothing was written');
  c = capture();
  assert.equal(main(['--platform', path.join(f.dir, 'missing.yaml'), '--lab', f.lab, '--out', f.out], c.io), 1);
  assert.match(c.errs.join('\n'), /cannot read .*missing\.yaml/);
  fs.writeFileSync(f.lab, 'a: [unclosed');
  c = capture();
  assert.equal(main(args(f), c.io), 1);
  assert.match(c.errs.join('\n'), /cannot read/);
});

test('--help exits 0; an unknown argument or a missing value is a usage error (2)', () => {
  let c = capture();
  assert.equal(main(['--help'], c.io), 0);
  assert.match(c.out.join('\n'), /Usage: node scripts\/bundle-openapi\.mjs/);
  c = capture();
  assert.equal(main(['--frobnicate'], c.io), 2);
  assert.match(c.errs.join('\n'), /Unknown argument "--frobnicate"/);
  c = capture();
  assert.equal(main(['--out'], c.io), 2);
  c = capture();
  assert.equal(main(['--lab', '--check'], c.io), 2);
});

test('the committed bundle is the bundle of the two real fragments, with every operation of both', () => {
  const c = capture();
  assert.equal(main(['--check'], c.io), 0, c.errs.join('\n'));
  const bundle = JSON.parse(fs.readFileSync(path.join(DEFAULT_OUT, BUNDLE_FILE), 'utf8'));
  const methods = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
  const count = (d) => Object.values(d.paths).reduce((n, item) => n + methods.filter((m) => item[m]).length, 0);
  const platform = yaml.load(fs.readFileSync(DEFAULT_PLATFORM, 'utf8'));
  const lab = yaml.load(fs.readFileSync(DEFAULT_LAB, 'utf8'));
  assert.equal(count(bundle), count(platform) + count(lab));
  assert.deepEqual(unresolvedRefs(bundle), []);
  for (const p of Object.keys(bundle.paths)) assert.ok(p.startsWith('/api/v1/') && !p.includes('/internal/'), p);
  const ids = Object.values(bundle.paths).flatMap((item) => methods.filter((m) => item[m]).map((m) => item[m].operationId));
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
  for (const item of Object.values(bundle.paths)) for (const m of methods) if (item[m]) assert.match(item[m]['x-fragment'], /^(platform|lab)$/);
  assert.equal(bundle.components.schemas.Problem.required.includes('request_id'), true, 'the IF-8 Problem of the platform is the authoritative one');
});
