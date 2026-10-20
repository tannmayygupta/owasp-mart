import assert from 'node:assert/strict';
import test from 'node:test';
import { hintTextProblem, mailpitToken, parseArgs } from './e2e-live.mjs';

test('the hint sweep refuses the placeholder, a short text and a flag, and accepts a real hint', () => {
  assert.match(hintTextProblem('This hint has not been written yet.'), /placeholder/);
  assert.match(hintTextProblem('  This hint has not been written yet.  '), /placeholder/);
  assert.match(hintTextProblem('too short'), /short/);
  assert.match(hintTextProblem(`Look here ${'VM{' + 'A'.repeat(24) + '}'} ok`), /flag/);
  assert.equal(hintTextProblem('Look at your two gift-card codes. Do they look random?'), null);
  assert.match(hintTextProblem(undefined), /short/);
});

test('arguments: an https origin is required; load is bounded; the mail host looks like ubuntu@host', () => {
  assert.equal(parseArgs(['--base', 'https://x.example']).base, 'https://x.example');
  assert.match(parseArgs([]).error, /--base/);
  assert.match(parseArgs(['--base', 'http://x.example']).error, /https/);
  assert.match(parseArgs(['--base', 'https://x.example/path']).error, /origin/);
  assert.match(parseArgs(['--base', 'https://x.example', '--load', '1000']).error, /0 to 100/);
  assert.match(parseArgs(['--base', 'https://x.example', '--mailpit-ssh', 'a b']).error, /ubuntu@host/);
  assert.match(parseArgs(['--base', 'https://x.example', '--nope', '1']).error, /unknown/);
  assert.equal(parseArgs(['--base', 'https://x.example', '--load', '5', '--mailpit-ssh', 'ubuntu@10.0.0.1']).load, 5);
});

test('the confirmation token is read from the link of the mail and nothing else', () => {
  const token = 'A'.repeat(43);
  assert.equal(mailpitToken(`Open https://site.example/verify-email?token=${token} now`), token);
  assert.equal(mailpitToken('no link here'), null);
  assert.equal(mailpitToken('https://site.example/reset-password?token=' + token), null);
});