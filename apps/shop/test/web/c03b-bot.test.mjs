// C03 part B through the shop (the live loop of challenge-specs section 3): the ticket is queued for the support bot, the bot's session reaches the ticket page and the agent profile
// and nothing else, the profile holds the flag only for the bot's session in the vulnerable build, and the player's listener page shows what the collector received.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../../src/db/index.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { seedAll } from '../../seed/registry.mjs';
import { createApp } from '../../src/app.mjs';
import { createBotQueue, MAX_BODY_BYTES, MAX_VISITS } from '../../src/challenges/c03b-bot.mjs';

const FLAG = 'VM{' + 'ABCDEFGH'.repeat(3) + '}';
const PAYLOAD = `<img src=x onerror="fetch('/staff/api/agent-profile')">`;
const visits = []; // what the queues handed to the bot controller
let db; let collector; let vul; let fixed; let vulQueue; let fixedQueue;
const closers = [];

const start = (server) => new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })); });
function client() {
  const jar = new Map();
  const c = { jar, cookie: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '), csrf: null };
  c.take = (r) => { for (const x of r.headers.getSetCookie?.() ?? []) { const [p] = x.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); } };
  return c;
}
async function login(base, email, password) {
  const c = client();
  const page = await fetch(`${base}/login`); c.take(page);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { cookie: c.cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password, csrf }), redirect: 'manual' });
  c.take(r);
  assert.equal(r.status, 302, `login ${email}`);
  const again = await fetch(`${base}/login`, { headers: { cookie: c.cookie() } }); c.take(again);
  c.csrf = (await again.text()).match(/name="csrf" value="([^"]+)"/)[1];
  return c;
}
const sendTicket = (base, c, subject, body) => fetch(`${base}/tickets`, { method: 'POST', headers: { cookie: c.cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ subject, body, csrf: c.csrf }), redirect: 'manual' });
const asBot = (base, path, init = {}) => {
  const session = visits.at(-1).payload.session;
  return fetch(`${base}${path}`, { ...init, headers: { cookie: `vm_sess=${session}`, ...(init.headers ?? {}) }, redirect: 'manual' });
};

before(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  const rows = [{ at: '2026-01-01T00:00:00Z', method: 'GET', path: '/c/x', bot_tagged: true, data: `d=${FLAG} <b>x</b>` }];
  collector = await start(http.createServer((req, res) => {
    if (req.url === '/inbox') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'abcdefghijklmnop', hits: rows })); }
    res.writeHead(404); res.end();
  }));
  closers.push(collector.close);
  const queue = (delayMs) => createBotQueue({ db, delayMs, post: async (url, payload) => { visits.push({ url, payload }); return 200; } });
  vulQueue = queue(400); // long enough to look at the ticket page before the agent has been
  fixedQueue = queue(5);
  const flagOf = (k) => (k === 'C03' ? FLAG : undefined);
  vul = await start(createApp({ db, challenges: { C03B: 'vulnerable' }, flagOf, bot: vulQueue, mockUrl: collector.base }));
  fixed = await start(createApp({ db, challenges: {}, flagOf, bot: fixedQueue, mockUrl: collector.base }));
  closers.push(vul.close, fixed.close);
});
after(() => { for (const c of closers) c(); });

test('a ticket is queued for the bot: it gets a bot session and the ticket page, then the customer sees "Agent has viewed this ticket"', async () => {
  const c = await login(vul.base, 'player.customer@vulnmart.test', 'player-customer-demo-b2');
  const before = visits.length;
  const r = await sendTicket(vul.base, c, 'help', PAYLOAD);
  assert.equal(r.status, 302);
  const id = r.headers.get('location').match(/\/tickets\/(\d+)/)[1];
  assert.match(await (await fetch(`${vul.base}/tickets/${id}`, { headers: { cookie: c.cookie() } })).text(), /An agent will look at this ticket shortly/);
  await vulQueue.idle();
  assert.equal(visits.length, before + 1);
  assert.equal(visits.at(-1).payload.path, `/staff/tickets/${id}`);
  assert.equal(visits.at(-1).payload.ticket_id, `t-${id}`);
  assert.match(visits.at(-1).payload.session, /^[A-Za-z0-9_.-]{10,2048}$/);
  assert.match(await (await fetch(`${vul.base}/tickets/${id}`, { headers: { cookie: c.cookie() } })).text(), /Agent has viewed this ticket at \d\d:\d\d UTC/);
});

test('the bot session sees the raw message on the support page and the flag in its profile (vulnerable build)', async () => {
  const page = await asBot(vul.base, `/staff/tickets/${visits.at(-1).payload.path.split('/').pop()}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(PAYLOAD), 'the message is rendered raw for the bot');
  const profile = await asBot(vul.base, '/staff/api/agent-profile');
  assert.equal(profile.status, 200);
  const body = await profile.json();
  assert.equal(body.console_key, FLAG);
  assert.equal(body.agent, 'bot.support');
});

test('the fixed build escapes the message and hides the console key from every script-reachable call', async () => {
  const c = await login(fixed.base, 'player.customer@vulnmart.test', 'player-customer-demo-b2');
  const r = await sendTicket(fixed.base, c, 'help', PAYLOAD);
  const id = r.headers.get('location').match(/\/tickets\/(\d+)/)[1];
  await fixedQueue.idle();
  const page = await (await asBot(fixed.base, `/staff/tickets/${id}`)).text();
  assert.ok(!page.includes(PAYLOAD) && page.includes('&lt;img'), 'escaped');
  const body = await (await asBot(fixed.base, '/staff/api/agent-profile')).json();
  assert.equal(body.console_key, '[hidden]');
});

test('another support agent gets a key of their own, never the flag', async () => {
  const s = await login(vul.base, 's.iyer@vulnmart.test', 'legacy-support-demo-d4');
  const body = await (await fetch(`${vul.base}/staff/api/agent-profile`, { headers: { cookie: s.cookie() } })).json();
  assert.match(body.console_key, /^ck-[0-9a-f]{20}$/);
  assert.ok(!JSON.stringify(body).includes(FLAG));
});

test('the bot session is scoped: one ticket page and the profile, nothing else (orders, case notes, lists, any POST)', async () => {
  const denied = [['GET', '/staff/tickets'], ['GET', '/staff/order/1'], ['GET', '/orders'], ['GET', '/staff/tickets/1/anything'], ['GET', '/tickets'], ['GET', '/lab/listener'], ['POST', '/staff/tickets/1/resolve'], ['POST', '/tickets']];
  for (const [method, path] of denied) {
    const r = await asBot(vul.base, path, method === 'POST' ? { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'subject=x&body=y' } : {});
    assert.equal(r.status, 403, `${method} ${path}`);
  }
});

test('a cookie that claims to be a bot session without the shop signature is no session at all', async () => {
  const forged = Buffer.from(JSON.stringify({ uid: 15, kind: 'bot', csrf: 'x', exp: Date.now() + 60000 })).toString('base64url');
  const r = await fetch(`${vul.base}/staff/api/agent-profile`, { headers: { cookie: `vm_sess=${forged}.AAAA` }, redirect: 'manual' });
  assert.equal(r.status, 302); // sent to the login page like any anonymous visitor
});

test('queue rules: one visit per ticket, a body over 2 KB is not visited, at most 10 visits in 10 minutes', async () => {
  let t = 1_000_000;
  const q = createBotQueue({ db, delayMs: 1, post: async () => 200, now: () => t });
  assert.equal(q.enqueue(1, 'a'), 'queued');
  assert.equal(q.enqueue(1, 'a'), 'duplicate');
  assert.equal(q.enqueue(2, 'x'.repeat(MAX_BODY_BYTES + 1)), 'too_large');
  for (let i = 10; i < 10 + MAX_VISITS - 1; i++) assert.equal(q.enqueue(i, 'a'), 'queued');
  assert.equal(q.enqueue(99, 'a'), 'rate_limited');
  t += 10 * 60 * 1000 + 1;
  assert.equal(q.enqueue(100, 'a'), 'queued', 'the window has passed');
  await q.idle();
  assert.equal(createBotQueue({ db, enabled: false }).enqueue(1, 'a'), 'no_bot');
});

test('the player sees the support form and the listener: the collector address, the hits (as text, not markup), and an empty page when the collector is down', async () => {
  const c = await login(vul.base, 'player.customer@vulnmart.test', 'player-customer-demo-b2');
  assert.match(await (await fetch(`${vul.base}/tickets`, { headers: { cookie: c.cookie() } })).text(), /action="\/tickets"/);
  const html = await (await fetch(`${vul.base}/lab/listener`, { headers: { cookie: c.cookie() } })).text();
  assert.ok(html.includes(`/c/abcdefghijklmnop`), 'the collector address the agent browser can reach');
  assert.ok(html.includes(FLAG), 'what the agent sent is shown to the player');
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), 'escaped');
  const down = await start(createApp({ db, challenges: {}, bot: null, mockUrl: 'http://127.0.0.1:1' }));
  try {
    const c2 = await login(down.base, 'player.customer@vulnmart.test', 'player-customer-demo-b2');
    assert.match(await (await fetch(`${down.base}/lab/listener`, { headers: { cookie: c2.cookie() } })).text(), /not answering yet/);
  } finally { down.close(); }
  assert.equal((await fetch(`${vul.base}/lab/listener`, { redirect: 'manual' })).status, 302, 'anonymous visitors go to the login page');
});