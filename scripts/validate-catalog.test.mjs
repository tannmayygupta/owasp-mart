// Tests for the challenge catalogue validator (IF-7, T-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateCatalog,
  tierForDifficulty,
  semanticProblems,
  main,
  EXPECTED_KEYS,
  DEFAULT_DIR,
  DEFAULT_SCHEMA,
} from './validate-catalog.mjs';

// Silence the CLI's own console output during main() tests.
function quiet(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

test('all 11 committed stubs validate against the schema', () => {
  const { ok, errors } = validateCatalog();
  assert.deepEqual(errors, [], `expected no errors, got:\n${errors.join('\n')}`);
  assert.equal(ok, true);
});

test('tier mapping follows D-32 (1-2 Easy, 3 Medium, 4-5 Hard)', () => {
  assert.equal(tierForDifficulty(1), 'Easy');
  assert.equal(tierForDifficulty(2), 'Easy');
  assert.equal(tierForDifficulty(3), 'Medium');
  assert.equal(tierForDifficulty(4), 'Hard');
  assert.equal(tierForDifficulty(5), 'Hard');
});

test('semantic checks catch tier mismatch, key mismatch, and flag-like values', () => {
  const entry = { key: 'c06', difficulty: 4, tier: 'Easy' };
  const problems = semanticProblems(entry, 'c05', 'text with VM{AAAAAAAAAAAAAAAAAAAAAAAA}');
  assert.ok(problems.some((p) => p.includes('does not match filename')));
  assert.ok(problems.some((p) => p.includes('tier')));
  assert.ok(problems.some((p) => p.includes('flag')));
});

// Helper: build a temp catalogue dir from the real one, then mutate it.
function makeTempCatalog() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-catalog-'));
  for (const k of EXPECTED_KEYS) {
    fs.copyFileSync(path.join(DEFAULT_DIR, `${k}.yaml`), path.join(tmp, `${k}.yaml`));
  }
  return tmp;
}

test('a missing challenge file fails validation', () => {
  const tmp = makeTempCatalog();
  fs.rmSync(path.join(tmp, 'c07.yaml'));
  const { ok, errors } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('missing challenge files') && e.includes('c07')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a twelfth file fails validation', () => {
  const tmp = makeTempCatalog();
  fs.copyFileSync(path.join(DEFAULT_DIR, 'c01.yaml'), path.join(tmp, 'c12.yaml'));
  const { ok, errors } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('unexpected challenge files') && e.includes('c12')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a tier that does not match difficulty fails validation', () => {
  const tmp = makeTempCatalog();
  const p = path.join(tmp, 'c06.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('tier: Hard', 'tier: Easy'));
  const { ok, errors } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('c06.yaml') && e.includes('tier')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an unknown property fails the schema and names the property', () => {
  const tmp = makeTempCatalog();
  const p = path.join(tmp, 'c01.yaml');
  fs.appendFileSync(p, '\nsecret_notes: "nope"\n');
  const { ok, errors } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('c01.yaml') && e.includes('secret_notes')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('owasp.2021 null is accepted (C11 has no 2021 category)', () => {
  // The committed c11.yaml carries owasp.2021: null and is in the all-11 pass above;
  // assert the schema explicitly tolerates it on a mutated copy of a tagged challenge.
  const tmp = makeTempCatalog();
  const p = path.join(tmp, 'c01.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"2021": "A01"', '"2021": null'));
  const { ok } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a malformed OWASP tag fails the schema', () => {
  const tmp = makeTempCatalog();
  const p = path.join(tmp, 'c01.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/"2025": "?A01"?/, '"2025": "A99"'));
  const { ok, errors } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('c01.yaml')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('delivery: env without a reason fails; with a reason passes', () => {
  const tmp = makeTempCatalog();
  const p = path.join(tmp, 'c05.yaml');
  const base = fs.readFileSync(p, 'utf8').replace('delivery: sentinel', 'delivery: env');
  fs.writeFileSync(p, base);
  let r = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(r.ok, false, 'env with no reason should fail');
  fs.writeFileSync(p, base.replace('delivery: env', 'delivery: env\n  reason: "flag must be read from the process environment (documented)"'));
  r = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(r.ok, true, 'env with a reason should pass');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an exploit_test path for the wrong key fails', () => {
  const tmp = makeTempCatalog();
  const p = path.join(tmp, 'c01.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('challenges/tests/c01', 'challenges/tests/c02'));
  const { ok, errors } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('exploit_test')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hints out of order fail the schema', () => {
  const tmp = makeTempCatalog();
  const p = path.join(tmp, 'c01.yaml');
  // Make the first hint level 2, so it no longer matches the prefixItems const 1.
  const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace('- level: 1', '- level: 2');
  fs.writeFileSync(p, text);
  const { ok } = validateCatalog({ dir: tmp, schemaPath: DEFAULT_SCHEMA });
  assert.equal(ok, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('main() handles --help, unknown args, missing values, and a valid run', () => {
  assert.equal(quiet(() => main(['--help'])), 0);
  assert.equal(quiet(() => main(['--bogus'])), 2);
  assert.equal(quiet(() => main(['--dir'])), 2);
  assert.equal(quiet(() => main(['--dir', DEFAULT_DIR, '--schema', DEFAULT_SCHEMA])), 0);
});

// T-13 / WP-D: nothing a player can read carries a flag. The briefs, hints, write-ups, start states and milestone text live in the catalogue; the shop's own screens
// and the challenge notes are the other player-visible text. A flag-shaped value (VM{...}) or a hex flag-like secret in any of them would hand out the answer.
test('no player-visible text (catalogue, shop views, challenge notes) holds a flag-shaped value', () => {
  const root = path.resolve(DEFAULT_DIR, '..', '..');
  const shape = /VM\{[A-Za-z0-9_-]{6,}\}/;
  const files = [];
  const walk = (dir, exts) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'tests') walk(f, exts); } else if (exts.some((x) => e.name.endsWith(x))) files.push(f);
    }
  };
  walk(DEFAULT_DIR, ['.yaml']);
  walk(path.join(root, 'apps', 'shop', 'src', 'views'), ['.njk']);
  for (const dir of ['challenges', 'services/bot']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir), ['.md']);
  assert.ok(files.length >= 11, 'the scan found the catalogue');
  const hits = files.filter((f) => shape.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(hits, [], `flag-shaped value in: ${hits.join(', ')}`);
});