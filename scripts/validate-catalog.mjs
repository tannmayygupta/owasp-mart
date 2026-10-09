// Validates the challenge catalogue (IF-7) in challenges/catalog/ against
// contracts/catalog/challenge.schema.json: the schema compiles, every stub
// validates, and the semantic rules a JSON Schema cannot express hold
// (tier matches difficulty, key matches filename, exactly 11 entries c01..c11,
// no real-looking flag value). Node, Ajv and js-yaml only.
// Usage: node scripts/validate-catalog.mjs [--dir <challenges/catalog folder>] [--schema <path>] [--help]
// Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIR = path.join(ROOT, 'challenges', 'catalog');
export const DEFAULT_SCHEMA = path.join(ROOT, 'contracts', 'catalog', 'challenge.schema.json');
export const EXPECTED_KEYS = Array.from({ length: 11 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
// A real flag is VM{ + 24 Base32 chars }. Stubs must never contain one.
const FLAG_LIKE = /VM\{[A-Z2-7]{24}\}/;

export const HELP = `Validate the challenge catalogue (IF-7)
Usage: node scripts/validate-catalog.mjs [--dir <folder>] [--schema <path>] [--help]
Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.`;

export function tierForDifficulty(d) {
  if (d <= 2) return 'Easy';
  if (d === 3) return 'Medium';
  return 'Hard';
}

// Collect problems for one parsed entry given its filename stem. Returns string[].
export function semanticProblems(entry, stem, rawText) {
  const problems = [];
  if (entry.key !== stem) problems.push(`key "${entry.key}" does not match filename "${stem}"`);
  const want = tierForDifficulty(entry.difficulty);
  if (entry.tier !== want) {
    problems.push(`tier "${entry.tier}" does not match difficulty ${entry.difficulty} (expected "${want}")`);
  }
  // The exploit-test and fixed-build paths must point at this challenge's own key.
  if (entry.exploit_test && !entry.exploit_test.endsWith(`/${entry.key}`)) {
    problems.push(`exploit_test "${entry.exploit_test}" does not end with the key "${entry.key}"`);
  }
  if (entry.fixed_build && !entry.fixed_build.endsWith(`/${entry.key}`)) {
    problems.push(`fixed_build "${entry.fixed_build}" does not end with the key "${entry.key}"`);
  }
  // A flag delivered through the environment needs a written reason (FR-FLG-03).
  if (entry.flag?.delivery === 'env' && !entry.flag?.reason) {
    problems.push('flag.delivery is "env" but flag.reason is missing (FR-FLG-03)');
  }
  if (FLAG_LIKE.test(rawText)) problems.push('contains a real-looking flag value (VM{...})');
  return problems;
}

// Human-readable location for an Ajv error, including the property name that
// additionalProperties/required/propertyNames errors carry in params.
export function formatAjvError(e) {
  let where = e.instancePath || '/';
  if (e.params?.additionalProperty !== undefined) where += `/${e.params.additionalProperty}`;
  else if (e.params?.missingProperty !== undefined) where += `/${e.params.missingProperty}`;
  return `${where} ${e.message}`;
}

// Run all checks. Returns { ok, errors: string[] }. Pure except for reading files.
export function validateCatalog({ dir = DEFAULT_DIR, schemaPath = DEFAULT_SCHEMA } = {}) {
  const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let validate;
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    validate = ajv.compile(schema);
  } catch (e) {
    return { ok: false, errors: [`cannot load schema ${schemaPath}: ${e.message}`] };
  }

  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => !IGNORED.has(f) && f.endsWith('.yaml'))
      .sort();
  } catch (e) {
    return { ok: false, errors: [`cannot read catalogue directory ${dir}: ${e.message}`] };
  }
  const stems = files.map((f) => path.basename(f, '.yaml'));

  // Exactly the 11 expected entries, no more, no fewer.
  const missing = EXPECTED_KEYS.filter((k) => !stems.includes(k));
  const extra = stems.filter((k) => !EXPECTED_KEYS.includes(k));
  if (missing.length) errors.push(`missing challenge files: ${missing.join(', ')}`);
  if (extra.length) errors.push(`unexpected challenge files: ${extra.join(', ')}`);

  for (const file of files) {
    const stem = path.basename(file, '.yaml');
    let rawText;
    try {
      rawText = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (e) {
      errors.push(`${file}: cannot read file: ${e.message}`);
      continue;
    }
    let entry;
    try {
      entry = yaml.load(rawText);
    } catch (e) {
      errors.push(`${file}: YAML parse error: ${e.message}`);
      continue;
    }
    if (!validate(entry)) {
      for (const e of validate.errors) {
        errors.push(`${file}: ${formatAjvError(e)}`);
      }
      continue; // schema-invalid entries skip semantic checks
    }
    for (const p of semanticProblems(entry, stem, rawText)) errors.push(`${file}: ${p}`);
  }

  return { ok: errors.length === 0, errors };
}

export function main(argv) {
  let dir = DEFAULT_DIR;
  let schemaPath = DEFAULT_SCHEMA;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(HELP);
      return 0;
    }
    if (argv[i] === '--dir' || argv[i] === '--schema') {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`${argv[i - 1]} requires a value\n${HELP}`);
        return 2;
      }
      if (argv[i - 1] === '--dir') dir = path.resolve(value);
      else schemaPath = path.resolve(value);
    } else {
      console.error(`Unknown argument: ${argv[i]}\n${HELP}`);
      return 2;
    }
  }
  const { ok, errors } = validateCatalog({ dir, schemaPath });
  if (ok) {
    console.log(`OK: all ${EXPECTED_KEYS.length} catalogue stubs validate against ${path.relative(ROOT, schemaPath)}.`);
    return 0;
  }
  console.error('Catalogue validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
