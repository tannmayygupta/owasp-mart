import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makePassword, parseArgs } from './demo-accounts.mjs';

const ok = ['--base', 'https://x.example', '--mailpit-ssh', 'ubuntu@10.0.0.1', '--out', path.join(os.tmpdir(), 'demo-accounts.txt')];
test('arguments: base, mailpit and an output file outside the repository are required', () => {
  assert.equal(parseArgs(ok).count, 3);
  assert.match(parseArgs(['--base', 'http://x']).error, /https/);
  assert.match(parseArgs(ok.slice(0, 4)).error, /--out/);
  assert.match(parseArgs([...ok.slice(0, 5), 'scripts/demo.txt']).error, /outside the repository/);
  assert.match(parseArgs([...ok, '--count', '0']).error, /1 to 20/);
  assert.match(parseArgs([...ok, '--prefix', 'Bad Prefix']).error, /prefix/);
  assert.match(parseArgs([...ok, '--zzz', '1']).error, /unknown argument/);
});

test('passwords are long, random and different every time', () => {
  const a = makePassword(); const b = makePassword();
  assert.ok(a.length >= 20 && a !== b && /[A-Za-z]/.test(a) && /\d/.test(a));
});