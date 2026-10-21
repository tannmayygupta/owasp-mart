import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, parseArgs, parseCounts, plus } from './verify-live-data.mjs';

const text = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join('\n');
const base = { alembic_version: '0018', users: 10, user_roles: 10, organizations: 0, org_members: 0, email_tokens: 10, email_outbox: 10, attempts: 5 };

test('parseCounts reads the head as text and the tables as numbers, and skips other lines', () => {
  const m = parseCounts(`${text(base)}\nnoise without a number here`);
  assert.equal(m.get('alembic_version'), '0018');
  assert.equal(m.get('users'), 10);
  assert.equal(m.size, 8);
});

test('plus puts a tag before the @', () => { assert.equal(plus('me@example.org', 'x1'), 'me+x1@example.org'); });

test('parseArgs needs the site and an address, an https origin and no plus part', () => {
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(['--base', 'http://x.test', '--email', 'me@example.org']).error);
  assert.ok(parseArgs(['--base', 'https://x.test', '--email', 'me+a@example.org']).error);
  assert.equal(parseArgs(['--base', 'https://x.test/', '--email', 'me@example.org']).base, 'https://x.test');
});

test('judge passes the expected growth and names every kind of failure', () => {
  const good = new Map(Object.entries({ ...base, users: 12, user_roles: 11, organizations: 1, org_members: 1, email_tokens: 12, email_outbox: 12 }));
  assert.ok(judge(parseCounts(text(base)), good, { recruiters: 1, accounts: 2 }).every((c) => c.ok));
  const dup = new Map(good); dup.set('users', 13);
  assert.equal(judge(parseCounts(text(base)), dup, { recruiters: 1, accounts: 2 }).filter((c) => !c.ok).length, 1);
  const lost = new Map(good); lost.set('attempts', 4);
  assert.match(judge(parseCounts(text(base)), lost, { recruiters: 1, accounts: 2 }).find((c) => !c.ok).detail, /attempts/);
  const moved = new Map(good); moved.set('alembic_version', '0019');
  assert.ok(judge(parseCounts(text(base)), moved, { recruiters: 1, accounts: 2 }).some((c) => !c.ok && /head/.test(c.name)));
});
