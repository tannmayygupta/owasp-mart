// Tests of scripts/scan-flags.mjs (story 6.1). Flag-shaped values are generated here, never written in the source.
// The real-Docker cases skip without a daemon or without the local stub image.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { countFlagPatterns, dockerAvailable, scanBuffer } from './scan-flags.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-flags.mjs');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const tmp = mkdtempSync(path.join(tmpdir(), 'scan-flags-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function randomFlag() {
  const bytes = randomBytes(24);
  let s = '';
  for (const b of bytes) s += B32[b % 32];
  // never the documented fake (one letter 24 times)
  if (new Set(s).size === 1) return randomFlag();
  return `VM{${s}}`;
}

function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}
const tar = (entries) => Buffer.concat([...entries.map(([n, d]) => tarEntry(n, Buffer.isBuffer(d) ? d : Buffer.from(d))), Buffer.alloc(1024)]);

describe('countFlagPatterns', () => {
  test('finds a real-pattern flag and counts each one', () => {
    assert.equal(countFlagPatterns(Buffer.from(`a ${randomFlag()} b ${randomFlag()}`)), 2);
  });
  test('ignores the documented fake pattern', () => {
    assert.equal(countFlagPatterns(Buffer.from(`VM{${'A'.repeat(24)}} VM{${'7'.repeat(24)}}`)), 0);
  });
  test('finds the refused forms: percent-encoded brace, full-width brace, lower case', () => {
    const body = randomFlag().slice(3, 27);
    assert.equal(countFlagPatterns(Buffer.from(`VM%7B${body}%7D`)), 1);
    assert.equal(countFlagPatterns(Buffer.from(`VM｛${body}｝`, 'utf8')), 1);
    assert.equal(countFlagPatterns(Buffer.from(`vm{${body.toLowerCase()}}`)), 1);
  });
  test('a clean text, a short body and a non-Base32 body are not matches', () => {
    assert.equal(countFlagPatterns(Buffer.from('VM{SHORT} VM{0189ABCDEFGHIJKLMNOPQRST} hello')), 0);
  });
  test('a match across a chunk boundary is found once', () => {
    const buf = Buffer.alloc(16 * 1024 * 1024 + 200, 0x20);
    buf.write(randomFlag(), 16 * 1024 * 1024 - 10);
    assert.equal(countFlagPatterns(buf), 1);
  });
});

describe('scanBuffer', () => {
  test('finds a planted pattern in a fake image layer (nested gzip tar) and names where, not the value', () => {
    const flag = randomFlag();
    const layer = gzipSync(tar([['app/readme.txt', 'clean text'], ['srv/data/config.json', `{"x":"${flag}"}`]]));
    const image = tar([['manifest.json', '[]'], ['blobs/layer1/layer.tar', layer]]);
    const hits = scanBuffer(image, 'image test');
    assert.equal(hits.length, 1);
    assert.match(hits[0].where, /srv\/data\/config\.json/);
    assert.equal(hits[0].count, 1);
    assert.ok(!JSON.stringify(hits).includes(flag), 'the match is never in the result');
  });
  test('a clean layer passes and the fake pattern in a layer passes', () => {
    const layer = tar([['a.txt', 'nothing here'], ['b.txt', `VM{${'Q'.repeat(24)}}`]]);
    assert.deepEqual(scanBuffer(gzipSync(layer), 'image test'), []);
  });
  test('a planted pattern in a log text and in docker inspect JSON is found', () => {
    const flag = randomFlag();
    assert.equal(scanBuffer(Buffer.from(`2026 request ok\nleaked ${flag}\n`), 'logs').length, 1);
    assert.equal(scanBuffer(Buffer.from(JSON.stringify([{ Config: { Env: [`X=${flag}`] } }])), 'inspect').length, 1);
    assert.equal(scanBuffer(Buffer.from(JSON.stringify([{ Config: { Env: ['X=1'], Labels: { 'vm.instance': 'i-1' } } }])), 'inspect').length, 0);
  });
});

describe('command line', () => {
  test('exit 1 and no value printed for a planted file, exit 0 for a clean one, exit 2 for a bad argument', () => {
    const flag = randomFlag();
    const bad = path.join(tmp, 'orchestrator.log');
    const good = path.join(tmp, 'clean.log');
    writeFileSync(bad, `line\nleak ${flag}\n`);
    writeFileSync(good, `line\nVM{${'B'.repeat(24)}}\n`);
    const r1 = spawnSync('node', [SCRIPT, '--file', bad], { encoding: 'utf8' });
    assert.equal(r1.status, 1);
    assert.match(r1.stdout, /FOUND 1/);
    assert.ok(!r1.stdout.includes(flag) && !r1.stderr.includes(flag));
    const r2 = spawnSync('node', [SCRIPT, '--file', good], { encoding: 'utf8' });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /CLEAN/);
    assert.equal(spawnSync('node', [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync('node', [SCRIPT], { encoding: 'utf8' }).status, 0);
  });
  test('a tar file with a planted layer fails', () => {
    const flag = randomFlag();
    const p = path.join(tmp, 'img.tar');
    writeFileSync(p, tar([['l/layer.tar', 'x']]));
    assert.equal(spawnSync('node', [SCRIPT, '--tar', p], { encoding: 'utf8' }).status, 0);
    writeFileSync(p, tar([['l/f.txt', flag]]));
    assert.equal(spawnSync('node', [SCRIPT, '--tar', p], { encoding: 'utf8' }).status, 1);
  });
});

const STUB = 'vulnmart-stub-instance:local';
function haveStub() {
  if (!dockerAvailable()) return false;
  try {
    execFileSync('docker', ['image', 'inspect', STUB], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const dockerSkip = haveStub() ? false : 'no Docker daemon or no local stub image';

describe('real Docker', { skip: dockerSkip }, () => {
  const iid = `i-SCANTEST${randomBytes(3).toString('hex').toUpperCase()}`;
  const names = [];
  const run = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
  after(() => names.forEach((n) => spawnSync('docker', ['rm', '-f', n], { stdio: 'ignore' })));

  test('a clean instance container passes (layers, logs, inspect) and a planted env value and a planted log line fail', () => {
    const cleanName = `scantest-clean-${iid}`;
    names.push(cleanName);
    run('create', '--name', cleanName, '--label', `vm.instance=${iid}`, STUB);
    const ok = spawnSync('node', [SCRIPT, '--instance', iid], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /CLEAN/);

    const iid2 = `${iid}B`;
    const envName = `scantest-env-${iid}`;
    names.push(envName);
    const flag = randomFlag();
    run('create', '--name', envName, '--label', `vm.instance=${iid2}`, '-e', `LEAK=${flag}`, STUB);
    const bad = spawnSync('node', [SCRIPT, '--instance', iid2], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /docker inspect container 1 of 1/);
    assert.ok(!bad.stdout.includes(flag));

    const iid3 = `${iid}C`;
    const logName = `scantest-log-${iid}`;
    names.push(logName);
    run('run', '--name', logName, '--label', `vm.instance=${iid3}`, '--entrypoint', 'node', STUB, '-e', `console.log(${JSON.stringify(flag)})`);
    const badLog = spawnSync('node', [SCRIPT, '--instance', iid3], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(badLog.status, 1);
    assert.match(badLog.stdout, /docker logs container 1 of 1/);
    assert.ok(!badLog.stdout.includes(flag));
  });
});
