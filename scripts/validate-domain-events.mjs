// Validates the domain event contract (IF-3) in contracts/domain-events/:
// the schema compiles; the audience table covers every type and keeps learner practice away from a company (D-05);
// the state vocabularies and id shapes equal those of the lab API (IF-2) and the orchestrator API (IF-5);
// every valid example passes, each invalid one fails at its expected path and stage; the fixtures validate, go to
// exactly the audiences the table names, keep one user and one company per attempt and run in time order;
// no flag-like value, byte order mark, or secret-named member is in the contract. Node, Ajv and js-yaml only.
// Usage: node scripts/validate-domain-events.mjs [--dir <contracts/domain-events folder>] [--help]
// Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIR = path.join(ROOT, 'contracts', 'domain-events');
export const SCHEMA_FILE = 'domain-events.schema.json';
export const AUDIENCES_FILE = 'audiences.json';
export const FIXTURE_FILE = path.join('fixtures', 'session.json');
export const LAB_API = path.join(ROOT, 'contracts', 'api', 'lab', 'lab.openapi.yaml');
export const ORCH_API = path.join(ROOT, 'contracts', 'orchestrator', 'orchestrator.openapi.yaml');
export const ERROR_REGISTRY = path.join(ROOT, 'contracts', 'errors', 'error-codes.yaml');
export const HELP = `Validate the domain event contract (IF-3)
Usage: node scripts/validate-domain-events.mjs [--dir <contracts/domain-events folder>] [--help]
Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.`;

const FLAG_LIKE = /VM\{[A-Z2-7]{24}\}/;
const BOM = '﻿';
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
const AUDIENCE_STRING = /^(?:(user|org):[A-Za-z0-9-]{1,64}|admin)$/;
// Member names an event must never have: a flag, a secret, or personal data (privacy wall, FR-FLG-05, FR-HNT-01).
const FORBIDDEN_MEMBERS = ['flag', 'flags', 'flag_digest', 'digest', 'seed', 'key', 'event_key', 'owner_hash', 'password', 'secret', 'token', 'text', 'email', 'name', 'host', 'hostname', 'ip', 'user_id', 'org_id'];
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

export function errorPath(e) {
  let p = e.instancePath || '';
  if (e.params && e.params.missingProperty !== undefined) p += '/' + esc(e.params.missingProperty);
  else if (e.params && e.params.additionalProperty !== undefined) p += '/' + esc(e.params.additionalProperty);
  else if (e.propertyName !== undefined) p += '/' + esc(e.propertyName);
  return p;
}

export const loadJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const makeAjv = () => addFormats(new Ajv2020({ allErrors: true, strict: true }));

// Which audience kinds receive an event: the table row for its mode (an event with no mode, an instance event, has the same row for both).
export function audienceKinds(event, table) {
  const row = table?.types?.[event.type];
  if (!row) return null;
  const mode = event.data && event.data.mode;
  return mode ? row[mode] ?? null : row.learner;
}

// ---- rules a JSON Schema cannot express ----
export function semanticEvent(event, registryCodes) {
  const out = [];
  if (event.type === 'instance.state_changed') {
    const d = event.data;
    if (d.state === 'failed' && d.error_code === null) out.push({ path: '/data/error_code', message: 'a failed instance names its INST-* code' });
    if (d.state !== 'failed' && d.error_code !== null) out.push({ path: '/data/error_code', message: 'error_code is null unless the state is failed' });
    if (typeof d.error_code === 'string' && registryCodes && !registryCodes.has(d.error_code)) out.push({ path: '/data/error_code', message: `${d.error_code} is not in the error registry (IF-8)` });
  }
  if (event.type === 'attempt.score_updated') {
    const keys = event.data.per_challenge.map((r) => r.challenge_key);
    if (new Set(keys).size !== keys.length) out.push({ path: '/data/per_challenge', message: 'one row per challenge' });
  }
  return out;
}

export function semanticAudiences(table, schemaTypes, schemaModes = null) {
  const out = [];
  const add = (p, m) => out.push({ path: p, message: m });
  if (!table || !Array.isArray(table.audiences) || !Array.isArray(table.modes) || !table.types || typeof table.types !== 'object') return [{ path: '', message: 'audiences, modes and types are required' }];
  if (schemaModes && JSON.stringify([...table.modes].sort()) !== JSON.stringify([...schemaModes].sort())) add('/modes', `modes must equal the schema's Mode: ${schemaModes.join(', ')}`);
  const kinds = new Set(table.audiences || []);
  const control = new Set(table.control || []);
  for (const t of schemaTypes) {
    if (control.has(t)) { if (table.types[t]) add(`/types/${esc(t)}`, 'a control event has no audience row'); continue; }
    const row = table.types[t];
    if (!row) { add(`/types/${esc(t)}`, 'every event type needs an audience row'); continue; }
    for (const mode of table.modes) {
      const list = row[mode];
      if (!Array.isArray(list) || !list.length) { add(`/types/${esc(t)}/${mode}`, 'a mode needs at least one audience'); continue; }
      if (new Set(list).size !== list.length) add(`/types/${esc(t)}/${mode}`, 'an audience is listed once');
      for (const k of list) if (!kinds.has(k)) add(`/types/${esc(t)}/${mode}`, `unknown audience ${k}`);
    }
    // Privacy wall (D-05): learner practice never reaches a company.
    if ((row.learner || []).includes('org')) add(`/types/${esc(t)}/learner`, 'learner practice never goes to an org (D-05)');
    // An instance event has no mode, so both rows must be the same.
    if (t === 'instance.state_changed' && JSON.stringify(row.learner) !== JSON.stringify(row.candidate)) add(`/types/${esc(t)}`, 'an instance event has no mode: the learner and candidate rows must be equal');
  }
  for (const t of Object.keys(table.types)) if (!schemaTypes.includes(t)) add(`/types/${esc(t)}`, 'audience row for a type that is not in the schema');
  for (const t of control) if (!schemaTypes.includes(t)) add('/control', `${t} is not in the schema`);
  return out;
}

// Vocabulary drift against IF-2 and IF-5: the same values in the same order is not required, the same set is.
export function vocabularyDrift(defs, lab, orch) {
  const out = [];
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const check = (name, mine, other, where) => {
    if (!other) out.push({ path: `/$defs/${name}`, message: `${where} has no ${name}` });
    else if (!same(mine, other)) out.push({ path: `/$defs/${name}`, message: `${name} differs from ${where}: ${JSON.stringify(mine)} versus ${JSON.stringify(other)}` });
  };
  const pairs = [['State', 'State'], ['Access', 'Access'], ['Health', 'Health']];
  for (const [mine, theirs] of pairs) {
    check(mine, defs[mine].enum, lab[theirs]?.enum, 'IF-2');
    check(mine, defs[mine].enum, orch[theirs]?.enum, 'IF-5');
  }
  check('AttemptState', defs.AttemptState.enum, lab.AttemptState?.enum, 'IF-2');
  check('Mode', defs.Mode.enum, lab.AttemptMode?.enum, 'IF-2');
  check('Milestone', defs.Milestone.enum, lab.Milestone?.enum, 'IF-2');
  for (const name of ['InstanceId', 'AttemptId', 'ChallengeKey', 'Timestamp']) {
    if (lab[name]?.pattern !== defs[name].pattern) out.push({ path: `/$defs/${name}`, message: `${name} pattern differs from IF-2: ${defs[name].pattern} versus ${lab[name]?.pattern}` });
  }
  if (orch.InstanceId?.pattern !== defs.InstanceId.pattern) out.push({ path: '/$defs/InstanceId', message: `InstanceId pattern differs from IF-5: ${defs.InstanceId.pattern} versus ${orch.InstanceId?.pattern}` });
  return out;
}

// Records of the fixture file: shape, audiences exactly as the table says, one user and one company per attempt, time order.
export function checkFixture(fixture, validateEvent, table, registryCodes) {
  const out = [];
  const add = (p, m) => out.push({ path: p, message: m });
  if (!fixture || !Array.isArray(fixture.records) || !fixture.records.length) return [{ path: '/records', message: 'records must be a non-empty array' }];
  const owner = new Map();
  const modes = new Map();
  const states = new Map();
  const epochs = new Map();
  let last = '';
  fixture.records.forEach((r, i) => {
    const base = `/records/${i}`;
    if (!r || typeof r !== 'object' || !Array.isArray(r.audiences) || typeof r.event !== 'object') { add(base, 'a record is { audiences, event }'); return; }
    if (!validateEvent(r.event)) { for (const e of validateEvent.errors) add(`${base}/event${errorPath(e)}`, e.message); return; }
    for (const m of semanticEvent(r.event, registryCodes)) add(`${base}/event${m.path}`, m.message);
    if (r.event.type === 'stream.resync') { add(`${base}/event/type`, 'a control event is never published to an audience'); return; }
    const bad = r.audiences.filter((a) => typeof a !== 'string' || !AUDIENCE_STRING.test(a));
    if (bad.length) { add(`${base}/audiences`, `not an audience (user:<id>, org:<id> or admin): ${bad.join(', ')}`); return; }
    const want = audienceKinds(r.event, table);
    if (!want) { add(`${base}/event/type`, `no audience row for ${r.event.type} (${r.event.data.mode ?? 'any mode'})`); return; }
    const got = r.audiences.map((a) => a.split(':')[0]);
    if (new Set(got).size !== got.length) add(`${base}/audiences`, 'an audience kind appears once');
    if (JSON.stringify([...got].sort()) !== JSON.stringify([...want].sort())) add(`${base}/audiences`, `${r.event.type} (${r.event.data.mode ?? 'any mode'}) goes to ${want.join(', ')} and not to ${got.join(', ')}`);
    const attempt = r.event.data.attempt_id;
    if (r.event.data.mode) {
      if (modes.has(attempt) && modes.get(attempt) !== r.event.data.mode) add(`${base}/event/data/mode`, `attempt ${attempt} is ${modes.get(attempt)} in an earlier record and ${r.event.data.mode} here`);
      modes.set(attempt, r.event.data.mode);
    }
    if (r.event.type === 'attempt.state_changed') {
      const d = r.event.data;
      if (d.previous_state === d.state) add(`${base}/event/data/previous_state`, 'previous_state differs from state');
      if (states.has(attempt) && d.previous_state !== states.get(attempt)) add(`${base}/event/data/previous_state`, `previous_state is ${d.previous_state} but the attempt was ${states.get(attempt)}`);
      states.set(attempt, d.state);
    }
    if (r.event.type === 'instance.state_changed') {
      const d = r.event.data;
      if (epochs.has(d.instance_id) && d.epoch < epochs.get(d.instance_id)) add(`${base}/event/data/epoch`, `epoch goes back from ${epochs.get(d.instance_id)} to ${d.epoch}`);
      epochs.set(d.instance_id, d.epoch);
    }
    for (const a of r.audiences.filter((x) => x !== 'admin')) {
      const kind = a.split(':')[0];
      const key = `${attempt}|${kind}`;
      if (owner.has(key) && owner.get(key) !== a) add(`${base}/audiences`, `attempt ${attempt} has ${owner.get(key)} and ${a} as its ${kind}`);
      owner.set(key, a);
    }
    if (last && r.event.occurred_at < last) add(`${base}/event/occurred_at`, 'records run in time order');
    last = r.event.occurred_at;
  });
  return out;
}

const fmt = (list) => list.map((e) => `${e.path || '(root)'}: ${e.message}`);

function scanFolder(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (IGNORED.has(ent.name)) continue;
    const r = path.join(rel, ent.name);
    if (ent.isDirectory()) { out.push(...scanFolder(dir, r)); continue; }
    const text = fs.readFileSync(path.join(dir, r), 'utf8');
    const name = r.replace(/\\/g, '/');
    if (text.startsWith(BOM)) out.push(`${name}: byte order mark`);
    if (FLAG_LIKE.test(text)) out.push(`${name}: a flag-like value`);
  }
  return out;
}

function memberNames(node, out = new Set()) {
  if (node && typeof node === 'object') {
    if (node.properties && typeof node.properties === 'object') for (const k of Object.keys(node.properties)) out.add(k);
    for (const v of Object.values(node)) memberNames(v, out);
  }
  return out;
}

export function validateDir(dir, { lab = LAB_API, orch = ORCH_API, registry = ERROR_REGISTRY } = {}) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const counts = { types: 0, valid: 0, invalid: 0, records: 0 };
  const ajv = makeAjv();
  let schemaJson;
  let validateEvent;
  try {
    schemaJson = loadJson(path.join(dir, SCHEMA_FILE));
    validateEvent = ajv.compile(schemaJson);
  } catch (e) {
    return { problems: [`${SCHEMA_FILE} does not compile: ${e.message}`], counts };
  }
  const schemaTypes = schemaJson?.properties?.type?.enum;
  if (!Array.isArray(schemaTypes)) return { problems: [`${SCHEMA_FILE}: properties.type.enum is missing`], counts };
  counts.types = schemaTypes.length;

  let table;
  try { table = loadJson(path.join(dir, AUDIENCES_FILE)); } catch (e) { return { problems: [`${AUDIENCES_FILE} cannot be read: ${e.message}`], counts }; }
  for (const m of fmt(semanticAudiences(table, schemaTypes, schemaJson.$defs?.Mode?.enum))) fail(`${AUDIENCES_FILE} ${m}`);
  // Without a usable table the fixtures and examples cannot be judged: report and stop rather than crash.
  if (!table || Array.isArray(table) || !table.types || typeof table.types !== 'object' || !Array.isArray(table.modes)) return { problems, counts };

  // forbidden members and secrets anywhere in the contract folder
  for (const k of memberNames(schemaJson)) if (FORBIDDEN_MEMBERS.includes(k)) fail(`${SCHEMA_FILE}: a member named "${k}" is not allowed in an event (privacy wall)`);
  try { for (const m of scanFolder(dir)) fail(m); } catch (e) { fail(`scan failed: ${e.message}`); }

  // vocabularies against IF-2 and IF-5
  try {
    const l = yaml.load(fs.readFileSync(lab, 'utf8')).components.schemas;
    const o = yaml.load(fs.readFileSync(orch, 'utf8')).components.schemas;
    for (const m of fmt(vocabularyDrift(schemaJson.$defs, l, o))) fail(`${SCHEMA_FILE} ${m}`);
  } catch (e) { fail(`the IF-2 or IF-5 file cannot be read: ${e.message}`); }

  let registryCodes = null;
  try { registryCodes = new Set(yaml.load(fs.readFileSync(registry, 'utf8')).codes.map((c) => c.code)); } catch (e) { fail(`the error registry (IF-8) cannot be read: ${e.message}`); }

  // valid examples
  const validDir = path.join(dir, 'examples', 'valid');
  for (const f of fs.existsSync(validDir) ? fs.readdirSync(validDir).sort() : []) {
    if (IGNORED.has(f)) continue;
    let body;
    try { body = loadJson(path.join(validDir, f)); } catch (e) { fail(`examples/valid/${f} is not valid JSON: ${e.message}`); continue; }
    counts.valid++;
    if (!validateEvent(body)) { for (const e of validateEvent.errors) fail(`examples/valid/${f} ${errorPath(e)}: ${e.message}`); continue; }
    for (const m of fmt(semanticEvent(body, registryCodes))) fail(`examples/valid/${f} ${m}`);
  }
  const seenTypes = new Set();
  for (const f of fs.existsSync(validDir) ? fs.readdirSync(validDir).filter((x) => !IGNORED.has(x)) : []) { try { seenTypes.add(loadJson(path.join(validDir, f)).type); } catch { /* reported above */ } }
  for (const t of schemaTypes) if (!seenTypes.has(t)) fail(`examples/valid has no example of ${t}`);

  // invalid examples
  const invDir = path.join(dir, 'examples', 'invalid');
  let manifest = {};
  try { manifest = loadJson(path.join(invDir, 'manifest.json')); } catch (e) { fail(`examples/invalid/manifest.json cannot be read: ${e.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { fail('examples/invalid/manifest.json must be an object keyed by file name'); manifest = {}; }
  const files = fs.existsSync(invDir) ? fs.readdirSync(invDir).filter((f) => f !== 'manifest.json' && !IGNORED.has(f)).sort() : [];
  for (const f of files) if (!manifest[f]) fail(`examples/invalid/${f} is not in manifest.json`);
  for (const [f, exp] of Object.entries(manifest)) {
    const file = path.join(invDir, f);
    if (!exp || typeof exp !== 'object') { fail(`manifest.json ${f}: the entry must be { path, rule, stage }`); continue; }
    if (!fs.existsSync(file)) { fail(`manifest.json names ${f}, which does not exist`); continue; }
    counts.invalid++;
    if (!['schema', 'semantic'].includes(exp.stage) || typeof exp.path !== 'string') { fail(`manifest.json ${f}: stage must be "schema" or "semantic" and path a string`); continue; }
    let body;
    try { body = loadJson(file); } catch (e) { fail(`examples/invalid/${f} is not valid JSON: ${e.message}`); continue; }
    const schemaOk = validateEvent(body);
    let found;
    if (exp.stage === 'semantic') {
      if (!schemaOk) { fail(`examples/invalid/${f} should pass the schema and fail a rule, but fails the schema at ${validateEvent.errors.map(errorPath).join(', ')}`); continue; }
      found = semanticEvent(body, registryCodes).map((e) => e.path);
    } else {
      if (schemaOk) { fail(`examples/invalid/${f} should fail the schema but passes it`); continue; }
      found = validateEvent.errors.map(errorPath);
    }
    if (!found.includes(exp.path)) fail(`examples/invalid/${f} should fail at ${exp.path} but fails at ${found.join(', ') || 'nowhere'}`);
  }

  // fixtures
  let fixture;
  try { fixture = loadJson(path.join(dir, FIXTURE_FILE)); } catch (e) { fail(`${FIXTURE_FILE} cannot be read: ${e.message}`); return { problems, counts }; }
  counts.records = Array.isArray(fixture.records) ? fixture.records.length : 0;
  for (const m of fmt(checkFixture(fixture, validateEvent, table, registryCodes))) fail(`${FIXTURE_FILE} ${m}`);
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
  log(`OK: ${counts.types} event types, ${counts.valid} valid and ${counts.invalid} invalid example events, ${counts.records} fixture records.`);
  return 0;
}

if (import.meta.main) process.exit(main());
