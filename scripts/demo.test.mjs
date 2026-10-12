// Unit tests for the pure parts of scripts/demo.mjs (story 17). No Docker needed.
// Run: node --test scripts/demo.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT, PLATFORM_CONTAINERS, parseDemoArgs, platformProfiles, platformPorts, redact, formatLine, formatTable, exitCode,
  parseStepLines, evaluateDoctor, reduceTemplate, relaxSchema, buildManifest, leftoverNames, evidenceText,
} from './demo.mjs';
import { parseArgs, HELP } from './dev.mjs';

describe('arguments', () => {
  test('no option gives all false; known options set their flag', () => {
    assert.deepEqual(parseDemoArgs([]), { keep: false, stubOnly: false, noWeb: false });
    assert.deepEqual(parseDemoArgs(['--keep', '--no-web']), { keep: true, stubOnly: false, noWeb: true });
  });
  test('demo down is its own command', () => {
    assert.deepEqual(parseDemoArgs(['down']), { down: true });
    assert.deepEqual(parseArgs(['demo', 'down']), { cmd: 'demo', rest: ['down'] });
  });
  test('an unknown option is an error', () => {
    assert.match(parseDemoArgs(['--force']).error, /Unknown option "--force"/);
  });
  test('dev.mjs knows the command and its help lists it', () => {
    assert.deepEqual(parseArgs(['demo', '--stub-only']), { cmd: 'demo', rest: ['--stub-only'] });
    assert.ok(parseArgs(['demo', '--x']).error);
    assert.match(HELP, /demo \[options\]/);
  });
  test('profiles and ports follow --no-web', () => {
    assert.deepEqual(platformProfiles({ noWeb: false }), ['platform', 'web']);
    assert.deepEqual(platformProfiles({ noWeb: true }), ['platform']);
    assert.deepEqual(platformPorts({ noWeb: true }), [8000, 8025]);
    assert.ok(platformPorts({ noWeb: false }).includes(3000));
    assert.equal(PROJECT, 'vulnmart-demo');
  });
});

describe('redaction', () => {
  test('flags, long hex values, addresses and home paths never survive', () => {
    const text = 'flag VM{ABCDEFGHJKLMNPQRSTUVWXYZ} key ' + 'a'.repeat(64) + ' at 192.168.1.20 in C:\\Users\\someone\\x and /home/bob/y';
    const out = redact(text);
    assert.ok(!/VM\{/.test(out) && !/a{32}/.test(out) && !/192\.168/.test(out) && !/someone/.test(out) && !/bob/.test(out), out);
    assert.match(out, /<flag>.*<hex>.*<addr>.*<home>.*<home>/);
  });
  test('numbers, states and codes stay', () => {
    assert.equal(redact('state ready, 3 instances, ORCH-TEMPLATE-UNKNOWN HTTP 422'), 'state ready, 3 instances, ORCH-TEMPLATE-UNKNOWN HTTP 422');
  });
});

describe('table and exit code', () => {
  const rows = [{ status: 'PASS', name: 'a', detail: 'ok' }, { status: 'SKIP', name: 'longer-name', detail: 'x' }];
  test('line and table format', () => {
    assert.equal(formatLine(rows[0]), 'PASS a: ok');
    const t = formatTable(rows).split('\n');
    assert.equal(t.length, 4);
    assert.match(t[2], /^PASS {4}a {12}ok$/);
  });
  test('exit 1 on any FAIL, 0 otherwise (SKIP does not fail)', () => {
    assert.equal(exitCode(rows), 0);
    assert.equal(exitCode([...rows, { status: 'FAIL', name: 'b', detail: '' }]), 1);
  });
  test('evidence text is redacted and states the result', () => {
    const text = evidenceText({ date: '2026-10-13', args: { keep: false, stubOnly: true, noWeb: false }, mode: 'stub instance image', rows: [{ status: 'PASS', name: 'x', detail: 'from 10.0.0.5' }], note: '' });
    assert.match(text, /Options: --stub-only/);
    assert.match(text, /every step PASS/);
    assert.ok(!text.includes('10.0.0.5'));
  });
});

describe('client step lines', () => {
  test('reads STEP lines and ignores everything else', () => {
    const out = ['noise', 'STEP {"name":"create","ok":true,"detail":"d"}', 'STEP {bad', 'STEP {"name":"x","ok":false,"detail":"e"}', 'STEP {"name":1,"ok":true}'].join('\r\n');
    assert.deepEqual(parseStepLines(out), [{ status: 'PASS', name: 'create', detail: 'd' }, { status: 'FAIL', name: 'x', detail: 'e' }]);
  });
});

describe('doctor lines', () => {
  const good = ['PASS  Node           v24.11.0 (pinned major 24)', 'FAIL  pnpm           not found or failed', 'PASS  uv             uv 0.12.23', 'PASS  Docker         Docker version 29', 'PASS  Compose        v2.40', 'PASS  Docker engine  running'];
  test('pnpm is not needed for the demo', () => {
    assert.equal(evaluateDoctor(good).ok, true);
  });
  test('a failed or missing needed tool is reported', () => {
    const bad = good.map((l) => l.replace('PASS  uv  ', 'FAIL  uv  '));
    assert.deepEqual(evaluateDoctor(bad).failed, ['uv']);
    assert.deepEqual(evaluateDoctor(good.slice(0, 3)).failed, ['Docker', 'Compose', 'Docker engine']);
  });
});

describe('template and manifest', () => {
  test('reduceTemplate keeps only injector and shop and does not change the input', () => {
    const t = { components: [{ role: 'shop' }, { role: 'sidecar' }, { role: 'injector' }, { role: 'mock-services' }], volumes: [1] };
    const r = reduceTemplate(t);
    assert.deepEqual(r.components.map((c) => c.role), ['shop', 'injector']);
    assert.equal(t.components.length, 4);
    assert.deepEqual(r.volumes, [1]);
  });
  test('relaxSchema lowers the component rule to shop and injector and keeps the rest', () => {
    const rule = (role) => ({ contains: { type: 'object', properties: { role: { const: role } } }, minContains: 1 });
    const schema = { title: 'x', properties: { components: { type: 'array', minItems: 6, allOf: ['shop', 'sidecar', 'injector', 'bot-controller'].map(rule) } } };
    const r = relaxSchema(schema);
    assert.equal(r.properties.components.minItems, undefined);
    assert.deepEqual(r.properties.components.allOf.map((x) => x.contains.properties.role.const), ['shop', 'injector']);
    assert.equal(schema.properties.components.minItems, 6);
    assert.equal(r.title, 'x');
  });
  const stub = 'sha256:' + '1'.repeat(64);
  const shop = 'sha256:' + '2'.repeat(64);
  test('stub in the shop role gets the shop command; the real shop keeps its own CMD', () => {
    const s = buildManifest({ stubId: stub, shopId: stub, realShop: false });
    assert.deepEqual(s.commands.shop, ['shop']);
    const r = buildManifest({ stubId: stub, shopId: shop, realShop: true });
    assert.equal(r.images.shop, shop);
    assert.equal(r.commands.shop, undefined);
    assert.equal(r.images.injector, stub);
    assert.deepEqual(r.commands.injector, ['inject']);
  });
  test('only roles the reduced template needs are in the manifest', () => {
    assert.deepEqual(Object.keys(buildManifest({ stubId: stub, shopId: stub, realShop: false }).images).sort(), ['injector', 'shop', 'volume-keeper']);
  });
});

describe('leftovers', () => {
  test('only this project\'s container names count, other containers are ignored', () => {
    assert.deepEqual(leftoverNames('vulnmart-api\nn8n\npostgres\nvulnmart-web\n'), ['vulnmart-api', 'vulnmart-web']);
    assert.ok(PLATFORM_CONTAINERS.includes('vulnmart-migrate'));
    assert.deepEqual(leftoverNames(''), []);
  });
});

