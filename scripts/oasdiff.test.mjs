import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureOasdiff, runOasdiff, interpretResult, defaultDownload, SEVERITY_FILE, ERR_LEVEL, loadConfig, platformKey, binaryDir, sha256, compareVersions, OasdiffError, FIXED_FLAGS, ROOT } from './oasdiff.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vm-od-'));
const config = loadConfig();
const key = platformKey();

test('the pin: exact version above the advisory floors, a checksum for every platform, license', () => {
  assert.match(config.version, /^\d+\.\d+\.\d+$/);
  assert.ok(compareVersions(config.version, '1.26.1') > 0, 'above 1.26.1');
  assert.ok(compareVersions(config.version, '1.18.1') > 0, 'above 1.18.1');
  assert.equal(config.license, 'Apache-2.0');
  for (const [k, p] of Object.entries(config.platforms)) {
    assert.match(p.archiveSha256, /^[0-9a-f]{64}$/, k);
    assert.match(p.binarySha256, /^[0-9a-f]{64}$/, k);
    assert.ok(p.asset.includes(config.version), k);
  }
  assert.ok(config.downloadBase.includes(`v${config.version}`));
});

test('the fixed flags are the decided ones', () => {
  assert.deepEqual(FIXED_FLAGS, ['--allow-external-refs=false', '--fail-on', 'ERR', '--severity-levels', SEVERITY_FILE]);
});

test('the binary folder is git-ignored and nothing under tools/.bin is tracked', () => {
  const ignored = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', 'tools/.bin/x'], { encoding: 'utf8' });
  assert.equal(ignored.status, 0);
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', 'tools/.bin'], { encoding: 'utf8' });
  assert.equal(tracked.stdout.trim(), '');
});

test('a download whose checksum differs from the pin is refused and nothing is installed', async () => {
  const bin = tmp();
  try {
    await assert.rejects(ensureOasdiff({ binRoot: bin, download: async () => Buffer.from('not the real archive') }), (e) => e instanceof OasdiffError && /expected the pinned/.test(e.message));
    assert.ok(!fs.existsSync(binaryDir(config, key, bin)), 'no binary folder written');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('an archive that matches the pin but is not listed by the release checksums file is refused', async () => {
  const fake = Buffer.from('archive bytes');
  const cfg = structuredClone(config);
  cfg.platforms[key].archiveSha256 = sha256(fake);
  const bin = tmp();
  try {
    const download = async (url) => (url.endsWith(config.checksumsFile) ? Buffer.from(`${'0'.repeat(64)}  ${cfg.platforms[key].asset}\n`) : fake);
    await assert.rejects(ensureOasdiff({ config: cfg, binRoot: bin, download }), /does not list/);
    assert.ok(!fs.existsSync(binaryDir(cfg, key, bin)));
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('a binary missing from disk and a download that fails is an error, never a pass', async () => {
  const bin = tmp();
  try {
    await assert.rejects(ensureOasdiff({ binRoot: bin, download: async () => { throw new OasdiffError('offline'); } }), /offline/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('a binary with the wrong checksum is never run', async () => {
  const bin = tmp();
  try {
    const dir = binaryDir(config, key, bin);
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, config.platforms[key].binary);
    fs.writeFileSync(exe, 'echo tampered');
    await assert.rejects(ensureOasdiff({ binRoot: bin, download: async () => assert.fail('must not download over a present binary') }), /refusing to run it/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('a pin at or below the advisory floor is refused', async () => {
  await assert.rejects(ensureOasdiff({ config: { ...config, version: '1.26.1' } }), /advisory floor/);
});

test('the real binary: downloaded, verified against both pins, reports the pinned version', async () => {
  const bin = await ensureOasdiff();
  assert.equal(sha256(fs.readFileSync(bin)), config.platforms[key].binarySha256);
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  assert.match(v.stdout, new RegExp(config.version.replace(/\./g, '\\.')));
});

const SPEC = `openapi: 3.1.0
info: { title: t, version: 1.0.0 }
paths:
  /a:
    get:
      operationId: getA
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: object, required: [x], properties: { x: { type: string } } }
`;

test('runOasdiff: identical specs pass; a removed response property is ERR; an unreadable spec is an error', async () => {
  const bin = await ensureOasdiff();
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.yaml'), SPEC);
    fs.writeFileSync(path.join(dir, 'b.yaml'), SPEC.replace('required: [x], properties: { x: { type: string } }', 'required: [], properties: { y: { type: string } }'));
    fs.writeFileSync(path.join(dir, 'bad.yaml'), 'openapi: [unclosed');
    assert.deepEqual(runOasdiff(bin, path.join(dir, 'a.yaml'), path.join(dir, 'a.yaml')).breaking, []);
    const res = runOasdiff(bin, path.join(dir, 'a.yaml'), path.join(dir, 'b.yaml'));
    assert.ok(res.breaking.length >= 1);
    assert.equal(res.breaking[0].path, '/a');
    assert.throws(() => runOasdiff(bin, path.join(dir, 'a.yaml'), path.join(dir, 'bad.yaml')), OasdiffError);
    assert.throws(() => runOasdiff(bin, path.join(dir, 'missing.yaml'), path.join(dir, 'a.yaml')), OasdiffError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an external $ref is not followed (--allow-external-refs=false)', async () => {
  const bin = await ensureOasdiff();
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'ext.yaml'), SPEC.replace('{ type: object, required: [x], properties: { x: { type: string } } }', '{ $ref: "other.yaml#/Thing" }'));
    fs.writeFileSync(path.join(dir, 'other.yaml'), 'Thing: { type: string }\n');
    assert.throws(() => runOasdiff(bin, path.join(dir, 'ext.yaml'), path.join(dir, 'ext.yaml')), OasdiffError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('our two OpenAPI 3.1 files are read by oasdiff and compare clean with themselves', async () => {
  const bin = await ensureOasdiff();
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['contracts/orchestrator/orchestrator.openapi.yaml', 'contracts/api/lab/lab.openapi.yaml']) {
    assert.deepEqual(runOasdiff(bin, path.join(here, f), path.join(here, f)).breaking, [], f);
  }
});

// ---- Review batch 2 ----------------------------------------------------------------------------------------------------------------------
const OPTIONAL_SPEC = SPEC.replace('required: [x], ', '');

test('severity: removing an optional response property, a response enum value or a request property fails (the CHANGELOG rule says removal is breaking)', async () => {
  const bin = await ensureOasdiff();
  const dir = tmp();
  try {
    const cases = {
      'optional response property': [OPTIONAL_SPEC, OPTIONAL_SPEC.replace('x: { type: string }', 'y: { type: string }'), 'response-optional-property-removed'],
      'response enum value': [OPTIONAL_SPEC.replace('x: { type: string }', 'x: { enum: [a, b] }'), OPTIONAL_SPEC.replace('x: { type: string }', 'x: { enum: [a] }'), 'response-property-enum-value-removed'],
    };
    for (const [name, [a, b, id]] of Object.entries(cases)) {
      fs.writeFileSync(path.join(dir, 'a.yaml'), a);
      fs.writeFileSync(path.join(dir, 'b.yaml'), b);
      const res = runOasdiff(bin, path.join(dir, 'a.yaml'), path.join(dir, 'b.yaml'));
      assert.ok(res.breaking.some((c) => c.id === id), `${name}: ${JSON.stringify(res.breaking)}`);
    }
    // without the severity file the first case would pass: the file is what makes it fail
    fs.writeFileSync(path.join(dir, 'a.yaml'), OPTIONAL_SPEC);
    fs.writeFileSync(path.join(dir, 'b.yaml'), OPTIONAL_SPEC.replace('x: { type: string }', 'y: { type: string }'));
    const plain = spawnSync(bin, ['breaking', path.join(dir, 'a.yaml'), path.join(dir, 'b.yaml'), '--fail-on', 'ERR'], { encoding: 'utf8' });
    assert.equal(plain.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the severity file lists only checks that exist in the pinned oasdiff, one "id err" per line', async () => {
  const bin = await ensureOasdiff();
  const lines = fs.readFileSync(SEVERITY_FILE, 'utf8').trim().split('\n');
  const known = JSON.parse(spawnSync(bin, ['checks', 'changelog', '-f', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout).map((c) => c.id);
  assert.ok(lines.length >= 5);
  for (const l of lines) {
    const [id, level] = l.split(' ');
    assert.equal(level, 'err', l);
    assert.ok(known.includes(id), `${id} is a check of oasdiff ${config.version}`);
  }
});

test('interpretResult: a non-list JSON, bad JSON, an exit 1 without ERR and other exit codes are OasdiffErrors', () => {
  assert.throws(() => interpretResult({ status: 1, stdout: '{"a":1}' }), (e) => e instanceof OasdiffError && /not a list/.test(e.message));
  assert.throws(() => interpretResult({ status: 1, stdout: 'null' }), OasdiffError);
  assert.throws(() => interpretResult({ status: 1, stdout: 'nope' }), /not JSON/);
  assert.throws(() => interpretResult({ status: 1, stdout: '[{"id":"x","level":2}]' }), /without an ERR/);
  assert.throws(() => interpretResult({ status: 100, stderr: 'bad spec' }), /exited 100/);
  assert.throws(() => interpretResult({ error: new Error('ETIMEDOUT') }), /could not run/);
  assert.equal(interpretResult({ status: 1, stdout: `[{"id":"x","level":${ERR_LEVEL},"text":"t","path":"/p","operation":"GET"}]` }).breaking[0].id, 'x');
  assert.equal(interpretResult({ status: 0, stdout: '[]' }).breaking.length, 0);
});

test('download: a 60 s limit per try and two retries; the third failure is an OasdiffError', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw new Error('reset'); return { ok: true, arrayBuffer: async () => new TextEncoder().encode('ok').buffer }; };
  assert.equal((await defaultDownload('https://x.invalid/a', { fetchImpl: flaky })).toString(), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(defaultDownload('https://x.invalid/a', { fetchImpl: async () => { calls++; throw new Error('down'); } }), (e) => e instanceof OasdiffError && /after 3 tries: down/.test(e.message));
  assert.equal(calls, 3);
  const slow = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted by the timeout'))));
  await assert.rejects(defaultDownload('https://x.invalid/a', { fetchImpl: slow, timeoutMs: 30, retries: 1 }), /after 2 tries: aborted/);
  assert.equal((await defaultDownload('https://x.invalid/b', { fetchImpl: async () => ({ ok: false, status: 503 }), retries: 0 }).catch((e) => e.message)).includes('HTTP 503'), true);
});

test('install is atomic: two parallel installs both end with the verified binary and no partial file is left', async () => {
  const work = tmp();
  const bin = tmp();
  try {
    const name = process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff';
    fs.writeFileSync(path.join(work, name), 'fake binary '.repeat(1000));
    const asset = 'fake_1.0.0.tar.gz';
    const made = spawnSync('tar', ['-czf', asset, name], { cwd: work, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const archive = fs.readFileSync(path.join(work, asset));
    const cfg = structuredClone(config);
    cfg.platforms[key] = { asset, archiveSha256: sha256(archive), binary: name, binarySha256: sha256(fs.readFileSync(path.join(work, name))) };
    const download = async (url) => (url.endsWith(cfg.checksumsFile) ? Buffer.from(`${cfg.platforms[key].archiveSha256}  ${asset}\n`) : archive);
    const [a, b] = await Promise.all([ensureOasdiff({ config: cfg, binRoot: bin, download }), ensureOasdiff({ config: cfg, binRoot: bin, download })]);
    assert.equal(a, b);
    assert.equal(sha256(fs.readFileSync(a)), cfg.platforms[key].binarySha256);
    assert.deepEqual(fs.readdirSync(path.dirname(a)).filter((f) => f.includes('.part-')), []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});