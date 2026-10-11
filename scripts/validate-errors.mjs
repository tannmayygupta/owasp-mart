// Validates the error contract (IF-8) in contracts/errors/:
// the registry (error-codes.yaml) against its schema and the rules a schema cannot express (codes sorted and
// unique, family listed, status 4xx or 5xx or null, titles generic: no placeholder, no flag-like text),
// the response-body schema (problem.schema.json) and every example body (valid ones pass the schema and the
// registry, each invalid one fails at the expected path). Node, Ajv and js-yaml only.
// Usage: node scripts/validate-errors.mjs [--dir <contracts/errors folder>] [--help]
// Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIR = path.join(ROOT, 'contracts', 'errors');
export const REGISTRY_FILE = 'error-codes.yaml';
export const TYPE_PREFIX = 'urn:vulnmart:error:';
export const HELP = `Validate the error contract (IF-8)
Usage: node scripts/validate-errors.mjs [--dir <contracts/errors folder>] [--help]
Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.`;

const FLAG_LIKE = /VM\{[A-Z2-7]{24}\}/;
const PLACEHOLDER = /[{}$%<>]/;
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

// Path of the thing a validation error is about (JSON Pointer).
export function errorPath(e) {
  let p = e.instancePath || '';
  if (e.params && e.params.missingProperty !== undefined) p += '/' + esc(e.params.missingProperty);
  else if (e.params && e.params.additionalProperty !== undefined) p += '/' + esc(e.params.additionalProperty);
  else if (e.propertyName !== undefined) p += '/' + esc(e.propertyName);
  return p;
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadRegistry(dir) {
  return yaml.load(fs.readFileSync(path.join(dir, REGISTRY_FILE), 'utf8'));
}

export function makeAjv() {
  return new Ajv2020({ allErrors: true, strict: true });
}

// ---- rules a JSON Schema cannot express ----
export function semanticRegistry(reg) {
  const out = [];
  const add = (p, m) => out.push({ path: p, message: m });
  const families = new Set(Object.keys(reg.families || {}));
  const seen = new Set();
  const exitCodes = new Map();
  let previous = '';
  (reg.codes || []).forEach((c, i) => {
    const base = `/codes/${i}`;
    if (seen.has(c.code)) add(`${base}/code`, `duplicate code ${c.code}`);
    seen.add(c.code);
    if (previous && c.code < previous) add(`${base}/code`, `codes must be sorted: ${c.code} comes after ${previous}`);
    previous = c.code;
    const family = String(c.code).split('-')[0];
    if (!families.has(family)) add(`${base}/code`, `family ${family} is not listed under families`);
    if (typeof c.title === 'string') {
      if (PLACEHOLDER.test(c.title)) add(`${base}/title`, 'a title is a fixed text: no placeholder characters ({ } $ % < >)');
      if (FLAG_LIKE.test(c.title)) add(`${base}/title`, 'a title must not contain a flag-like value');
      if (/[^\x20-\x7E]/.test(c.title)) add(`${base}/title`, 'a title is printable ASCII (the generated Python and TypeScript literals assume it)');
    }
    if (c.exit_code !== undefined) {
      if (!String(c.code).startsWith('INST-INJECT-')) add(`${base}/exit_code`, 'exit_code belongs to the INST-INJECT-* codes only');
      if (c.status !== null) add(`${base}/exit_code`, 'an exit code belongs to a code that is never an HTTP answer (status null)');
      if (exitCodes.has(c.exit_code)) add(`${base}/exit_code`, `exit code ${c.exit_code} is already used by ${exitCodes.get(c.exit_code)}`);
      exitCodes.set(c.exit_code, c.code);
    }
  });
  return out;
}

// Does a body that passed the schema agree with the registry?
export function semanticBody(body, reg) {
  const out = [];
  const add = (p, m) => out.push({ path: p, message: m });
  const entry = (reg.codes || []).find((c) => c.code === body.code);
  if (!entry) {
    add('/code', `code ${body.code} is not in the registry`);
    return out;
  }
  if (body.type !== TYPE_PREFIX + entry.code) add('/type', `type must be ${TYPE_PREFIX}${entry.code}`);
  if (entry.status === null) add('/code', `${entry.code} is never sent as an HTTP answer (status null)`);
  else if (body.status !== entry.status) add('/status', `status must be ${entry.status} for ${entry.code}`);
  if (body.title !== entry.title) add('/title', 'title must equal the registry title');
  if (body.errors !== undefined && body.status !== 422) add('/errors', 'errors is only for a 422');
  if (body.field !== undefined && body.status !== 422) add('/field', 'field is only for a 422');
  if (body.field !== undefined && body.errors !== undefined) add('/field', 'field and errors are exclusive');
  return out;
}

const fmt = (list) => list.map((e) => `${e.path || '(root)'}: ${e.message}`);

// Runs every check and returns { problems: string[], counts }.
export function validateDir(dir) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const counts = { codes: 0, valid: 0, invalid: 0 };
  const ajv = makeAjv();
  let regSchema;
  let problemSchema;
  try {
    regSchema = ajv.compile(loadJson(path.join(dir, 'error-codes.schema.json')));
    problemSchema = ajv.compile(loadJson(path.join(dir, 'problem.schema.json')));
  } catch (e) {
    return { problems: [`schema does not compile: ${e.message}`], counts };
  }
  let reg;
  try {
    reg = loadRegistry(dir);
  } catch (e) {
    return { problems: [`${REGISTRY_FILE} cannot be read: ${e.message}`], counts };
  }
  if (!regSchema(reg)) {
    for (const e of regSchema.errors) fail(`${REGISTRY_FILE} ${errorPath(e)}: ${e.message}`);
    return { problems, counts };
  }
  counts.codes = reg.codes.length;
  for (const m of fmt(semanticRegistry(reg))) fail(`${REGISTRY_FILE} ${m}`);

  // valid examples: schema and registry
  const validDir = path.join(dir, 'examples', 'valid');
  for (const f of fs.existsSync(validDir) ? fs.readdirSync(validDir).sort() : []) {
    if (IGNORED.has(f)) continue;
    let body;
    try {
      body = loadJson(path.join(validDir, f));
    } catch (e) {
      fail(`examples/valid/${f} is not valid JSON: ${e.message}`);
      continue;
    }
    counts.valid++;
    if (!problemSchema(body)) {
      for (const e of problemSchema.errors) fail(`examples/valid/${f} ${errorPath(e)}: ${e.message}`);
      continue;
    }
    for (const m of fmt(semanticBody(body, reg))) fail(`examples/valid/${f} ${m}`);
  }
  if (counts.valid === 0) fail('examples/valid has no examples');

  // invalid examples: each fails at the expected path and stage
  const invDir = path.join(dir, 'examples', 'invalid');
  let manifest = {};
  try {
    manifest = loadJson(path.join(invDir, 'manifest.json'));
  } catch (e) {
    fail(`examples/invalid/manifest.json cannot be read: ${e.message}`);
  }
  const files = fs.existsSync(invDir) ? fs.readdirSync(invDir).filter((f) => f !== 'manifest.json' && !IGNORED.has(f)).sort() : [];
  for (const f of files) if (!manifest[f]) fail(`examples/invalid/${f} is not in manifest.json`);
  for (const [f, exp] of Object.entries(manifest)) {
    const file = path.join(invDir, f);
    if (!fs.existsSync(file)) { fail(`manifest.json names ${f}, which does not exist`); continue; }
    counts.invalid++;
    if (!['schema', 'registry'].includes(exp.stage) || typeof exp.path !== 'string') { fail(`manifest.json ${f}: stage must be "schema" or "registry" and path a string`); continue; }
    let body;
    try {
      body = loadJson(file);
    } catch (e) {
      fail(`examples/invalid/${f} is not valid JSON: ${e.message}`);
      continue;
    }
    const schemaOk = problemSchema(body);
    let found;
    if (exp.stage === 'registry') {
      if (!schemaOk) { fail(`examples/invalid/${f} should pass the schema and fail the registry check, but fails the schema at ${problemSchema.errors.map(errorPath).join(', ')}`); continue; }
      found = semanticBody(body, reg).map((e) => e.path);
    } else {
      if (schemaOk) { fail(`examples/invalid/${f} should fail the schema but passes it`); continue; }
      found = problemSchema.errors.map(errorPath);
    }
    if (!found.includes(exp.path)) fail(`examples/invalid/${f} should fail at ${exp.path} but fails at ${found.join(', ') || 'nowhere'}`);
  }
  return { problems, counts };
}

export function main(argv = process.argv.slice(2), { log = console.log, err = console.error } = {}) {
  let dir = DEFAULT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { log(HELP); return 0; }
    if (argv[i] === '--dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { err('--dir needs a folder.'); return 2; }
      dir = path.resolve(argv[++i]);
      continue;
    }
    err(`Unknown argument "${argv[i]}". Run with --help.`);
    return 2;
  }
  if (!fs.existsSync(dir)) { err(`Folder not found: ${dir}`); return 1; }
  const { problems, counts } = validateDir(dir);
  if (problems.length) {
    err(`FAIL: ${problems.length} problem(s)`);
    for (const p of problems) err(`  - ${p}`);
    return 1;
  }
  log(`OK: ${counts.codes} codes, ${counts.valid} valid and ${counts.invalid} invalid example bodies.`);
  return 0;
}

if (import.meta.main) process.exit(main());
