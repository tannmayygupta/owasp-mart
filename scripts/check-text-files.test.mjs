// Text hygiene: the tracked tree is clean, and the scanner catches a control character, a BOM and mojibake
// (fixtures are built at run time so this file itself stays clean).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTextHygiene, scanTextFiles, trackedTextFiles } from './check-text-files.mjs';

const VT = String.fromCharCode(11);
const BOM = String.fromCharCode(0xfeff);
const mojibake = String.fromCharCode(0xe2, 0x20ac) + String.fromCharCode(0x201d);

test('the tracked text files have no control character, BOM or mojibake', () => {
  const hits = scanTextFiles(trackedTextFiles());
  assert.deepEqual(hits, [], hits.map((h) => `${h.file}:${h.line} ${h.kind}`).join('\n'));
});

test('a control character is caught with its line, tab, LF and CR are not', () => {
  assert.deepEqual(scanTextHygiene('a.md', `ok\r\n\tindented\nbad ${VT}erify\n`), [{ file: 'a.md', line: 3, kind: 'control character' }]);
  assert.deepEqual(scanTextHygiene('a.md', 'a\tb\r\nc\n'), []);
  assert.equal(scanTextHygiene('a.md', 'x\u0000y')[0].kind, 'control character');
});

test('a byte order mark is caught in a string and in a buffer', () => {
  assert.equal(scanTextHygiene('a.txt', `${BOM}hello`)[0].kind, 'byte order mark');
  assert.equal(scanTextHygiene('a.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]))[0].kind, 'byte order mark');
  assert.deepEqual(scanTextHygiene('a.txt', 'hello'), []);
});

test('mojibake is caught, correct dashes and accents are not', () => {
  assert.equal(scanTextHygiene('a.md', `intent ${mojibake} do not`)[0].kind, 'mojibake');
  assert.deepEqual(scanTextHygiene('a.md', 'intent — do not, café'), []);
});

test('binary and lock files are skipped', () => {
  assert.deepEqual(scanTextFiles(['a.png', 'pnpm-lock.yaml'], () => Buffer.from([0, 1, 2]), () => 3), []);
  assert.equal(scanTextFiles(['a.md'], () => Buffer.from([0, 1, 2]), () => 3).length, 1);
});
