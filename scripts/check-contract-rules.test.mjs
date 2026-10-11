// One test per row of the I/O matrix of story L-07. Each test builds a temporary git repository, commits a valid base on `main`, changes the
// working tree, and runs the rules against `main` (the same code path CI uses against the pull request base).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isBreakingMarker, REGISTRY_CHANGE_LINE, isGuarded, effectiveRegistry, runRules, formatResults, resolveBase, resolveTag, latestTag, spawn, runPythonCheck, validateRegistry, newEntries, changelogSection, addedLines, sectionVersions, PASS, FAIL, NA, REPO_ROOT } from './check-contract-rules.mjs';
import { ensureOasdiff } from './oasdiff.mjs';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-contract-rules.mjs');
let oasdiffBin;
before(async () => { oasdiffBin = await ensureOasdiff(); });

const SCHEMA_A = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id'],
  additionalProperties: true,
  properties: { id: { type: 'string' }, kind: { enum: ['x', 'y'] } },
};
const OPENAPI_B = `openapi: 3.1.0
info: { title: b, version: 0.1.0 }
paths:
  /things:
    get:
      operationId: listThings
      parameters:
        - { name: kind, in: query, required: false, schema: { enum: [a, b] } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: object, required: [name], properties: { name: { type: string }, note: { type: string } } }
    post:
      operationId: makeThing
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { name: { type: string }, size: { type: integer } } }
      responses:
        '201': { description: created }
  /other:
    get:
      operationId: other
      responses:
        '200': { description: ok }
`;
const CHANGELOG = `# Contracts changelog

## Contract A, \`contracts/a/\`

### 0.1.0 (2026-10-01)
- First draft.

## Contract B, \`contracts/b/\`

### 0.1.0 (2026-10-01)
- First draft.

## Table owners, \`contracts/db/\`

### 0.1.0 (2026-10-01)
- First draft.
`;
const REGISTRY = {
  version: 1,
  containers: ['api'],
  reserved: ['contracts/catalog'],
  generated: ['contracts/api/bundle'],
  mockRoot: 'contracts/mocks',
  contracts: [
    { id: 'A', name: 'A', owner: 'L', folders: ['contracts/a'], schemas: ['contracts/a/a.schema.json'], openapi: [], changelog: 'Contract A, `contracts/a/`', mocks: ['contracts/mocks/mock-a'], conformance: [] },
    { id: 'B', name: 'B', owner: 'L', folders: ['contracts/b'], schemas: [], openapi: ['contracts/b/b.openapi.yaml'], changelog: 'Contract B, `contracts/b/`', mocks: ['contracts/mocks/mock-b'], conformance: [] },
    { id: 'DB', name: 'DB', owner: 'P', folders: ['contracts/db'], schemas: ['contracts/db/table-owners.schema.json'], openapi: [], changelog: 'Table owners, `contracts/db/`', mocks: [], noMock: 'no mock by design: nothing runs against it', conformance: [] },
  ],
};

const write = (root, rel, content) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sh = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function makeRepo(customize = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-rules-repo-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.invalid');
  sh(root, 'config', 'user.name', 'test');
  sh(root, 'config', 'core.autocrlf', 'false');
  write(root, 'contracts/registry.json', REGISTRY);
  write(root, 'contracts/CHANGELOG.md', CHANGELOG);
  write(root, 'contracts/a/a.schema.json', SCHEMA_A);
  write(root, 'contracts/a/a.md', '# A\n');
  write(root, 'contracts/b/b.openapi.yaml', OPENAPI_B);
  write(root, 'contracts/mocks/mock-a/server.mjs', '// mock a\n');
  write(root, 'contracts/mocks/mock-b/server.mjs', '// mock b\n');
  write(root, 'contracts/catalog/.gitkeep', '');
  write(root, '.github/CODEOWNERS', read(REPO_ROOT, '.github/CODEOWNERS'));
  for (const m of ['accounts', 'ingest', 'orgs']) write(root, `apps/api/src/vulnmart/${m}/__init__.py`, '');
  write(root, 'contracts/db/table-owners.schema.json', read(REPO_ROOT, 'contracts/db/table-owners.schema.json'));
  customize(root);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  return root;
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

// Runs the rules after `mutate`; returns the results keyed by name.
async function scenario(mutate, { skip = ['table-owners', 'alembic'], base = 'main', customize, opts = {} } = {}) {
  const root = makeRepo(customize);
  try {
    await mutate(root);
    const results = await runRules({ root, base, oasdiffBin, skip, ...opts });
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    return { root, results, by, text: formatResults(results) };
  } finally {
    cleanup(root);
  }
}
const statuses = (by, prefix) => Object.entries(by).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => `${k}=${v.status}`);
const failing = (results) => results.filter((r) => r.status === FAIL).map((r) => r.name);
const addChangelog = (root, section, line) => {
  const t = read(root, 'contracts/CHANGELOG.md');
  const marker = `## ${section}\n`;
  write(root, 'contracts/CHANGELOG.md', t.replace(marker, `${marker}\n${line}\n`));
};
const touchMock = (root, name) => write(root, `contracts/mocks/${name}/server.mjs`, '// changed\n');
const A = 'Contract A, `contracts/a/`';
const B = 'Contract B, `contracts/b/`';

test('no change at all: every check passes', async () => {
  const { results, by } = await scenario(() => {});
  assert.deepEqual(failing(results), []);
  assert.equal(by['contract[A]'].status, PASS);
  assert.equal(by['contract[B]'].status, PASS);
});

test('matrix: valid additive change (new optional property, endpoint, enum value) with changelog and mock updated: all PASS', async () => {
  const { results, by } = await scenario((root) => {
    const s = JSON.parse(read(root, 'contracts/a/a.schema.json'));
    s.properties.extra = { type: 'string' };
    s.properties.kind.enum.push('z');
    write(root, 'contracts/a/a.schema.json', s);
    write(root, 'contracts/b/b.openapi.yaml', read(root, 'contracts/b/b.openapi.yaml')
      .replace('  /other:', '  /more:\n    get:\n      operationId: more\n      responses:\n        \'200\': { description: ok }\n  /other:')
      .replace('enum: [a, b]', 'enum: [a, b, c]')
      .replace('note: { type: string } } }', 'note: { type: string }, extra: { type: string } } }'));
    addChangelog(root, A, '### 0.2.0 (2026-10-10)\n- Additive: optional `extra`, enum value `z`.');
    addChangelog(root, B, '### 0.2.0 (2026-10-10)\n- Additive: `/more`, enum value `c`, optional `extra`.');
    touchMock(root, 'mock-a');
    touchMock(root, 'mock-b');
  });
  assert.deepEqual(failing(results), [], formatResults(results));
  assert.equal(by['breaking[A]'].status, PASS);
  assert.equal(by['breaking[B]'].status, PASS);
});

// ---- OpenAPI breaking -------------------------------------------------------------------------------------------------------------------
const OPENAPI_BREAKS = {
  'removed response property': (y) => y.replace('required: [name], properties: { name: { type: string }, note: { type: string } }', 'required: [], properties: { note: { type: string } }'),
  'removed optional response property': (y) => y.replace('name: { type: string }, note: { type: string } } }', 'name: { type: string } } }'),
  'removed path': (y) => y.replace(/  \/other:[\s\S]*$/, ''),
  'optional to required in a request': (y) => y.replace('schema: { type: object, properties: { name: { type: string }, size: { type: integer } } }', 'schema: { type: object, required: [size], properties: { name: { type: string }, size: { type: integer } } }'),
  'removed enum value in a request parameter': (y) => y.replace('enum: [a, b]', 'enum: [a]'),
};
for (const [name, change] of Object.entries(OPENAPI_BREAKS)) {
  test(`matrix: OpenAPI breaking (${name}): oasdiff reports ERR, the run fails naming the file`, async () => {
    const { results, by } = await scenario((root) => {
      write(root, 'contracts/b/b.openapi.yaml', change(read(root, 'contracts/b/b.openapi.yaml')));
      addChangelog(root, B, '### 0.1.1 (2026-10-10)\n- Fix text.\n- no mock change: test');
    });
    assert.equal(by['breaking[B]'].status, FAIL, formatResults(results));
    assert.match(by['breaking[B]'].details.join('\n'), /contracts\/b\/b\.openapi\.yaml/);
    assert.match(by['breaking[B]'].details.join('\n'), /\[[a-z-]+\]/);
  });
}

// ---- JSON Schema breaking ---------------------------------------------------------------------------------------------------------------
const SCHEMA_BREAKS = {
  'removed property': (s) => { delete s.properties.kind; },
  'retyped property': (s) => { s.properties.id.type = 'integer'; },
  'optional to required': (s) => { s.required.push('kind'); },
  'removed enum value': (s) => { s.properties.kind.enum = ['x']; },
  'tightened pattern': (s) => { s.properties.id.pattern = '^a$'; },
  'tightened bound': (s) => { s.properties.id.maxLength = 3; },
  'additionalProperties true to false': (s) => { s.additionalProperties = false; },
};
for (const [name, change] of Object.entries(SCHEMA_BREAKS)) {
  test(`matrix: JSON Schema breaking (${name}): own diff fails naming file and path`, async () => {
    const { by, text } = await scenario((root) => {
      const s = JSON.parse(read(root, 'contracts/a/a.schema.json'));
      change(s);
      write(root, 'contracts/a/a.schema.json', s);
      addChangelog(root, A, '### 0.1.1 (2026-10-10)\n- text\n- no mock change: test');
    });
    assert.equal(by['breaking[A]'].status, FAIL, text);
    assert.match(by['breaking[A]'].details[0], /^contracts\/a\/a\.schema\.json #\//);
  });
}

// ---- Breaking but declared --------------------------------------------------------------------------------------------------------------
const breakA = (root, entry) => {
  const s = JSON.parse(read(root, 'contracts/a/a.schema.json'));
  delete s.properties.kind;
  write(root, 'contracts/a/a.schema.json', s);
  addChangelog(root, A, entry);
  touchMock(root, 'mock-a');
};

test('matrix: breaking but declared (changelog line marked BREAKING and the minor number raised): passes with a BREAKING notice', async () => {
  const { by, results, text } = await scenario((root) => breakA(root, '### 0.2.0 (2026-10-10)\n- BREAKING: removed `kind`.'));
  assert.deepEqual(failing(results), [], text);
  assert.equal(by['breaking[A]'].status, PASS);
  assert.match(by['breaking[A]'].details.join('\n'), /BREAKING declared/);
  assert.match(by['breaking[A]'].details.join('\n'), /notice: contracts\/a\/a\.schema\.json #\/properties\/kind/);
});

test('breaking, marked BREAKING but the minor number is not raised: FAIL', async () => {
  const { by } = await scenario((root) => breakA(root, '### 0.1.0 follow-up (2026-10-10)\n- BREAKING: removed `kind`.'));
  assert.equal(by['breaking[A]'].status, FAIL);
  assert.match(by['breaking[A]'].details.join('\n'), /by a minor step/);
});

test('breaking, version raised but no line marked BREAKING: FAIL', async () => {
  const { by } = await scenario((root) => breakA(root, '### 0.2.0 (2026-10-10)\n- removed `kind`.'));
  assert.equal(by['breaking[A]'].status, FAIL);
  assert.match(by['breaking[A]'].details.join('\n'), /marked BREAKING/);
});

test('an OpenAPI breaking change declared with BREAKING and a raised minor passes', async () => {
  const { by, results, text } = await scenario((root) => {
    write(root, 'contracts/b/b.openapi.yaml', OPENAPI_BREAKS['removed path'](read(root, 'contracts/b/b.openapi.yaml')));
    addChangelog(root, B, '### 0.2.0 (2026-10-10)\n- BREAKING: removed `/other`.');
    touchMock(root, 'mock-b');
  });
  assert.deepEqual(failing(results), [], text);
  assert.match(by['breaking[B]'].details.join('\n'), /BREAKING declared/);
});

// ---- Changelog and mock rules -----------------------------------------------------------------------------------------------------------
test('matrix: no changelog entry: FAIL naming the contract', async () => {
  const { by } = await scenario((root) => {
    write(root, 'contracts/a/a.md', '# A, edited\n');
  });
  assert.equal(by['changelog[A]'].status, FAIL);
  assert.match(by['changelog[A]'].details[0], /A changed \(contracts\/a\/a\.md\)/);
  assert.equal(by['contract[B]'].status, PASS);
});

test('a changelog entry under another contract does not count', async () => {
  const { by } = await scenario((root) => {
    write(root, 'contracts/a/a.md', '# A, edited\n');
    addChangelog(root, B, '### 0.1.1\n- other contract');
  });
  assert.equal(by['changelog[A]'].status, FAIL);
});

test('matrix: mock not updated, no waiver: FAIL naming the mock paths; a waiver line or a changed mock passes', async () => {
  const edit = (root) => {
    const s = JSON.parse(read(root, 'contracts/a/a.schema.json'));
    s.properties.extra = { type: 'string' };
    write(root, 'contracts/a/a.schema.json', s);
  };
  const no = await scenario((root) => { edit(root); addChangelog(root, A, '### 0.1.1\n- additive'); });
  assert.equal(no.by['mock[A]'].status, FAIL);
  assert.match(no.by['mock[A]'].details[0], /contracts\/mocks\/mock-a/);
  const waived = await scenario((root) => { edit(root); addChangelog(root, A, '### 0.1.1\n- additive\n- no mock change: the mock ignores unknown fields'); });
  assert.equal(waived.by['mock[A]'].status, PASS);
  assert.match(waived.by['mock[A]'].details[0], /waived/);
  const touched = await scenario((root) => { edit(root); addChangelog(root, A, '### 0.1.1\n- additive'); touchMock(root, 'mock-a'); });
  assert.equal(touched.by['mock[A]'].status, PASS);
  const other = await scenario((root) => { edit(root); addChangelog(root, A, '### 0.1.1\n- additive'); touchMock(root, 'mock-b'); });
  assert.equal(other.by['mock[A]'].status, FAIL, 'a change to another contract\'s mock does not count');
});

test('a documentation-only change needs a changelog line but no mock change', async () => {
  const { by } = await scenario((root) => { write(root, 'contracts/a/a.md', '# A edited\n'); addChangelog(root, A, '### 0.1.1\n- text only'); });
  assert.equal(by['changelog[A]'].status, PASS);
  assert.equal(by['mock[A]'].status, PASS);
});

// ---- Registry ---------------------------------------------------------------------------------------------------------------------------
test('matrix: unregistered contract (new folder under contracts/ without an entry): FAIL asking for an entry', async () => {
  const { by } = await scenario((root) => write(root, 'contracts/newthing/x.schema.json', { type: 'object' }));
  assert.equal(by.registry.status, FAIL);
  assert.match(by.registry.details.join('\n'), /contracts\/newthing: unregistered contract folder; add an entry to contracts\/registry\.json/);
});

test('an unregistered folder under contracts/api, an unregistered mock and a reserved folder with content all fail', async () => {
  const { by } = await scenario((root) => {
    write(root, 'contracts/api/platform2/x.yaml', 'a: 1\n');
    write(root, 'contracts/mocks/mock-z/s.mjs', '//\n');
    write(root, 'contracts/catalog/real.json', '{}\n');
  });
  const d = by.registry.details.join('\n');
  assert.equal(by.registry.status, FAIL);
  assert.match(d, /contracts\/api\/platform2: unregistered/);
  assert.match(d, /contracts\/mocks\/mock-z: mock folder not named/);
  assert.match(d, /contracts\/catalog: has files/);
});

test('a registry entry that names a path that does not exist fails', async () => {
  const { by } = await scenario((root) => {
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts[0].conformance = ['scripts/nope.mjs'];
    write(root, 'contracts/registry.json', r);
  });
  assert.equal(by.registry.status, FAIL);
  assert.match(by.registry.details.join('\n'), /A: conformance path scripts\/nope\.mjs does not exist/);
});

test('a missing registry fails and runs nothing else', async () => {
  const { results } = await scenario((root) => fs.rmSync(path.join(root, 'contracts/registry.json')));
  assert.deepEqual(results.map((r) => `${r.name}=${r.status}`), ['registry=FAIL']);
});

test('matrix: new file (spec not in the base ref): skipped as not breaking and reported', async () => {
  const { by, results, text } = await scenario((root) => {
    write(root, 'contracts/a/new.schema.json', { type: 'object' });
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts[0].schemas.push('contracts/a/new.schema.json');
    write(root, 'contracts/registry.json', r);
    addChangelog(root, A, '### 0.2.0\n- new schema');
    touchMock(root, 'mock-a');
  });
  assert.deepEqual(failing(results), [], text);
  assert.match(by['breaking[A]'].details.join('\n'), /new\.schema\.json: new file, not compared/);
});

test('matrix: oasdiff binary missing or with a wrong checksum: FAIL, the comparison does not run', async () => {
  const root = makeRepo();
  try {
    write(root, 'contracts/b/b.openapi.yaml', read(root, 'contracts/b/b.openapi.yaml').replace('enum: [a, b]', 'enum: [a, b, c]'));
    addChangelog(root, B, '### 0.2.0\n- additive\n- no mock change: test');
    const { OasdiffError } = await import('./oasdiff.mjs');
    const results = await runRules({ root, base: 'main', skip: ['table-owners', 'alembic'], oasdiffBin: async () => { throw new OasdiffError('wrong checksum, refusing to run'); } });
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(by['breaking[B]'].status, FAIL);
    assert.match(by['breaking[B]'].details[0], /wrong checksum/);
  } finally {
    cleanup(root);
  }
});
// ---- Base ref logic ---------------------------------------------------------------------------------------------------------------------
test('CRLF against LF is not a change', async () => {
  const { by } = await scenario((root) => write(root, 'contracts/a/a.md', read(root, 'contracts/a/a.md').replace(/\n/g, '\r\n')));
  assert.equal(by['contract[A]'].status, PASS);
});

test('changelog helpers', () => {
  const t = CHANGELOG;
  assert.deepEqual(sectionVersions(changelogSection(t, A)), [[0, 1, 0]]);
  assert.equal(changelogSection(t, 'Nope'), null);
  assert.deepEqual(addedLines(['a', 'b'], ['a', 'b', 'c', '', 'a']), ['c', 'a']);
});

// ---- Other rules: table owners, Alembic, COMPAT, bundle ---------------------------------------------------------------------------------
const run = async (mutate, customize) => {
  const root = makeRepo(customize);
  try {
    await mutate(root);
    const results = await runRules({ root, base: 'main', oasdiffBin });
    return Object.fromEntries(results.map((r) => [r.name, r]));
  } finally {
    cleanup(root);
  }
};

test('matrix: absent inputs (table owners, Alembic, COMPAT.md, bundle): NOT-APPLICABLE with the reason', async () => {
  const by = await run(() => {});
  assert.deepEqual(['table-owners', 'alembic', 'compat', 'bundle'].map((n) => by[n].status), [NA, NA, NA, NA]);
  assert.match(by['table-owners'].details[0], /contracts\/db\/table-owners\.yaml does not exist yet/);
  assert.match(by.alembic.details[0], /apps\/api\/migrations\/versions does not exist yet/);
  assert.match(by.compat.details[0], /contracts\/COMPAT\.md does not exist yet/);
  assert.match(by.bundle.details[0], /no bundle command/);
  const text = formatResults(Object.values(by));
  assert.match(text, /SUMMARY: \d+ PASS, 0 FAIL, \d+ NOT-APPLICABLE/);
  assert.match(text, /NOT-APPLICABLE: alembic: /);
});

const OWNERS_OK = `version: 1
tables:
  - table: users
    owner: accounts
  - table: events
    owner: ingest
`;
test('matrix: table owners present and valid: PASS; unknown owner, duplicate table, bad shape: FAIL naming the line', async () => {
  const ok = await run((root) => write(root, 'contracts/db/table-owners.yaml', OWNERS_OK));
  assert.equal(ok['table-owners'].status, PASS, ok['table-owners'].details.join('\n'));
  const unknown = await run((root) => write(root, 'contracts/db/table-owners.yaml', OWNERS_OK.replace('owner: ingest', 'owner: nobody')));
  assert.equal(unknown['table-owners'].status, FAIL);
  assert.match(unknown['table-owners'].details[0], /^line 6: unknown owner module `nobody`/);
  const dup = await run((root) => write(root, 'contracts/db/table-owners.yaml', OWNERS_OK + '  - table: users\n    owner: orgs\n'));
  assert.equal(dup['table-owners'].status, FAIL);
  assert.match(dup['table-owners'].details[0], /^line 7: duplicate table `users` \(first listed on line 3\)/);
  const shape = await run((root) => write(root, 'contracts/db/table-owners.yaml', 'version: 1\ntables:\n  - table: users\n'));
  assert.equal(shape['table-owners'].status, FAIL);
  assert.match(shape['table-owners'].details[0], /^line 3: bad shape/);
  const bad = await run((root) => write(root, 'contracts/db/table-owners.yaml', 'tables: [unclosed\n'));
  assert.equal(bad['table-owners'].status, FAIL);
  assert.match(bad['table-owners'].details[0], /not valid YAML/);
});

const migration = (rev, down) => `revision = '${rev}'\ndown_revision = ${down}\n\ndef upgrade():\n    pass\n`;
const versions = 'apps/api/migrations/versions';
test('matrix: Alembic present and linear: PASS; two heads, a branch, a duplicate revision, a missing parent: FAIL naming the revisions', async () => {
  const linear = (root) => { write(root, `${versions}/a1.py`, migration('aaa', 'None')); write(root, `${versions}/b1.py`, migration('bbb', "'aaa'")); };
  const ok = await run(linear);
  assert.equal(ok.alembic.status, PASS, ok.alembic.details.join('\n'));
  assert.match(ok.alembic.details[0], /one head bbb in 2 revisions/);
  const heads = await run((root) => { linear(root); write(root, `${versions}/c1.py`, migration('ccc', "'aaa'")); });
  const text = heads.alembic.details.join('\n');
  assert.equal(heads.alembic.status, FAIL);
  assert.match(text, /2 heads: bbb, ccc/);
  assert.ok(!/branch:/.test(text), 'an unmerged branch is reported as its heads, not twice');
  const dup = await run((root) => { linear(root); write(root, `${versions}/d1.py`, migration('bbb', "'aaa'")); });
  assert.match(dup.alembic.details.join('\n'), /duplicate revision bbb in b1\.py and d1\.py/);
  const missing = await run((root) => { linear(root); write(root, `${versions}/e1.py`, migration('eee', "'zzz'")); });
  assert.match(missing.alembic.details.join('\n'), /missing parent: revision eee \(e1\.py\) has down_revision zzz/);
  const merge = await run((root) => { linear(root); write(root, `${versions}/c1.py`, migration('ccc', "'aaa'")); write(root, `${versions}/m1.py`, migration('mmm', "('bbb', 'ccc')")); });
  assert.equal(merge.alembic.status, PASS, merge.alembic.details.join('\n'));
  assert.match(merge.alembic.details[0], /one head mmm in 4 revisions/);
  const extra = await run((root) => { linear(root); write(root, `${versions}/__init__.py`, ''); write(root, `${versions}/helpers.py`, 'X = 1\n'); });
  assert.equal(extra.alembic.status, PASS, extra.alembic.details.join('\n'));
  const bad = await run((root) => { linear(root); write(root, `${versions}/broken.py`, 'revision = (\n'); });
  assert.equal(bad.alembic.status, FAIL);
  assert.match(bad.alembic.details.join('\n'), /broken\.py: does not parse/);
});

const COMPAT = (rows) => `# Compatibility\n\n| Contract | Version | Owner |\n|---|---|---|\n${rows}\n`;
test('matrix: COMPAT.md present: valid rows PASS; a version that does not exist in the changelog or tags FAILs naming the row', async () => {
  const ok = await run((root) => write(root, 'contracts/COMPAT.md', COMPAT('| A | 0.1.0 | L |\n| B | contracts-v0.1.0 | L |')));
  assert.equal(ok.compat.status, PASS, ok.compat.details.join('\n'));
  const bad = await run((root) => write(root, 'contracts/COMPAT.md', COMPAT('| A | 0.1.0 | L |\n| B | 0.7.0 | L |')));
  assert.equal(bad.compat.status, FAIL);
  assert.match(bad.compat.details[0], /^line 6: B lists version 0\.7\.0/);
  const unknown = await run((root) => write(root, 'contracts/COMPAT.md', COMPAT('| Z | 0.1.0 | L |')));
  assert.match(unknown.compat.details[0], /contract "Z" is not in contracts\/registry\.json/);
  const tagged = await run((root) => { sh(root, 'tag', 'contracts-v0.7.0'); write(root, 'contracts/COMPAT.md', COMPAT('| B | 0.7.0 | L |')); });
  assert.equal(tagged.compat.status, PASS, 'a tag also counts');
  const empty = await run((root) => write(root, 'contracts/COMPAT.md', '# nothing\n'));
  assert.equal(empty.compat.status, FAIL);
});

test('matrix: bundle: no command and no file is NOT-APPLICABLE; a file without the command FAILs; the command decides when it exists', async () => {
  const none = await run(() => {});
  assert.equal(none.bundle.status, NA);
  const file = await run((root) => write(root, 'contracts/api/bundle/openapi.json', '{}\n'));
  assert.equal(file.bundle.status, FAIL);
  assert.match(file.bundle.details[0], /exists but package\.json has no script "contracts:bundle:check"/);
  const pkg = (cmd) => ({ name: 'x', scripts: { 'contracts:bundle:check': cmd } });
  const good = await run((root) => write(root, 'package.json', pkg('node -e "process.exit(0)"')));
  assert.equal(good.bundle.status, PASS);
  const stale = await run((root) => write(root, 'package.json', pkg('node -e "console.error(\'stale bundle\');process.exit(3)"')));
  assert.equal(stale.bundle.status, FAIL);
  assert.match(stale.bundle.details[0], /exited 3.*stale bundle/);
});

// ---- Command line, CI wiring ------------------------------------------------------------------------------------------------------------
test('command line: exit 1 and a summary line on a failure, exit 0 on a pass', async () => {
  const root = makeRepo();
  try {
    const ok = spawnSync(process.execPath, [SCRIPT, '--root', root, '--base', 'main'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /SUMMARY: \d+ PASS, 0 FAIL, 5 NOT-APPLICABLE|SUMMARY: \d+ PASS, 0 FAIL, \d+ NOT-APPLICABLE/);
    write(root, 'contracts/a/a.md', 'edited\n');
    const bad = spawnSync(process.execPath, [SCRIPT, '--root', root, '--base', 'main'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL\s+changelog\[A\]/);
    const noBase = spawnSync(process.execPath, [SCRIPT, '--root', root, '--base', 'origin/nope'], { encoding: 'utf8' });
    assert.equal(noBase.status, 1);
    assert.match(noBase.stdout, /FAIL\s+base: base ref origin\/nope does not exist/);
  } finally {
    cleanup(root);
  }
});

test('the real registry: every listed path exists and every folder under contracts/ is registered', async () => {
  const results = await runRules({ root: REPO_ROOT, base: 'HEAD', oasdiffBin, skip: ['table-owners', 'alembic'] });
  const reg = results.find((r) => r.name === 'registry');
  assert.equal(reg.status, PASS, reg.details.join('\n'));
});
// ---- Review batch 1: never fail open, nothing escapes, stricter entries ------------------------------------------------------------------
const commitAll = (root, msg) => { sh(root, 'add', '-A'); sh(root, 'commit', '-qm', msg); };
const addDefaults = (root) => { // the fixture without the schema file of A, for tests that need other base content
  void root;
};
void addDefaults;

test('base: a missing ref, an unrelated history and a shallow clone FAIL with "fetch the full history" and use no guess', async () => {
  assert.match(resolveBase(makeRepoNow(), { base: 'origin/main' }).error, /fetch the full history/);
  const root = makeRepo();
  try {
    sh(root, 'checkout', '-q', '--orphan', 'other');
    sh(root, 'rm', '-rfq', '--cached', '.');
    write(root, 'unrelated.txt', 'x\n');
    sh(root, 'add', 'unrelated.txt');
    sh(root, 'commit', '-qm', 'unrelated');
    const r = resolveBase(root, { base: 'main' });
    assert.match(r.error, /no merge base between main and HEAD.*fetch the full history/);
    assert.equal(r.sha, undefined, 'the tip of the ref is never used as the base');
    const results = await runRules({ root, base: 'main', oasdiffBin, skip: ['table-owners', 'alembic'] });
    assert.equal(results.find((x) => x.name === 'base').status, FAIL);
    assert.ok(!results.some((x) => x.name.startsWith('changelog[')), 'no contract check runs on an empty changed set');
  } finally {
    cleanup(root);
  }
});
function makeRepoNow() { const r = makeRepo(); process.on('exit', () => cleanup(r)); return r; }

test('base: GITHUB_BASE_REF is used and the default is origin/main (a tag does not replace the pull request base)', () => {
  const root = makeRepo();
  try {
    sh(root, 'tag', 'contracts-v0.9.0');
    assert.equal(latestTag(root), 'contracts-v0.9.0');
    assert.equal(resolveBase(root, { env: { GITHUB_BASE_REF: 'develop' } }).ref, 'origin/develop');
    assert.equal(resolveBase(root, { env: {} }).ref, 'origin/main');
    assert.equal(resolveBase(root, { base: 'main' }).ref, 'main');
    sh(root, 'tag', 'contracts-v0.10.0');
    sh(root, 'tag', 'contracts-v0.2.0');
    sh(root, 'tag', 'not-a-contract-tag');
    assert.equal(resolveTag(root).tag, 'contracts-v0.10.0', 'numeric, not alphabetical, order');
  } finally {
    cleanup(root);
  }
});

test('a moved schema shows its old path as deleted: breaking, even when the registry line moves with it', async () => {
  const { by, text } = await scenario((root) => {
    fs.renameSync(path.join(root, 'contracts/a/a.schema.json'), path.join(root, 'contracts/a/a2.schema.json'));
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts[0].schemas = ['contracts/a/a2.schema.json'];
    write(root, 'contracts/registry.json', r);
    addChangelog(root, A, '### 0.2.0\n- BREAKING: renamed the file.');
    touchMock(root, 'mock-a');
  });
  assert.equal(by['breaking[A]'].status, PASS, text); // declared
  assert.match(by['breaking[A]'].details.join('\n'), /contracts\/a\/a\.schema\.json: file removed/);
  const undeclared = await scenario((root) => {
    fs.renameSync(path.join(root, 'contracts/a/a.schema.json'), path.join(root, 'contracts/a/a2.schema.json'));
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts[0].schemas = ['contracts/a/a2.schema.json'];
    write(root, 'contracts/registry.json', r);
    addChangelog(root, A, '### 0.1.1\n- moved.\n- no mock change: x');
  });
  assert.equal(undeclared.by['breaking[A]'].status, FAIL);
});

test('a registered schema deleted together with its registry line is still breaking', async () => {
  const { by } = await scenario((root) => {
    fs.rmSync(path.join(root, 'contracts/a/a.schema.json'));
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts[0].schemas = [];
    write(root, 'contracts/registry.json', r);
    addChangelog(root, A, '### 0.1.1\n- removed.\n- no mock change: x');
  });
  assert.equal(by['breaking[A]'].status, FAIL);
  assert.match(by['breaking[A]'].details[0], /a\.schema\.json: file removed/);
});

test('a registry entry dropped from the head FAILs while its folder exists; with the folder gone too the entry itself passes but the deletion is breaking (D-46 a)', async () => {
  const dropB = (root) => { const r = JSON.parse(read(root, 'contracts/registry.json')); r.contracts = r.contracts.filter((c) => c.id !== 'B'); write(root, 'contracts/registry.json', r); };
  const kept = await scenario((root) => dropB(root));
  assert.equal(kept.by['registry-entry[B]'].status, FAIL);
  const gone = await scenario((root) => { dropB(root); fs.rmSync(path.join(root, 'contracts/b'), { recursive: true }); fs.rmSync(path.join(root, 'contracts/mocks/mock-b'), { recursive: true }); });
  assert.equal(gone.by['registry-entry[B]'].status, PASS);
  assert.match(gone.by['registry-entry[B]'].details[0], /removed together with its folders/);
  assert.equal(gone.by['breaking[B]'].status, FAIL, 'deleting a whole contract is breaking');
});

test('registry: an unlisted schema or OpenAPI file in a registered folder FAILs; a wrong shape is a clear FAIL, not a TypeError', async () => {
  const { by } = await scenario((root) => { write(root, 'contracts/a/extra.schema.json', { type: 'object' }); write(root, 'contracts/b/extra.openapi.yml', OPENAPI_B); });
  const d = by.registry.details.join('\n');
  assert.equal(by.registry.status, FAIL);
  assert.match(d, /contracts\/a\/extra\.schema\.json is a JSON Schema file that is not listed/);
  assert.match(d, /contracts\/b\/extra\.openapi\.yml is an OpenAPI file that is not listed/);
  const shape = await scenario((root) => { const r = JSON.parse(read(root, 'contracts/registry.json')); delete r.contracts[0].folders; delete r.reserved; write(root, 'contracts/registry.json', r); });
  assert.deepEqual(shape.results.map((r) => r.name), ['registry']);
  assert.match(shape.by.registry.details[0], /wrong shape.*"reserved" must be an array.*"folders" must be a non-empty array/);
  assert.ok(validateRegistry({ containers: [], reserved: [], generated: [], mockRoot: 'x', contracts: [{ id: 'Z', changelog: 'c', folders: ['f'], schemas: [], openapi: [], mocks: [], conformance: [] }] })[0].includes('noMock'));
});

test('dispatch is by the registry list, not by the file extension: a JSON Schema listed under schemas in a .yaml file is diffed as a schema', async () => {
  const body = JSON.stringify({ type: 'object', properties: { p: { type: 'string' } } });
  const { by } = await scenario((root) => {
    const s = JSON.parse(body); delete s.properties.p;
    write(root, 'contracts/a/extra.yaml', JSON.stringify(s));
    addChangelog(root, A, '### 0.1.1\n- x\n- no mock change: x');
  }, { customize: (root) => {
    write(root, 'contracts/a/extra.yaml', body);
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts[0].schemas.push('contracts/a/extra.yaml');
    write(root, 'contracts/registry.json', r);
  } });
  assert.equal(by['breaking[A]'].status, FAIL);
  assert.match(by['breaking[A]'].details[0], /^contracts\/a\/extra\.yaml #\/properties\/p: property removed/);
});

const oneX = (root) => { // base changelog of A at 1.2.0
  write(root, 'contracts/CHANGELOG.md', read(root, 'contracts/CHANGELOG.md').replace('### 0.1.0 (2026-10-01)\n- First draft.\n\n## Contract B', '### 1.2.0 (2026-10-01)\n- Stable.\n\n## Contract B'));
};
test('1.x base: a breaking change with a minor bump FAILs, with a major bump passes', async () => {
  const minor = await scenario((root) => breakA(root, '### 1.3.0 (2026-10-10)\n- BREAKING: removed `kind`.'), { customize: oneX });
  assert.equal(minor.by['breaking[A]'].status, FAIL);
  assert.match(minor.by['breaking[A]'].details.join('\n'), /by a major step/);
  const major = await scenario((root) => breakA(root, '### 2.0.0 (2026-10-10)\n- BREAKING: removed `kind`.'), { customize: oneX });
  assert.equal(major.by['breaking[A]'].status, PASS, major.text);
});

test('malformed JSON on the base side or on the head side FAILs with "could not be compared"', async () => {
  const head = await scenario((root) => { write(root, 'contracts/a/a.schema.json', '{ not json'); addChangelog(root, A, '### 0.1.1\n- x\n- no mock change: x'); });
  assert.equal(head.by['breaking[A]'].status, FAIL);
  assert.match(head.by['breaking[A]'].details[0], /a\.schema\.json: could not be compared/);
  const baseSide = await scenario((root) => { write(root, 'contracts/a/a.schema.json', SCHEMA_A); addChangelog(root, A, '### 0.1.1\n- x\n- no mock change: x'); }, { customize: (root) => write(root, 'contracts/a/a.schema.json', '{ not json') });
  assert.equal(baseSide.by['breaking[A]'].status, FAIL);
  assert.match(baseSide.by['breaking[A]'].details[0], /could not be compared/);
});

test('breaking since the latest tag needs a raised version over the tag (a major step from 1.0.0), even when the pull request base is newer', async () => {
  const build = async (c2Version, headVersion) => {
    const root = makeRepo(oneX);
    try {
      sh(root, 'tag', 'contracts-v1.2.0');
      const s = JSON.parse(read(root, 'contracts/a/a.schema.json'));
      delete s.properties.kind;
      write(root, 'contracts/a/a.schema.json', s);
      addChangelog(root, A, `### ${c2Version} (2026-10-10)\n- BREAKING: removed kind.`);
      touchMock(root, 'mock-a');
      commitAll(root, 'breaking on main');
      addChangelog(root, A, `### ${headVersion} (2026-10-11)\n- Additive note.`);
      write(root, 'contracts/a/a.md', '# A edited\n');
      const results = await runRules({ root, base: 'main', oasdiffBin, skip: ['table-owners', 'alembic'] });
      return Object.fromEntries(results.map((r) => [r.name, r]));
    } finally {
      cleanup(root);
    }
  };
  const bad = await build('1.3.0', '1.4.0');
  assert.equal(bad['breaking[A]'].status, PASS, 'nothing breaking in this pull request itself');
  assert.equal(bad['breaking-since-tag[A]'].status, FAIL);
  assert.match(bad['breaking-since-tag[A]'].details.join('\n'), /schema\.json #\/properties\/kind.*major step/s);
  const good = await build('2.0.0', '2.1.0');
  assert.equal(good['breaking-since-tag[A]'].status, PASS, good['breaking-since-tag[A]'].details.join('\n'));
});

test('changelog: a renamed heading FAILs; editing an old entry is not a new entry; BREAKING and the waiver must sit in the new entry', async () => {
  const renamed = await scenario((root) => { write(root, 'contracts/a/a.md', 'x\n'); write(root, 'contracts/CHANGELOG.md', read(root, 'contracts/CHANGELOG.md').replace('## Contract A,', '## Contract A renamed,')); });
  assert.equal(renamed.by['changelog[A]'].status, FAIL);
  assert.match(renamed.by['changelog[A]'].details[0], /existed in the base but .* is missing now/);
  const edited = await scenario((root) => { write(root, 'contracts/a/a.md', 'x\n'); write(root, 'contracts/CHANGELOG.md', read(root, 'contracts/CHANGELOG.md').replace('- First draft.', '- First draft, reworded.')); });
  assert.equal(edited.by['changelog[A]'].status, FAIL);
  assert.match(edited.by['changelog[A]'].details[0], /no newly added entry heading/);
  const oldMarker = await scenario((root) => {
    write(root, 'contracts/CHANGELOG.md', read(root, 'contracts/CHANGELOG.md').replace('- First draft.', '- First draft. BREAKING no mock change: old'));
    breakA(root, '### 0.2.0 (2026-10-10)\n- removed `kind`.');
    fs.writeFileSync(path.join(root, 'contracts/mocks/mock-a/server.mjs'), '// mock a\n'); // mock untouched again
  });
  assert.equal(oldMarker.by['breaking[A]'].status, FAIL);
  assert.match(oldMarker.by['breaking[A]'].details.join('\n'), /marked BREAKING in the new entry/);
  assert.equal(oldMarker.by['mock[A]'].status, FAIL, 'a waiver in an old entry does not count');
  assert.equal(newEntries(['### 0.1.0', '- a'], ['### 0.1.0', '- a', '### 0.2.0', '- b']).length, 1);
});

test('mock rule: a whitespace-only edit, a test file or a Markdown file under the mock path does not count; code does', async () => {
  const edit = (root) => { const s = JSON.parse(read(root, 'contracts/a/a.schema.json')); s.properties.extra = { type: 'string' }; write(root, 'contracts/a/a.schema.json', s); addChangelog(root, A, '### 0.1.1\n- additive'); };
  const ws = await scenario((root) => { edit(root); write(root, 'contracts/mocks/mock-a/server.mjs', '//   mock   a\n\n'); });
  assert.equal(ws.by['mock[A]'].status, FAIL, 'whitespace only');
  const tst = await scenario((root) => { edit(root); write(root, 'contracts/mocks/mock-a/server.test.mjs', '// new test\n'); });
  assert.equal(tst.by['mock[A]'].status, FAIL, 'test file');
  const md = await scenario((root) => { edit(root); write(root, 'contracts/mocks/mock-a/README.md', '# doc\n'); });
  assert.equal(md.by['mock[A]'].status, FAIL, 'markdown');
  const code = await scenario((root) => { edit(root); write(root, 'contracts/mocks/mock-a/server.mjs', '// mock a, new route\n'); });
  assert.equal(code.by['mock[A]'].status, PASS);
});

test('a contract with no mock by design says so instead of NOT-APPLICABLE', async () => {
  const { by } = await scenario((root) => { const s = JSON.parse(read(root, 'contracts/db/table-owners.schema.json')); s.title = 'x'; s.properties.extra = { type: 'string' }; write(root, 'contracts/db/table-owners.schema.json', s); addChangelog(root, 'Table owners, `contracts/db/`', '### 0.1.1\n- additive'); });
  assert.equal(by['mock[DB]'].status, PASS);
  assert.match(by['mock[DB]'].details[0], /^no mock by design: /);
});

test('NOT-APPLICABLE cannot hide a deleted input: table owners, Alembic, COMPAT.md and the bundle command that existed in the base FAIL', async () => {
  const by = await run((root) => {
    fs.rmSync(path.join(root, 'contracts/db/table-owners.yaml'));
    fs.rmSync(path.join(root, 'apps/api/migrations'), { recursive: true });
    fs.rmSync(path.join(root, 'contracts/COMPAT.md'));
    write(root, 'package.json', { name: 'x', scripts: {} });
  }, (root) => {
    write(root, 'contracts/db/table-owners.yaml', OWNERS_OK);
    write(root, 'apps/api/migrations/versions/a1.py', migration('aaa', 'None'));
    write(root, 'contracts/COMPAT.md', COMPAT('| A | 0.1.0 | L |'));
    write(root, 'package.json', { name: 'x', scripts: { 'contracts:bundle:check': 'node -e "process.exit(0)"' } });
  });
  for (const n of ['table-owners', 'alembic', 'compat', 'bundle']) {
    assert.equal(by[n].status, FAIL, n);
    assert.match(by[n].details[0], /existed in main and is missing now/, n);
  }
});

test('timeouts name the check; a missing uv FAILs instead of falling back to a bare python', () => {
  assert.throws(() => spawn('check hung', process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {}, 200), /check hung did not finish within 0\.2 s/);
  const saved = process.env.PATH;
  try {
    process.env.PATH = '';
    const r = runPythonCheck('alembic', 'check_alembic_head.py', REPO_ROOT);
    assert.equal(r.status, FAIL);
    assert.match(r.details[0], /needs uv/);
  } finally {
    process.env.PATH = saved;
  }
});

test('COMPAT.md parser: bold and backticks in cells, a header called "Contract ID", separator and alignment rows', async () => {
  const text = '# C\n\n| **Contract ID** | Version | Owner |\n|:---|:---:|---|\n| `A` | **0.1.0** | L |\n| B | `contracts-v0.1.0` | L |\n';
  const by = await run((root) => write(root, 'contracts/COMPAT.md', text));
  assert.equal(by.compat.status, PASS, by.compat.details.join('\n'));
});
test('table owners: CODEOWNERS paths without the leading slash or with tabs, a module folder that does not exist, a missing CODEOWNERS, a repeated YAML key', async () => {
  const yaml = (root) => write(root, 'contracts/db/table-owners.yaml', OWNERS_OK);
  const loose = await run((root) => { yaml(root); write(root, '.github/CODEOWNERS', '*  @a\napps/api/src/vulnmart/accounts\t@a\n/apps/api/src/vulnmart/ingest/\t\t@b\n'); });
  assert.equal(loose['table-owners'].status, PASS, loose['table-owners'].details.join('\n'));
  const nofolder = await run((root) => { yaml(root); fs.rmSync(path.join(root, 'apps/api/src/vulnmart/ingest'), { recursive: true }); });
  assert.equal(nofolder['table-owners'].status, FAIL);
  assert.match(nofolder['table-owners'].details[0], /^line 6: unknown owner module `ingest`.*in CODEOWNERS without a folder: .*\bingest\b/);
  const nocode = await run((root) => { yaml(root); fs.rmSync(path.join(root, '.github/CODEOWNERS')); });
  assert.equal(nocode['table-owners'].status, FAIL);
  assert.match(nocode['table-owners'].details[0], /CODEOWNERS does not exist/);
  const dupKey = await run((root) => write(root, 'contracts/db/table-owners.yaml', 'version: 1\ntables:\n  - table: users\n    owner: accounts\n    owner: orgs\n'));
  assert.equal(dupKey['table-owners'].status, FAIL);
  assert.match(dupKey['table-owners'].details[0], /^line 5: not valid YAML \(duplicate key 'owner'\)/);
});
// ---- D-46 (stories 1.15): the rules engine must not be weakenable by the pull request it grades ---------------------------------------------
test('D-46 d: the exact BREAKING marker: a bullet line "BREAKING: <reason>", case-sensitive, no negation', () => {
  assert.equal(isBreakingMarker('- BREAKING: removed field x'), true);
  assert.equal(isBreakingMarker('* BREAKING: no longer accepts y'), true);
  assert.equal(isBreakingMarker('- no BREAKING changes'), false);
  assert.equal(isBreakingMarker('- not BREAKING'), false);
  assert.equal(isBreakingMarker('- breaking: x'), false);
  assert.equal(isBreakingMarker('BREAKING: removed field x'), false, 'a bullet is required');
  assert.equal(isBreakingMarker('- BREAKING:'), false, 'a reason is required');
  assert.equal(isBreakingMarker('- BREAKING: none'), false);
  assert.equal(isBreakingMarker('- First draft. BREAKING no mock change: old'), false);
});

test('D-46 d: a loose BREAKING word in the new entry no longer declares a breaking change', async () => {
  for (const line of ['- no BREAKING changes', '- not BREAKING', '- breaking: removed kind']) {
    const { by } = await scenario((root) => breakA(root, `### 0.2.0 (2026-10-10)\n${line}`));
    assert.equal(by['breaking[A]'].status, FAIL, line);
  }
});

const dropContract = (root, id, { files = true } = {}) => {
  const r = JSON.parse(read(root, 'contracts/registry.json'));
  r.contracts = r.contracts.filter((c) => c.id !== id);
  write(root, 'contracts/registry.json', r);
  if (files) { fs.rmSync(path.join(root, 'contracts/b'), { recursive: true }); fs.rmSync(path.join(root, 'contracts/mocks/mock-b'), { recursive: true }); }
};

test('D-46 a: deleting a whole contract is breaking: FAIL without a raised version and BREAKING:, PASS with both', async () => {
  const none = await scenario((root) => dropContract(root, 'B'));
  assert.equal(none.by['breaking[B]'].status, FAIL, none.text);
  assert.match(none.by['breaking[B]'].details.join('\n'), /b\.openapi\.yaml: file removed/);
  const noBump = await scenario((root) => { dropContract(root, 'B'); addChangelog(root, B, '### 0.1.0 again\n- BREAKING: removed contract B.'); });
  assert.equal(noBump.by['breaking[B]'].status, FAIL, 'version not raised');
  const noMarker = await scenario((root) => { dropContract(root, 'B'); addChangelog(root, B, '### 0.2.0 (2026-10-10)\n- removed contract B.'); });
  assert.equal(noMarker.by['breaking[B]'].status, FAIL, 'marker missing');
  const ok = await scenario((root) => { dropContract(root, 'B'); addChangelog(root, B, '### 0.2.0 (2026-10-10)\n- BREAKING: removed contract B.'); });
  assert.equal(ok.by['breaking[B]'].status, PASS, ok.text);
  assert.equal(ok.by['registry-entry[B]'].status, PASS);
  const gone = await scenario((root) => { dropContract(root, 'B'); write(root, 'contracts/CHANGELOG.md', read(root, 'contracts/CHANGELOG.md').replace(/## Contract B[\s\S]*?(?=## Table)/, '')); });
  assert.equal(gone.by['breaking[B]'].status, FAIL, 'a section removed with the contract leaves no declaration');
});

test('D-46 a: a rename or a merge is not a deletion only when another entry lists the same files', async () => {
  const rename = await scenario((root) => {
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts.find((c) => c.id === 'B').id = 'B2';
    write(root, 'contracts/registry.json', r);
  });
  assert.equal(rename.by['breaking[B]'].status, PASS, rename.text);
  assert.match(rename.by['breaking[B]'].details[0], /listed by another entry/);
  assert.equal(rename.by['registry-entry[B]'].status, PASS);
  const merge = await scenario((root) => {
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    r.contracts = r.contracts.filter((c) => c.id !== 'B');
    const a = r.contracts.find((c) => c.id === 'A');
    a.folders.push('contracts/b');
    a.openapi.push('contracts/b/b.openapi.yaml');
    a.mocks.push('contracts/mocks/mock-b');
    write(root, 'contracts/registry.json', r);
  });
  assert.equal(merge.by['breaking[B]'].status, PASS, merge.text);
  const otherFiles = await scenario((root) => {
    const r = JSON.parse(read(root, 'contracts/registry.json'));
    const b = r.contracts.find((c) => c.id === 'B');
    b.id = 'B2';
    b.openapi = ['contracts/b/other.openapi.yaml'];
    write(root, 'contracts/registry.json', r);
    write(root, 'contracts/b/other.openapi.yaml', OPENAPI_B);
    fs.rmSync(path.join(root, 'contracts/b/b.openapi.yaml'));
  });
  assert.equal(otherFiles.by['breaking[B]'].status, FAIL, otherFiles.text);
  assert.match(otherFiles.by['breaking[B]'].details.join('\n'), /b\.openapi\.yaml: file removed/);
});

test('D-46 e: unlisted .json and .yaml files in a contract folder are compared too (examples are not)', async () => {
  const custom = (root) => {
    write(root, 'contracts/a/data.json', { type: 'object', properties: { p: { type: 'string' } } });
    write(root, 'contracts/a/notes.yaml', 'a: 1\n');
    write(root, 'contracts/a/examples/ok.json', { p: 1 });
  };
  const del = await scenario((root) => { fs.rmSync(path.join(root, 'contracts/a/data.json')); addChangelog(root, A, '### 0.1.1\n- x\n- no mock change: x'); }, { customize: custom });
  assert.equal(del.by['breaking[A]'].status, FAIL);
  assert.match(del.by['breaking[A]'].details[0], /data\.json: file removed/);
  const edit = await scenario((root) => { write(root, 'contracts/a/data.json', { type: 'object', properties: {} }); addChangelog(root, A, '### 0.1.1\n- x\n- no mock change: x'); }, { customize: custom });
  assert.match(edit.by['breaking[A]'].details[0], /data\.json #\/properties\/p: property removed/);
  const yaml = await scenario((root) => { write(root, 'contracts/a/notes.yaml', 'a: 2\n'); addChangelog(root, A, '### 0.1.1\n- x\n- no mock change: x'); }, { customize: custom });
  assert.match(yaml.by['breaking[A]'].details[0], /unlisted YAML file changed/);
  const example = await scenario((root) => { write(root, 'contracts/a/examples/ok.json', { p: 2 }); addChangelog(root, A, '### 0.1.1\n- x\n- no mock change: x'); }, { customize: custom });
  assert.equal(example.by['breaking[A]'].status, PASS, 'examples are data, not contract text');
});

test('D-46 e: a tag baseline that never runs prints a NOTICE', async () => {
  const none = await scenario(() => {});
  assert.match(none.by.base.details.join('\n'), /NOTICE: no tag contracts-v\*/);
});

// ---- trusted mode ------------------------------------------------------------------------------------------------------------------------
const trusted = { trusted: true };
const editRegistry = (root, fn) => { const r = JSON.parse(read(root, 'contracts/registry.json')); fn(r); write(root, 'contracts/registry.json', r); };

test('D-46 b: trusted mode reports any change to the registry, the checker, the diff scripts, the pins or the workflows unless "registry change:" is declared', async () => {
  assert.ok(['contracts/registry.json', 'scripts/check-contract-rules.mjs', 'scripts/schema-diff.mjs', 'scripts/oasdiff.mjs', 'tools/oasdiff.json', '.github/workflows/ci.yml'].every(isGuarded));
  assert.equal(isGuarded('contracts/a/a.md'), false);
  assert.equal(REGISTRY_CHANGE_LINE.test('- registry change: new mock folder'), true);
  assert.equal(REGISTRY_CHANGE_LINE.test('- no registry change'), false);
  assert.equal(REGISTRY_CHANGE_LINE.test('- registry change:'), false);
  const clean = await scenario(() => {}, { opts: trusted });
  assert.equal(clean.by['trusted-base'].status, PASS);
  for (const [name, mutate] of Object.entries({
    registry: (root) => editRegistry(root, (r) => { r.contracts[0].owner = 'X'; }),
    'checker': (root) => write(root, 'scripts/check-contract-rules.mjs', '// weakened\n'),
    workflow: (root) => write(root, '.github/workflows/ci.yml', 'name: x\n'),
    pin: (root) => write(root, 'tools/oasdiff.json', '{}\n'),
  })) {
    const bad = await scenario(mutate, { opts: trusted });
    assert.equal(bad.by['trusted-base'].status, FAIL, name);
    assert.match(bad.by['trusted-base'].details[0], /registry change:/, name);
    const declared = await scenario((root) => { mutate(root); addChangelog(root, A, '### 0.1.1\n- registry change: test reason'); }, { opts: trusted });
    assert.equal(declared.by['trusted-base'].status, PASS, name);
  }
});

test('D-46 b: in trusted mode the base registry is the authority: a decoy mock, a reserved folder and a dropped noMock do not weaken the rules', async () => {
  // a breaking change in A, "mock updated" only in a decoy folder that the pull request added to the registry
  const decoy = await scenario((root) => {
    editRegistry(root, (r) => { r.contracts[0].mocks = ['contracts/mocks/decoy']; });
    write(root, 'contracts/mocks/decoy/server.mjs', '// decoy\n');
    const s = JSON.parse(read(root, 'contracts/a/a.schema.json')); s.properties.extra = { type: 'string' }; write(root, 'contracts/a/a.schema.json', s);
    addChangelog(root, A, '### 0.2.0 (2026-10-10)\n- additive\n- registry change: moved the mock');
  }, { opts: trusted });
  assert.equal(decoy.by['mock[A]'].status, FAIL, decoy.text);
  assert.match(decoy.by['mock[A]'].details[0], /contracts\/mocks\/mock-a/);
  // the same run without trusted mode is fooled by the decoy, which is exactly what trusted mode prevents
  const plain = await scenario((root) => {
    editRegistry(root, (r) => { r.contracts[0].mocks = ['contracts/mocks/decoy']; });
    write(root, 'contracts/mocks/decoy/server.mjs', '// decoy\n');
    const s = JSON.parse(read(root, 'contracts/a/a.schema.json')); s.properties.extra = { type: 'string' }; write(root, 'contracts/a/a.schema.json', s);
    addChangelog(root, A, '### 0.2.0 (2026-10-10)\n- additive');
  });
  assert.equal(plain.by['mock[A]'].status, PASS);
  // a folder the pull request declares "reserved" is still unregistered
  const reserved = await scenario((root) => {
    editRegistry(root, (r) => { r.reserved.push('contracts/rogue'); });
    write(root, 'contracts/rogue/x.txt', 'x\n');
  }, { opts: trusted });
  assert.equal(reserved.by.registry.status, FAIL);
  assert.match(reserved.by.registry.details.join('\n'), /contracts\/rogue/);
  // effectiveRegistry in isolation: base noMock and rules win, head-only entries are kept
  const eff = effectiveRegistry(
    { ...REGISTRY, reserved: ['x'], contracts: [{ ...REGISTRY.contracts[2], noMock: 'no mock by design: head', mocks: [] }, { id: 'N', changelog: 'n', folders: ['contracts/n'], schemas: [], openapi: [], mocks: [], noMock: 'no mock by design: y', conformance: [] }] },
    REGISTRY, os.tmpdir());
  assert.deepEqual(eff.reserved, REGISTRY.reserved);
  assert.equal(eff.contracts[0].noMock, REGISTRY.contracts[2].noMock);
  assert.equal(eff.contracts[1].id, 'N');
});

test('D-46 b: trusted mode refuses a checker or a pin file that lives inside the head tree, unless this is the declared bootstrap run', async () => {
  const root = makeRepo();
  try {
    const inside = await runRules({ root, base: 'main', oasdiffBin, skip: ['table-owners', 'alembic'], trusted: true, checkerRoot: root });
    assert.equal(inside.length, 1);
    assert.equal(inside[0].status, FAIL);
    assert.match(inside[0].details[0], /inside the tree it grades/);
    const pins = await runRules({ root, base: 'main', oasdiffBin, skip: ['table-owners', 'alembic'], trusted: true, tools: path.join(root, 'tools', 'oasdiff.json') });
    assert.equal(pins[0].status, FAIL);
    assert.match(pins[0].details[0], /pin file .* inside the head tree/);
    const boot = await runRules({ root, base: 'main', oasdiffBin, skip: ['table-owners', 'alembic'], trusted: true, bootstrap: true, checkerRoot: root });
    const base = boot.find((r) => r.name === 'base');
    assert.equal(base.status, PASS);
    assert.match(base.details.join('\n'), /NOTICE: bootstrap run/);
  } finally {
    cleanup(root);
  }
});

test('D-46 b: --untrusted-only runs only the checks that execute head code; trusted mode does not run them', async () => {
  const root = makeRepo();
  try {
    const only = await runRules({ root, base: 'main', skip: ['table-owners', 'alembic'], untrustedOnly: true });
    assert.deepEqual(only.map((r) => r.name), ['bundle']);
    const t = await runRules({ root, base: 'main', oasdiffBin, trusted: true });
    assert.ok(!t.some((r) => ['table-owners', 'alembic', 'bundle'].includes(r.name)), t.map((r) => r.name).join(','));
    assert.match(t.find((r) => r.name === 'base').details.join('\n'), /contract-rules-untrusted/);
  } finally {
    cleanup(root);
  }
});

test('D-46 b: the CLI accepts --root, --base and --tools, and refuses to grade the tree it runs from in trusted mode', () => {
  const root = makeRepo();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--base', 'main', '--tools', path.join(root, 'tools', 'oasdiff.json')], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL\s+trusted-base: .*pin file/);
    const ok = spawnSync(process.execPath, [SCRIPT, '--root', root, '--base', 'main', '--tools', path.join(REPO_ROOT, 'tools', 'oasdiff.json')], { encoding: 'utf8', timeout: 300_000 });
    assert.match(ok.stdout, /trusted-base: the registry, the checker/, ok.stdout + ok.stderr);
  } finally {
    cleanup(root);
  }
});