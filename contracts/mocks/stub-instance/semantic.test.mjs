// Parity: the stub and the contract validator use ONE set of semantic rules, so the stub accepts exactly the documents the contract calls valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as shared from './semantic.mjs';
import * as validator from '../../../scripts/validate-contracts.mjs';
import { documentOk, runInject } from './inject.mjs';
import { startDocumentOk, readStartDocument } from './sidecar.mjs';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'instance', 'examples');
const files = (kind, schema) => fs.readdirSync(path.join(EXAMPLES, kind, schema)).filter((f) => f.endsWith('.json')).map((f) => [`${kind}/${schema}/${f}`, JSON.parse(fs.readFileSync(path.join(EXAMPLES, kind, schema, f), 'utf8'))]);

test('the validator uses the very same semantic functions as the stub', () => {
  assert.equal(validator.semanticInjection, shared.semanticInjection);
  assert.equal(validator.semanticSidecarStart, shared.semanticSidecarStart);
});

test('injector: the stub agrees with the contract on every injection-document example', () => {
  for (const [name, doc] of files('valid', 'injection-document')) assert.equal(documentOk(doc), true, name);
  for (const [name, doc] of files('invalid', 'injection-document')) assert.equal(documentOk(doc), false, name);
});

test('sidecar: the stub agrees with the contract on every sidecar-start example (every semantic case included)', () => {
  const invalid = files('invalid', 'sidecar-start');
  assert.ok(invalid.some(([n]) => n.includes('digest-repeated')) && invalid.some(([n]) => n.includes('key-and-kind-repeated')));
  for (const [name, doc] of files('valid', 'sidecar-start')) assert.equal(startDocumentOk(doc), true, name);
  for (const [name, doc] of invalid) assert.equal(startDocumentOk(doc), false, name);
});

test('the semantic cases are rejected through the real readers too, not only the pure functions', async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'invalid', 'sidecar-start', 'digest-repeated.json'), 'utf8'));
  assert.equal((await readStartDocument(Readable.from([JSON.stringify(doc)]))).ok, false);
  const inj = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'invalid', 'injection-document', 'duplicate-decoy-index.json'), 'utf8'));
  const out = [];
  assert.equal(await runInject({ stdin: Readable.from([JSON.stringify(inj)]), env: { VM_SNAPSHOT_PATH: '/nonexistent/s', VM_FLAGS_PATH: '/nonexistent/f' }, log: (m) => out.push(m) }), 10);
});
