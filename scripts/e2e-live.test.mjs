import assert from 'node:assert/strict';
import test from 'node:test';
import { mailpitToken, parseArgs } from './e2e-live.mjs';

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