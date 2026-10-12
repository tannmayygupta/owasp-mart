import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUDIENCES_FILE, DEFAULT_DIR, ERROR_REGISTRY, FIXTURE_FILE, LAB_API, ORCH_API, SCHEMA_FILE, audienceKinds, errorPath, loadJson, main, semanticAudiences, semanticEvent, validateDir } from './validate-domain-events.mjs';

const copyDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'if3-'));
  fs.cpSync(DEFAULT_DIR, dir, { recursive: true });
  return dir;
};
const edit = (dir, file, fn) => {
  const p = path.join(dir, file);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};
const editJson = (dir, file, fn) => edit(dir, file, (t) => { const o = JSON.parse(t); fn(o); return JSON.stringify(o, null, 2) + '\n'; });
const problemsOf = (dir, opts) => validateDir(dir, opts).problems.join('\n');
const FLAG = 'VM{' + 'A'.repeat(24) + '}'; // built here so no flag-like literal sits in this file
const find = (records, type, mode) => {
  const i = records.findIndex((r) => r.event.type === type && (!mode || r.event.data.mode === mode));
  assert.ok(i >= 0, `no ${type} ${mode ?? ''} record in the fixtures`);
  return i;
};
// A replacement that must change the text: a no-op would make a drift test pass for the wrong reason.
const mustReplace = (text, from, to) => {
  const out = typeof from === 'string' ? text.replace(from, to) : text.replace(from, to);
  assert.notEqual(out, text, `the replacement of ${String(from).slice(0, 60)} changed nothing`);
  return out;
};

test('the committed contract is valid and every type, example and record is counted', () => {
  const r = validateDir(DEFAULT_DIR);
  assert.deepEqual(r.problems, []);
  const count = (sub) => fs.readdirSync(path.join(DEFAULT_DIR, 'examples', sub)).filter((f) => f.endsWith('.json') && f !== 'manifest.json').length;
  assert.equal(r.counts.types, loadJson(path.join(DEFAULT_DIR, SCHEMA_FILE)).properties.type.enum.length);
  assert.equal(r.counts.valid, count('valid'));
  assert.equal(r.counts.invalid, count('invalid'));
  assert.equal(r.counts.records, loadJson(path.join(DEFAULT_DIR, FIXTURE_FILE)).records.length);
  assert.ok(r.counts.types >= 7 && r.counts.records >= 18);
});

test('audiences: learner practice never reaches an org, a missing row, an unknown audience and a control row are rejected', () => {
  const dir = copyDir();
  editJson(dir, AUDIENCES_FILE, (t) => { t.types['attempt.flag_captured'].learner = ['user', 'org']; });
  assert.match(problemsOf(dir), /learner practice never goes to an org/);
  const d2 = copyDir();
  editJson(d2, AUDIENCES_FILE, (t) => { delete t.types['attempt.score_updated']; });
  assert.match(problemsOf(d2), /every event type needs an audience row/);
  const d3 = copyDir();
  editJson(d3, AUDIENCES_FILE, (t) => { t.types['attempt.hint_unlocked'].candidate = ['user', 'teacher']; });
  assert.match(problemsOf(d3), /unknown audience teacher/);
  const d4 = copyDir();
  editJson(d4, AUDIENCES_FILE, (t) => { t.types['stream.resync'] = { learner: ['user'], candidate: ['user'] }; });
  assert.match(problemsOf(d4), /control event has no audience row/);
  const d5 = copyDir();
  editJson(d5, AUDIENCES_FILE, (t) => { t.types['instance.state_changed'].candidate = ['user']; });
  assert.match(problemsOf(d5), /learner and candidate rows must be equal/);
  const d6 = copyDir();
  editJson(d6, AUDIENCES_FILE, (t) => { t.types['attempt.exploded'] = { learner: ['user'], candidate: ['user'] }; });
  assert.match(problemsOf(d6), /audience row for a type that is not in the schema/);
});

test('audienceKinds reads the row of the event mode; an instance event has the same row for both', () => {
  const table = loadJson(path.join(DEFAULT_DIR, AUDIENCES_FILE));
  assert.deepEqual(audienceKinds({ type: 'attempt.score_updated', data: { mode: 'candidate' } }, table), ['org']);
  assert.deepEqual(audienceKinds({ type: 'attempt.score_updated', data: { mode: 'learner' } }, table), ['user']);
  assert.deepEqual(audienceKinds({ type: 'instance.state_changed', data: {} }, table), ['user', 'admin']);
  assert.equal(audienceKinds({ type: 'nope', data: {} }, table), null);
  assert.deepEqual(semanticAudiences(table, loadJson(path.join(DEFAULT_DIR, SCHEMA_FILE)).properties.type.enum), []);
});

test('a member that could carry a secret, a flag or personal data is rejected in the schema', () => {
  for (const name of ['flag', 'owner_hash', 'email', 'host', 'user_id']) {
    const dir = copyDir();
    editJson(dir, SCHEMA_FILE, (s) => { s.$defs.AttemptFlagCaptured.properties[name] = { type: 'string' }; });
    assert.match(problemsOf(dir), new RegExp(`a member named "${name}" is not allowed`), name);
  }
});

test('a flag-like value or a byte order mark anywhere in the folder is rejected', () => {
  const d1 = copyDir();
  edit(d1, 'README.md', () => `The flag is ${FLAG}\n`);
  assert.match(problemsOf(d1), /README\.md: a flag-like value/);
  const d2 = copyDir();
  edit(d2, FIXTURE_FILE, (t) => '﻿' + t);
  assert.match(problemsOf(d2), /byte order mark/);
});

const labYaml = fs.readFileSync(LAB_API, 'utf8');
const orchYaml = fs.readFileSync(ORCH_API, 'utf8');
function drift(mutateLab, mutateOrch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'if3drift-'));
  const lab = path.join(tmp, 'lab.yaml');
  const orch = path.join(tmp, 'orch.yaml');
  fs.writeFileSync(lab, mutateLab ? mutateLab(labYaml) : labYaml);
  fs.writeFileSync(orch, mutateOrch ? mutateOrch(orchYaml) : orchYaml);
  return problemsOf(DEFAULT_DIR, { lab, orch });
}
// Replace the enum list of one schema in an OpenAPI file by a list with one value added or removed.
const enumOf = (yamlText, schema) => {
  const m = new RegExp(`\\n {4}${schema}:\\n(?:.*\\n)*?( {6}enum: \\[)([^\\]]*)\\]`).exec(yamlText);
  assert.ok(m, `no enum for ${schema}`);
  return { head: yamlText.slice(0, m.index + m[0].length - m[2].length - 1), list: m[2], tail: yamlText.slice(m.index + m[0].length) };
};
const withEnum = (yamlText, schema, change) => {
  const { head, list, tail } = enumOf(yamlText, schema);
  const items = list.split(',').map((s) => s.trim());
  return head + change(items).join(', ') + ']' + tail;
};

test('drift: every shared enum, in IF-2 and in IF-5, is compared (a value added or removed is reported)', () => {
  const cases = [
    ['State', 'lab', 'IF-2'], ['State', 'orch', 'IF-5'],
    ['Access', 'lab', 'IF-2'], ['Access', 'orch', 'IF-5'],
    ['Health', 'lab', 'IF-2'], ['Health', 'orch', 'IF-5'],
    ['AttemptState', 'lab', 'IF-2'], ['AttemptMode', 'lab', 'IF-2'], ['Milestone', 'lab', 'IF-2'],
  ];
  for (const [schema, which, label] of cases) {
    const mine = schema === 'AttemptMode' ? 'Mode' : schema;
    for (const [how, change] of [['added', (a) => [...a, 'zzz']], ['removed', (a) => a.slice(1)]]) {
      const out = which === 'lab' ? drift((y) => withEnum(y, schema, change)) : drift(null, (y) => withEnum(y, schema, change));
      assert.match(out, new RegExp(`${mine} differs from ${label}`), `${schema} ${how} in ${label}`);
    }
  }
});

test('drift: every shared id and timestamp pattern is compared', () => {
  const swap = (name, pattern) => (y) => mustReplace(y, new RegExp(`(\\n {4}${name}:\\n(?:.*\\n)*? {6}pattern: )'[^']*'`), (m, head) => `${head}'${pattern}'`);
  for (const name of ['InstanceId', 'AttemptId', 'ChallengeKey', 'Timestamp']) {
    assert.match(drift(swap(name, '^x$')), new RegExp(`${name} pattern differs from IF-2`), name);
  }
  assert.match(drift(null, swap('InstanceId', '^x$')), /InstanceId pattern differs from IF-5/);
  assert.match(drift(() => 'components:\n  schemas: {}\n', null), /IF-2 has no State/);
  assert.match(problemsOf(DEFAULT_DIR, { lab: path.join(os.tmpdir(), 'no-such-lab.yaml') }), /IF-2 or IF-5 file cannot be read/);
});

test('the error registry is the source of the INST codes: an unregistered code in a fixture or example is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'if3reg-'));
  const reg = path.join(tmp, 'codes.yaml');
  fs.writeFileSync(reg, fs.readFileSync(ERROR_REGISTRY, 'utf8').replace(/^ {2}- \{ code: INST-HEALTH-TIMEOUT.*$/m, ''));
  const out = problemsOf(DEFAULT_DIR, { registry: reg });
  assert.match(out, /INST-HEALTH-TIMEOUT is not in the error registry/);
  assert.match(out, new RegExp(FIXTURE_FILE.replace(/\\/g, '[\\\\/]')));
});

test('semanticEvent: failed needs a code, a code needs failed', () => {
  const base = { type: 'instance.state_changed', data: { state: 'failed', error_code: null } };
  assert.equal(semanticEvent(base, null)[0].path, '/data/error_code');
  assert.equal(semanticEvent({ type: 'instance.state_changed', data: { state: 'ready', error_code: 'INST-LOST' } }, null)[0].path, '/data/error_code');
  assert.deepEqual(semanticEvent({ type: 'attempt.flag_captured', data: {} }, null), []);
});

test('examples: an invalid one that passes, one failing at another path, one missing from the manifest, one without a file, a bad stage, broken JSON', () => {
  const d1 = copyDir();
  fs.copyFileSync(path.join(d1, 'examples', 'valid', 'instance-state-changed.json'), path.join(d1, 'examples', 'invalid', 'unknown-type.json'));
  assert.match(problemsOf(d1), /unknown-type\.json should fail the schema but passes it/);
  const d2 = copyDir();
  editJson(d2, 'examples/invalid/manifest.json', (m) => { m['unknown-type.json'].path = '/occurred_at'; });
  assert.match(problemsOf(d2), /unknown-type\.json should fail at \/occurred_at but fails at \/type/);
  const d3 = copyDir();
  fs.writeFileSync(path.join(d3, 'examples', 'invalid', 'extra.json'), '{}');
  fs.rmSync(path.join(d3, 'examples', 'invalid', 'hint-level-4.json'));
  assert.match(problemsOf(d3), /extra\.json is not in manifest\.json/);
  assert.match(problemsOf(d3), /names hint-level-4\.json, which does not exist/);
  const d4 = copyDir();
  editJson(d4, 'examples/invalid/manifest.json', (m) => { m['unknown-type.json'].stage = 'schemas'; });
  assert.match(problemsOf(d4), /stage must be "schema" or "semantic"/);
  const d5 = copyDir();
  fs.writeFileSync(path.join(d5, 'examples', 'valid', 'broken.json'), '{ not json');
  assert.match(problemsOf(d5), /broken\.json is not valid JSON/);
  const d6 = copyDir();
  fs.rmSync(path.join(d6, 'examples', 'valid', 'stream-resync.json'));
  assert.match(problemsOf(d6), /no example of stream\.resync/);
});

test('fixtures: wrong audiences, learner practice sent to an org, two users for one attempt, out of order, a control event, a bad audience string', () => {
  const rec = (dir, fn) => editJson(dir, FIXTURE_FILE, (f) => fn(f.records));
  const d1 = copyDir();
  rec(d1, (r) => { r[find(r, 'attempt.flag_captured', 'learner')].audiences = ['user:USR-LEARNER-1', 'org:ORG-ACME-1']; }); // a learner capture also sent to a company
  assert.match(problemsOf(d1), /attempt\.flag_captured \(learner\) goes to user and not to user, org/);
  const d2 = copyDir();
  rec(d2, (r) => { r[find(r, 'attempt.milestone_reached', 'learner')].audiences = ['user:USR-SOMEONE-ELSE']; }); // the learner's attempt now has another user
  assert.match(problemsOf(d2), /has user:USR-LEARNER-1 and user:USR-SOMEONE-ELSE as its user/);
  const d3 = copyDir();
  rec(d3, (r) => { const a = find(r, 'attempt.state_changed', 'learner'); [r[a], r[a + 1]] = [r[a + 1], r[a]]; });
  assert.match(problemsOf(d3), /records run in time order/);
  const d4 = copyDir();
  rec(d4, (r) => { r.push({ audiences: ['user:USR-LEARNER-1'], event: { schema_version: 1, type: 'stream.resync', occurred_at: '2026-10-11T12:00:00Z', data: { reason: 'buffer_reset' } } }); });
  assert.match(problemsOf(d4), /a control event is never published to an audience/);
  const d5 = copyDir();
  rec(d5, (r) => { r[0].audiences = ['user:USR LEARNER', 'admin']; });
  assert.match(problemsOf(d5), /not an audience/);
  const d6 = copyDir();
  rec(d6, (r) => { r[0].audiences = ['user:USR-LEARNER-1']; });
  assert.match(problemsOf(d6), /instance\.state_changed .* goes to user, admin and not to user/);
  const d7 = copyDir();
  rec(d7, (r) => { r[0].event.data.state = 'booting'; });
  assert.match(problemsOf(d7), /records\/0\/event\/data\/state/);
  const d8 = copyDir();
  fs.writeFileSync(path.join(d8, FIXTURE_FILE), '{ "records": [] }');
  assert.match(problemsOf(d8), /records must be a non-empty array/);
});

test('errorPath builds JSON Pointers', () => {
  assert.equal(errorPath({ instancePath: '/data', params: { missingProperty: 'mode' } }), '/data/mode');
  assert.equal(errorPath({ instancePath: '/data', params: { additionalProperty: 'host' } }), '/data/host');
});

test('CLI: --help exits 0, an unknown argument 2, --dir without a value 2, a missing folder 1, a good folder 0', () => {
  const out = [];
  const io = { log: (m) => out.push(m), err: () => {} };
  assert.equal(main(['--help'], io), 0);
  assert.equal(main(['--nope'], io), 2);
  assert.equal(main(['--dir'], io), 2);
  assert.equal(main(['--dir', path.join(os.tmpdir(), 'no-such-if3')], io), 1);
  assert.equal(main([], io), 0);
  assert.match(out.join('\n'), /OK: \d+ event types/);
});

test('the schema itself rejects a failed instance without a code and a code on a running one; a timestamp must be a real date', () => {
  const dir = copyDir();
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'examples', 'invalid', 'manifest.json'), 'utf8'));
  for (const n of ['failed-without-error-code.json', 'error-code-on-a-running-instance.json', 'timestamp-impossible-date.json', 'timestamp-impossible-hour.json']) {
    assert.equal(m[n].stage, 'schema', n);
  }
  assert.equal(validateDir(dir).problems.length, 0);
});

test('fixtures: one mode per attempt, previous_state follows the attempt, epoch never goes back', () => {
  const rec = (dir, fn) => editJson(dir, FIXTURE_FILE, (f) => fn(f.records));
  const d1 = copyDir();
  rec(d1, (r) => { r[find(r, 'attempt.hint_unlocked', 'learner')].event.data.mode = 'candidate'; });
  assert.match(problemsOf(d1), /is learner in an earlier record and candidate here/);
  const d2 = copyDir();
  rec(d2, (r) => { const i = r.findIndex((x, n) => n > 0 && x.event.type === 'attempt.state_changed' && x.event.data.state === 'submitted'); r[i].event.data.previous_state = 'invited'; });
  assert.match(problemsOf(d2), /previous_state is invited but the attempt was running/);
  const d3 = copyDir();
  rec(d3, (r) => { const i = find(r, 'attempt.state_changed', 'learner'); r[i].event.data.previous_state = r[i].event.data.state; });
  assert.match(problemsOf(d3), /previous_state differs from state/);
  const d4 = copyDir();
  rec(d4, (r) => { const i = r.findIndex((x) => x.event.type === 'instance.state_changed' && x.event.data.epoch === 2); r[i].event.data.epoch = 1; const j = r.findIndex((x) => x.event.type === 'instance.state_changed'); r[j].event.data.epoch = 3; });
  assert.match(problemsOf(d4), /epoch goes back from 3 to 1/);
});

test('audiences.json: modes equal the schema Mode, a wrong shape is a reported problem, a duplicate challenge row is a rule', () => {
  const d1 = copyDir();
  editJson(d1, AUDIENCES_FILE, (t) => { t.modes = ['learner']; });
  assert.match(problemsOf(d1), /modes must equal the schema's Mode/);
  const d2 = copyDir();
  fs.writeFileSync(path.join(d2, AUDIENCES_FILE), '[]');
  assert.match(problemsOf(d2), /audiences, modes and types are required/);
  const d3 = copyDir();
  fs.writeFileSync(path.join(d3, 'examples', 'invalid', 'manifest.json'), '[]');
  assert.match(problemsOf(d3), /manifest\.json must be an object/);
  const d4 = copyDir();
  editJson(d4, 'examples/invalid/manifest.json', (m) => { m['unknown-type.json'] = null; });
  assert.match(problemsOf(d4), /unknown-type\.json: the entry must be/);
  const d5 = copyDir();
  editJson(d5, SCHEMA_FILE, (s) => { delete s.properties.type; });
  assert.match(problemsOf(d5), /properties\.type\.enum is missing/);
  const dup = { type: 'attempt.score_updated', data: { per_challenge: [{ challenge_key: 'C01' }, { challenge_key: 'C01' }] } };
  assert.equal(semanticEvent(dup, null)[0].path, '/data/per_challenge');
});
