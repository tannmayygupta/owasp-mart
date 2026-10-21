// C09 self-test: the legacy-route brute force takes over the dormant support agent
// and reads the case-notes flag on the vulnerable build, with ZERO security events
// written for that account (the "attack happened, nothing logged" proof). On the
// fixed build the legacy route logs + locks, so the brute force fails. Also: the
// WEB login still logs and locks after the threshold (the contrast).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { hash } from '../../../apps/shop/src/identity/password.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C09-CASENOTE-FLAG-MARKER';
const WEAK = 'monday123!'; // matches the last word in the exploit's list

export async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  db.prepare("INSERT INTO sentinel (key, value) VALUES ('c09', ?)").run(MARKER);
  // Give the dormant support agent s.iyer a weak, wordlist password.
  db.prepare("UPDATE users SET password_hash = ? WHERE email = 's.iyer@vulnmart.test'").run(hash(WEAK));
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C09: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const iyerId = db.prepare("SELECT id FROM users WHERE email = 's.iyer@vulnmart.test'").get().id;
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events, iyerId };
}

test('C09 exploit PASSES on the vulnerable build (legacy brute force, nothing logged)', async () => {
  const { db, server, baseUrl, events, iyerId } = await bootShop('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'c09', test: exploit, timeoutMs: 20000 });
    assert.equal(r.passed, true, r.detail);
    // M2: zero security events written for s.iyer during the legacy attack.
    const secEvents = db.prepare('SELECT COUNT(*) AS c FROM security_events WHERE account_id = ?').get(iyerId).c;
    assert.equal(secEvents, 0, 'the legacy route must write no security event for the account');
    assert.equal(events.some((e) => e.type === 'shop.security_event_written' && e.data.account_id === String(iyerId)), false);
    assert.ok(events.some((e) => e.type === 'auth.attempt' && e.data.route === 'legacy'), 'expected legacy auth.attempt events');
    // The platform's M2 rule counts failures GROUPED BY THE ACCOUNT: every failed guess must name the attacked account, not unknown.
    const failures = events.filter((e) => e.type === 'auth.attempt' && e.data.route === 'legacy' && e.data.result === 'failure');
    assert.ok(failures.length >= 20, `expected at least 20 legacy failures, saw ${failures.length}`);
    assert.ok(failures.every((e) => e.data.account_id === String(iyerId)), 'every legacy failure names the attacked account');
    assert.ok(events.some((e) => e.type === 'auth.attempt' && e.data.route === 'legacy' && e.data.result === 'success' && e.data.account_id === String(iyerId)));
    assert.equal(events.filter((e) => e.type === 'shop.security_event_written').length, 0, 'the vulnerable legacy route posts no security event');
  } finally { server.close(); }
});

test('C09 exploit FAILS on the fixed build (legacy route logs + locks)', async () => {
  const { db, server, baseUrl, iyerId, events } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c09', test: exploit, timeoutMs: 20000 });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build locks the account (clean fail)');
    const secEvents = db.prepare('SELECT COUNT(*) AS c FROM security_events WHERE account_id = ?').get(iyerId).c;
    assert.ok(secEvents > 0, 'the fixed legacy route writes security events');
    // The M2 negative observation: the fixed build posts shop.security_event_written for the attacked account (so M2 can never be credited there).
    const written = events.filter((e) => e.type === 'shop.security_event_written' && e.data.account_id === String(iyerId));
    assert.ok(written.length > 0, 'the fixed legacy route posts shop.security_event_written');
    assert.ok(written.every((e) => ['login_failed', 'login_success', 'login_locked'].includes(e.data.kind)));
  } finally { server.close(); }
});

test('the WEB login always logs and locks after the threshold', async () => {
  const { db, server, baseUrl, iyerId, events } = await bootShop('vulnerable');
  try {
    const H = { 'content-type': 'application/x-www-form-urlencoded' };
    const page = await fetch(`${baseUrl}/login`);
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
    const jar = new Map();
    for (const c of page.headers.getSetCookie?.() ?? []) { const [p] = c.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); }
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    for (let i = 0; i < 6; i++) {
      await fetch(`${baseUrl}/login`, { method: 'POST', headers: { ...H, cookie }, body: new URLSearchParams({ email: 's.iyer@vulnmart.test', password: 'wrong', csrf }).toString(), redirect: 'manual' });
    }
    const secEvents = db.prepare('SELECT COUNT(*) AS c FROM security_events WHERE account_id = ?').get(iyerId).c;
    assert.ok(secEvents >= 5, 'the web login writes a security event per attempt');
    const alerts = db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c;
    assert.ok(alerts >= 1, 'the web login raises an alert after the threshold');
    assert.ok(events.filter((e) => e.type === 'shop.security_event_written' && e.data.account_id === String(iyerId)).length >= 5, 'the web login posts one security event per attempt');
  } finally { server.close(); }
});
