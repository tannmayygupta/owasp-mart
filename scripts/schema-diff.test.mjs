import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diffSchemas } from './schema-diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = (o) => JSON.parse(JSON.stringify(o));

const BASE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', pattern: '^[a-z]+$', minLength: 1, maxLength: 20 },
    kind: { enum: ['a', 'b'] },
    count: { type: 'integer', minimum: 0, maximum: 10 },
    tags: { type: 'array', items: { type: 'string' } },
    pick: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    inner: { type: 'object', properties: { x: { type: 'number' } }, required: [] },
  },
  $defs: { Name: { type: 'string' } },
};
const with_ = (fn) => { const h = clone(BASE); fn(h); return h; };
const paths = (head) => diffSchemas(BASE, head).map((d) => `${d.path} ${d.change}`);

test('additive changes are not breaking', () => {
  const head = with_((h) => {
    h.properties.extra = { type: 'string' }; // new optional property
    h.properties.kind.enum.push('c'); // new enum value
    h.properties.id.pattern = undefined; // pattern dropped (loosened)
    delete h.properties.id.pattern;
    h.properties.count.maximum = 20;
    h.properties.count.minimum = -5;
    h.properties.id.description = 'a new description';
    h.properties.pick.oneOf.push({ type: 'boolean' });
    h.properties.inner.properties.y = { type: 'string' };
    h.$defs.Other = { type: 'string' };
    h.required = [];
    h.additionalProperties = true;
  });
  assert.deepEqual(paths(head), []);
});

test('identical schemas have no change', () => assert.deepEqual(diffSchemas(BASE, clone(BASE)), []));

const BREAKING = {
  'removed property': [(h) => { delete h.properties.count; }, /properties\/count.*removed/],
  'renamed property (remove and add)': [(h) => { h.properties.total = h.properties.count; delete h.properties.count; }, /properties\/count.*removed/],
  'retyped property': [(h) => { h.properties.count.type = 'string'; }, /properties\/count\/type.*changed/],
  'type widened from a string to a list (counted as retyping, by design)': [(h) => { h.properties.id.type = ['string', 'null']; }, /widened; counted as retyping/],
  'optional to required': [(h) => { h.required.push('kind'); }, /required.*kind.*optional to required/],
  'new required property': [(h) => { h.properties.new = { type: 'string' }; h.required.push('new'); }, /required.*new.*optional to required/],
  'removed enum value': [(h) => { h.properties.kind.enum = ['a']; }, /enum value "b" removed/],
  'tightened pattern': [(h) => { h.properties.id.pattern = '^[a-c]+$'; }, /pattern changed/],
  'pattern added': [(h) => { h.properties.kind.pattern = '^a$'; }, /pattern.*added/],
  'raised minimum': [(h) => { h.properties.count.minimum = 1; }, /minimum raised from 0 to 1/],
  'lowered maximum': [(h) => { h.properties.count.maximum = 5; }, /maximum lowered from 10 to 5/],
  'lowered maxLength': [(h) => { h.properties.id.maxLength = 10; }, /maxLength lowered/],
  'bound added': [(h) => { h.properties.tags.maxItems = 3; }, /maxItems.*added/],
  'additionalProperties true to false': [(h) => { h.additionalProperties = false; }, /additionalProperties changed from true to false/],
  'additionalProperties added as false': [(h) => { delete h.properties.inner.required; h.properties.inner.additionalProperties = false; }, /inner\/additionalProperties.*restricted/],
  'removed oneOf branch': [(h) => { h.properties.pick.oneOf.pop(); }, /oneOf branch removed/],
  'removed definition': [(h) => { delete h.$defs.Name; }, /Name.*definition removed/],
  'changed items type': [(h) => { h.properties.tags.items.type = 'integer'; }, /tags\/items\/type/],
  'nested property removed': [(h) => { delete h.properties.inner.properties.x; }, /inner\/properties\/x.*removed/],
  'nested required added': [(h) => { h.properties.inner.required = ['x']; }, /inner\/required.*x/],
  'format added': [(h) => { h.properties.id.format = 'uuid'; }, /format/],
  'const changed': [(h) => { h.properties.kind = { const: 'a' }; }, /./],
  'unknown keyword changed': [(h) => { h.properties.tags.uniqueItems = true; }, /uniqueItems/],
};
for (const [name, [mutate, re]] of Object.entries(BREAKING)) {
  test(`breaking: ${name}`, () => {
    const found = paths(with_(mutate));
    assert.ok(found.length > 0, `expected a breaking change, got none`);
    assert.ok(found.some((l) => re.test(l)), `${re} not in ${JSON.stringify(found)}`);
  });
}

test('the path of a finding names the property', () => {
  const [d] = diffSchemas(BASE, with_((h) => { h.properties.inner.properties.x.type = 'string'; }));
  assert.equal(d.path, '#/properties/inner/properties/x/type');
});

test('the real schemas of the repository compare clean with themselves', () => {
  for (const f of ['contracts/instance/injection-document.schema.json', 'contracts/events/instance-events.schema.json']) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.deepEqual(diffSchemas(j, clone(j)), [], f);
  }
});

test('a deliberately broken copy of a real schema fails and the command line names the path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-sd-'));
  try {
    const src = path.join(ROOT, 'contracts/instance/sidecar-start.schema.json');
    const j = JSON.parse(fs.readFileSync(src, 'utf8'));
    delete j.properties.epoch;
    fs.writeFileSync(path.join(dir, 'head.json'), JSON.stringify(j));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/schema-diff.mjs'), src, path.join(dir, 'head.json')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /BREAKING #\/properties\/epoch: property removed/);
    const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts/schema-diff.mjs'), src, src], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('{} is equal to true, in both directions and nested', () => {
  assert.deepEqual(diffSchemas({ properties: { a: true } }, { properties: { a: {} } }), []);
  assert.deepEqual(diffSchemas({ properties: { a: {} } }, { properties: { a: true } }), []);
  assert.deepEqual(diffSchemas({ items: {} }, { items: true }), []);
  assert.equal(diffSchemas({ properties: { a: {} } }, { properties: { a: { type: 'string' } } }).length, 1, 'but {} to a real constraint is narrowing');
});

test('loosening is not breaking: uniqueItems true to false, a removed minProperties, a removed if', () => {
  assert.deepEqual(diffSchemas({ uniqueItems: true }, { uniqueItems: false }), []);
  assert.deepEqual(diffSchemas({ uniqueItems: true }, {}), []);
  assert.deepEqual(diffSchemas({ minProperties: 1 }, {}), []);
  assert.deepEqual(diffSchemas({ minProperties: 2 }, { minProperties: 1 }), []);
  assert.equal(diffSchemas({ uniqueItems: false }, { uniqueItems: true }).length, 1, 'tightening is');
  assert.equal(diffSchemas({}, { uniqueItems: true }).length, 1);
});

test('a changed, added or removed if is flagged breaking conservatively and says why', () => {
  const base = { if: { properties: { k: { const: 'a' } } }, then: { required: ['x'] } };
  for (const head of [{ ...base, if: { properties: { k: { const: 'b' } } } }, { then: base.then }, { ...base, if: { properties: { k: { const: 'a' } }, required: ['k'] } }]) {
    const found = diffSchemas(base, head).filter((d) => d.path === '#/if');
    assert.equal(found.length, 1);
    assert.match(found[0].change, /flagged breaking conservatively/);
  }
  assert.equal(diffSchemas({ then: { required: ['x'] } }, { if: { const: 1 }, then: { required: ['x'] } })[0].path, '#/if');
});