import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateContracts, main, errorPath, DEFAULT_DIR, SCHEMAS } from './validate-contracts.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validate-contracts.mjs');

// Copy the real contract folder to a temp folder, run fn(dir) on the copy, remove it.
function withCopy(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-contract-'));
  try {
    fs.cpSync(DEFAULT_DIR, dir, { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJ = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
const failsWith = (res, re) => res.errors.some((e) => re.test(e));
const sample = (dir, schema, kind) => path.join(dir, 'examples', kind, schema);

test('the real contract validates: exit 0, every schema and example counted', () => {
  const res = validateContracts();
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.ok(res.lines.some((l) => /checked 3 schemas, \d+ valid and \d+ invalid examples/.test(l)));
  for (const s of SCHEMAS) assert.ok(res.lines.includes(`schema ok: ${s}.schema.json`), s);
});

test('coverage: every rule family has invalid examples and every schema has a valid one', () => {
  const manifest = readJ(path.join(DEFAULT_DIR, 'examples', 'invalid', 'manifest.json'));
  const keys = Object.keys(manifest);
  for (const s of SCHEMAS) {
    assert.ok(keys.some((k) => k.startsWith(`${s}/`)), `invalid for ${s}`);
    assert.ok(fs.readdirSync(sample(DEFAULT_DIR, s, 'valid')).length > 0, `valid for ${s}`);
  }
  for (const name of ['bad-flag-format', 'missing-epoch', 'privileged-true', 'host-bind-mount', 'cap-drop-missing', 'env-flag-in-value', 'bad-owner-label', 'run-vm-separate-volumes', 'missing-shop-role', 'flag-delivery-env-short-reason']) {
    assert.ok(keys.some((k) => k.endsWith(`/${name}.json`)), name);
  }
  assert.ok(keys.filter((k) => k.startsWith('instance-template/')).length >= 40);
  for (const v of Object.values(manifest)) assert.match(v.path, /^\//);
});

test('CLI: exit 0 on the real contract and lists the examples', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /valid example ok: examples\/valid\/instance-template\/shop-template\.json/);
  assert.match(r.stdout, /invalid example rejected at \/epoch/);
  assert.match(r.stdout, /contracts: PASS/);
});

test('CLI: --help exits 0, unknown argument exits 2, importing does not run main', () => {
  const h = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage/);
  const u = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  const out = [];
  assert.equal(main(['--help'], { log: (m) => out.push(m), err: () => {} }), 0);
  assert.equal(main(['--x'], { log: () => {}, err: () => {} }), 2);
});

test('CLI: exits non-zero on a broken copy and prints the failing path', () => {
  withCopy((dir) => {
    fs.rmSync(path.join(dir, 'examples', 'valid', 'injection-document', 'full.json'));
    writeJ(path.join(dir, 'examples', 'valid', 'injection-document', 'bad.json'), { schema_version: '0.1' });
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL examples\/valid\/injection-document\/bad\.json/);
  });
});

test('removing epoch from the injection schema makes the run fail', () => {
  withCopy((dir) => {
    const f = path.join(dir, 'injection-document.schema.json');
    const s = readJ(f);
    s.required = s.required.filter((x) => x !== 'epoch');
    delete s.properties.epoch;
    writeJ(f, s);
    const res = validateContracts({ dir });
    assert.equal(res.ok, false);
    assert.ok(res.errors.includes('examples/invalid/injection-document/missing-epoch.json: invalid example passes (expected an error at /epoch)'), res.errors.join('\n'));
    const man = readJ(path.join(dir, 'examples', 'invalid', 'manifest.json'));
    for (const n of ['missing-epoch', 'non-numeric-epoch', 'zero-epoch']) assert.equal(man[`injection-document/${n}.json`].path, '/epoch');
  });
});

test('a template without the shop role fails (as the valid example)', () => {
  withCopy((dir) => {
    const f = path.join(sample(dir, 'instance-template', 'valid'), 'shop-template.json');
    const t = readJ(f);
    t.components = t.components.filter((c) => c.role !== 'shop');
    writeJ(f, t);
    const res = validateContracts({ dir });
    assert.equal(res.ok, false);
    assert.ok(failsWith(res, /valid example fails.*\/components/), res.errors.join('\n'));
  });
});

test('injector and shop not sharing one /run/vm volume fails (as the valid example)', () => {
  withCopy((dir) => {
    const f = path.join(sample(dir, 'instance-template', 'valid'), 'shop-template.json');
    const t = readJ(f);
    t.volumes.push({ name: 'vm-run-other', memory_backed: true, size_mb: 16 });
    t.components[0].mounts.find((m) => m.target === '/run/vm').source = 'vm-run-other';
    writeJ(f, t);
    const res = validateContracts({ dir });
    assert.equal(res.ok, false);
    assert.ok(failsWith(res, /same volume the injector mounts at \/run\/vm/), res.errors.join('\n'));
  });
});

test('a non-memory-backed volume fails (as the valid example)', () => {
  withCopy((dir) => {
    const f = path.join(sample(dir, 'instance-template', 'valid'), 'shop-template.json');
    const t = readJ(f);
    t.volumes[0].memory_backed = false;
    writeJ(f, t);
    assert.ok(failsWith(validateContracts({ dir }), /\/volumes\/0\/memory_backed/));
  });
});

test('an invalid example that passes is reported', () => {
  withCopy((dir) => {
    const valid = readJ(path.join(sample(dir, 'flags-file', 'valid'), 'full.json'));
    writeJ(path.join(sample(dir, 'flags-file', 'invalid'), 'bad-flag-format.json'), valid);
    const res = validateContracts({ dir });
    assert.ok(failsWith(res, /bad-flag-format\.json: invalid example passes/));
  });
});

test('an invalid example failing at the wrong path is reported with both paths', () => {
  withCopy((dir) => {
    const m = path.join(dir, 'examples', 'invalid', 'manifest.json');
    const man = readJ(m);
    man['injection-document/missing-epoch.json'].path = '/seed';
    writeJ(m, man);
    const res = validateContracts({ dir });
    assert.ok(failsWith(res, /missing-epoch\.json: expected an error at \/seed, got \/epoch/), res.errors.join('\n'));
  });
});

test('orphan example, example without manifest entry, manifest entry without file', () => {
  withCopy((dir) => {
    fs.mkdirSync(path.join(dir, 'examples', 'valid', 'catalog'));
    writeJ(path.join(dir, 'examples', 'valid', 'catalog', 'x.json'), {});
    writeJ(path.join(sample(dir, 'flags-file', 'invalid'), 'no-entry.json'), {});
    fs.rmSync(path.join(sample(dir, 'flags-file', 'invalid'), 'missing-epoch.json'));
    const res = validateContracts({ dir });
    assert.ok(failsWith(res, /examples\/valid\/catalog\/x\.json: orphan example/));
    assert.ok(failsWith(res, /no-entry\.json: no expected error path/));
    assert.ok(failsWith(res, /manifest\.json: entry flags-file\/missing-epoch\.json has no example file/));
  });
  withCopy((dir) => {
    fs.rmSync(path.join(sample(dir, 'injection-document', 'invalid'), 'missing-epoch.json'));
    assert.ok(failsWith(validateContracts({ dir }), /manifest\.json: entry injection-document\/missing-epoch\.json has no example file/));
  });
});

test('malformed JSON is reported, not thrown', () => {
  withCopy((dir) => {
    fs.writeFileSync(path.join(sample(dir, 'flags-file', 'valid'), 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'flags-file.schema.json'), '{ nope');
    const res = validateContracts({ dir });
    assert.equal(res.ok, false);
    assert.ok(failsWith(res, /broken\.json: cannot read or parse JSON/));
    assert.ok(failsWith(res, /flags-file\.schema\.json: cannot read or parse JSON/));
  });
});

test('a schema that does not compile names the cause', () => {
  withCopy((dir) => {
    const f = path.join(dir, 'flags-file.schema.json');
    const s = readJ(f);
    s.type = 'nonsense';
    writeJ(f, s);
    assert.ok(failsWith(validateContracts({ dir }), /flags-file\.schema\.json: schema does not compile \(.+\)/));
  });
});

test('a missing schema file and a missing contract text are reported', () => {
  withCopy((dir) => {
    fs.rmSync(path.join(dir, 'instance-template.schema.json'));
    fs.rmSync(path.join(dir, 'instance-contract.md'));
    const res = validateContracts({ dir });
    assert.ok(failsWith(res, /instance-template\.schema\.json: missing/));
    assert.ok(failsWith(res, /instance-contract\.md: missing/));
  });
});

test('contract text must keep its 11 sections and the open-points table', () => {
  withCopy((dir) => {
    const f = path.join(dir, 'instance-contract.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('## 7. Runtime profile', '## Runtime profile').replace('## Open points (to confirm)', '## Notes'));
    const res = validateContracts({ dir });
    assert.ok(failsWith(res, /no section "## 7\. /));
    assert.ok(failsWith(res, /Open points \(to confirm\)/));
  });
});

test('a real-looking flag or a private key in an example or in the text is rejected', () => {
  withCopy((dir) => {
    const f = path.join(sample(dir, 'flags-file', 'valid'), 'full.json');
    const o = readJ(f);
    o.flags[0].flag = 'VM{ABCDEFGHIJKLMNOPQRSTUVWX}';
    writeJ(f, o);
    const md = path.join(dir, 'instance-contract.md');
    fs.appendFileSync(md, '\n-----BEGIN PRIVATE KEY-----\n');
    const res = validateContracts({ dir });
    assert.ok(failsWith(res, /full\.json: flag-like value .* not an obviously fake flag/));
    assert.ok(failsWith(res, /instance-contract\.md: contains a private key block/));
  });
});

test('a byte-order mark is rejected', () => {
  withCopy((dir) => {
    const f = path.join(sample(dir, 'flags-file', 'valid'), 'full.json');
    fs.writeFileSync(f, String.fromCharCode(0xfeff) + fs.readFileSync(f, 'utf8'));
    assert.ok(failsWith(validateContracts({ dir }), /byte-order mark/));
  });
});

test('no file of the contract or its tooling starts with a byte-order mark', () => {
  const root = path.resolve(DEFAULT_DIR, '..', '..');
  const files = ['package.json', 'scripts/validate-contracts.mjs', 'scripts/validate-contracts.test.mjs', 'contracts/CHANGELOG.md'];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const all = [...files.map((f) => path.join(root, f)), ...walk(DEFAULT_DIR).filter((f) => !f.endsWith('.gitkeep'))];
  for (const f of all) assert.notEqual(fs.readFileSync(f)[0], 0xef, `${f} has a byte-order mark`);
});

test('OS metadata files and .gitkeep in examples are not orphans; a secret in a schema is found', () => {
  withCopy((dir) => {
    for (const n of ['.DS_Store', 'Thumbs.db', '.gitkeep']) fs.writeFileSync(path.join(dir, 'examples', 'valid', n), '');
    assert.equal(validateContracts({ dir }).ok, true);
    const f = path.join(dir, 'flags-file.schema.json');
    const s = readJ(f);
    s.description = 'VM{ABCDEFGHIJKLMNOPQRSTUVWX}';
    writeJ(f, s);
    assert.ok(failsWith(validateContracts({ dir }), /flags-file\.schema\.json: flag-like value/));
  });
});

test('errorPath builds JSON Pointers for required, additional and property-name errors', () => {
  assert.equal(errorPath({ instancePath: '/a', params: { missingProperty: 'b' } }), '/a/b');
  assert.equal(errorPath({ instancePath: '/a', params: { additionalProperty: 'x/y' } }), '/a/x~1y');
  assert.equal(errorPath({ instancePath: '/env', params: {}, propertyName: 'KEY' }), '/env/KEY');
  assert.equal(errorPath({ instancePath: '', params: {} }), '');
});
