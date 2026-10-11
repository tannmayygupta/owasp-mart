// Unit tests of the stub injector (IF-6 section 5): the exit codes, the order of the steps, and that nothing from the document is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runInject, EXIT } from './inject.mjs';
import { compile, SCHEMAS } from './common.mjs';
import { freshValues, injectionDocument } from './fixtures.mjs';

const posix = process.platform !== 'win32';
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-inject-'));
  const dirs = { run: path.join(root, 'run-vm'), imp: path.join(root, 'place-import'), mock: path.join(root, 'place-mock') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  const env = { VM_SNAPSHOT_PATH: path.join(dirs.run, 'snapshot.db'), VM_FLAGS_PATH: path.join(dirs.run, 'flags.json') };
  const placements = [
    { challenge_key: 'C06', dir: dirs.imp, file: 'C06.placement' },
    { challenge_key: 'C10', dir: dirs.mock, file: 'C10.placement' },
  ];
  return { root, dirs, env, placements, marker: path.join(dirs.run, 'injected'), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function inject(s, input, extra = {}) {
  const out = [];
  const stdin = Readable.from([typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input)]);
  const code = await runInject({ stdin, env: s.env, placements: s.placements, log: (m) => out.push(m), ...extra });
  return { code, out };
}

test('success: exit 0, snapshot, placements, flags file valid against its schema, marker written last', async () => {
  const s = setup();
  try {
    const v = freshValues();
    const r = await inject(s, injectionDocument(v));
    assert.equal(r.code, EXIT.OK);
    assert.ok(fs.existsSync(s.env.VM_SNAPSHOT_PATH));
    const flags = JSON.parse(fs.readFileSync(s.env.VM_FLAGS_PATH, 'utf8'));
    const validate = compile(SCHEMAS.flags);
    assert.ok(validate(flags), JSON.stringify(validate.errors));
    assert.equal(flags.epoch, v.epoch);
    assert.equal(flags.instance_id, v.instance_id);
    assert.equal(fs.readFileSync(path.join(s.dirs.imp, 'C06.placement'), 'utf8'), v.flags.find((f) => f.challenge_key === 'C06').flag);
    assert.equal(fs.readFileSync(path.join(s.dirs.mock, 'C10.placement'), 'utf8'), v.flags.find((f) => f.challenge_key === 'C10').flag);
    assert.equal(fs.readFileSync(s.marker, 'utf8'), '');
    assert.ok(fs.statSync(s.marker).mtimeMs >= fs.statSync(s.env.VM_FLAGS_PATH).mtimeMs, 'marker is written after the flags file');
    if (posix) {
      assert.equal(mode(s.env.VM_FLAGS_PATH), '400');
      assert.equal(mode(s.marker), '444');
      assert.equal(mode(path.join(s.dirs.imp, 'C06.placement')), '400');
    }
    assert.deepEqual(r.out, ['inject: done']);
  } finally { s.clean(); }
});

test('exit 10 for every kind of bad document, nothing printed from it, no marker and no file written', async () => {
  const v = freshValues();
  const good = injectionDocument(v);
  const cases = {
    'empty input': '',
    'not JSON': '{"flags": ',
    'not UTF-8': Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
    'a byte-order mark': '﻿' + JSON.stringify(good),
    'schema: missing seed': (() => { const d = structuredClone(good); delete d.seed; return d; })(),
    'schema: bad flag format': { ...good, flags: [{ challenge_key: 'C01', flag: 'not-a-flag' }] },
    'schema: extra property': { ...good, extra: 1 },
    'duplicate challenge key': { ...good, flags: [good.flags[0], { challenge_key: good.flags[0].challenge_key, flag: good.flags[1].flag }] },
    'decoy equals a flag': { ...good, decoys: [{ challenge_key: 'C01', index: 0, value: good.flags[0].flag }] },
  };
  for (const [name, input] of Object.entries(cases)) {
    const s = setup();
    try {
      const r = await inject(s, input);
      assert.equal(r.code, EXIT.BAD_DOCUMENT, name);
      assert.deepEqual(r.out, ['inject: exit 10 (bad document)'], name);
      assert.ok(!r.out.join('').includes(v.seed), name);
      assert.equal(fs.readdirSync(s.dirs.run).length, 0, `${name}: no file written`);
      assert.ok(!fs.existsSync(s.marker), name);
    } finally { s.clean(); }
  }
});

test('exit 10 when the document is larger than the limit', async () => {
  const s = setup();
  try {
    const r = await inject(s, JSON.stringify({ pad: 'x'.repeat(2000) }), { maxBytes: 1000 });
    assert.equal(r.code, EXIT.BAD_DOCUMENT);
  } finally { s.clean(); }
});

test('exit 11 when the snapshot cannot be written; no marker, no flags file, nothing from the document printed', async () => {
  const s = setup();
  try {
    const v = freshValues();
    const env = { ...s.env, VM_SNAPSHOT_PATH: path.join(s.root, 'missing-dir', 'snapshot.db') };
    const r = await inject(s, injectionDocument(v), { env });
    assert.equal(r.code, EXIT.SNAPSHOT);
    assert.deepEqual(r.out, ['inject: exit 11 (snapshot patch failed)']);
    assert.ok(!fs.existsSync(s.marker));
    assert.ok(!fs.existsSync(s.env.VM_FLAGS_PATH));
  } finally { s.clean(); }
});

test('exit 12 when a placement file cannot be written; marker absent', async () => {
  const s = setup();
  try {
    const placements = [{ challenge_key: 'C06', dir: path.join(s.root, 'no-such-volume'), file: 'C06.placement' }];
    const r = await inject(s, injectionDocument(freshValues()), { placements });
    assert.equal(r.code, EXIT.PLACEMENT);
    assert.deepEqual(r.out, ['inject: exit 12 (placement write failed)']);
    assert.ok(!fs.existsSync(s.marker));
    assert.ok(!fs.existsSync(s.env.VM_FLAGS_PATH));
  } finally { s.clean(); }
});

test('exit 13 when the flags file cannot be written; marker absent', async () => {
  const s = setup();
  try {
    const env = { ...s.env, VM_FLAGS_PATH: path.join(s.root, 'missing-dir', 'flags.json') };
    const r = await inject(s, injectionDocument(freshValues()), { env });
    assert.equal(r.code, EXIT.MARKER);
    assert.deepEqual(r.out, ['inject: exit 13 (flags file or marker write failed)']);
    assert.ok(!fs.existsSync(path.join(s.root, 'missing-dir', 'injected')));
  } finally { s.clean(); }
});

test('exit 13 when the marker cannot be written; the marker is the last step', async () => {
  const s = setup();
  try {
    fs.mkdirSync(s.marker); // a directory where the marker file must go
    const r = await inject(s, injectionDocument(freshValues()));
    assert.equal(r.code, EXIT.MARKER);
    assert.ok(fs.statSync(s.marker).isDirectory(), 'no marker file exists');
  } finally { s.clean(); }
});

test('a second run in the same place fails (the document is written once)', async () => {
  const s = setup();
  try {
    const doc = injectionDocument(freshValues());
    assert.equal((await inject(s, doc)).code, EXIT.OK);
    assert.equal((await inject(s, doc)).code, EXIT.SNAPSHOT);
  } finally { s.clean(); }
});

test('exit 10 for the decoy rules of the contract: repeated value, repeated (challenge_key, index), decoy for an unknown challenge', async () => {
  const good = injectionDocument(freshValues());
  const k = good.flags[0].challenge_key;
  const cases = {
    'repeated decoy value': { ...good, decoys: [{ challenge_key: k, index: 0, value: 'VM' + String.fromCharCode(123) + 'A'.repeat(24) + String.fromCharCode(125) }, { challenge_key: k, index: 1, value: 'VM' + String.fromCharCode(123) + 'A'.repeat(24) + String.fromCharCode(125) }] },
    'repeated (challenge_key, index)': { ...good, decoys: [{ challenge_key: k, index: 0, value: 'VM' + String.fromCharCode(123) + 'A'.repeat(24) + String.fromCharCode(125) }, { challenge_key: k, index: 0, value: 'VM' + String.fromCharCode(123) + 'B'.repeat(24) + String.fromCharCode(125) }] },
    'decoy for a challenge without a flag': { ...good, flags: [good.flags[0]], decoys: [{ challenge_key: 'C11', index: 0, value: 'VM' + String.fromCharCode(123) + 'C'.repeat(24) + String.fromCharCode(125) }] },
  };
  for (const [name, doc] of Object.entries(cases)) {
    const s = setup();
    try { assert.equal((await inject(s, doc)).code, EXIT.BAD_DOCUMENT, name); } finally { s.clean(); }
  }
});

test('exit 10 for trailing data after the document and for input that never completes', async () => {
  const s = setup();
  try {
    const doc = JSON.stringify(injectionDocument(freshValues()));
    assert.equal((await inject(s, doc + doc)).code, EXIT.BAD_DOCUMENT);
    assert.equal((await inject(s, '[1]')).code, EXIT.BAD_DOCUMENT);
    assert.equal(fs.readdirSync(s.dirs.run).length, 0);
  } finally { s.clean(); }
});