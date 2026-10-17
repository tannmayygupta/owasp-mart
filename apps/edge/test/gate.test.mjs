// Gate tests: one test per row of the matrix in the story plan, then property cases (contracts/edge/gate-ticket.md section 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, MAX_USED_TICKETS } from '../src/gate.mjs';
import { createStore } from '../src/state.mjs';
import { COOKIE_NAME, newJti, signCookie, signTicket } from '../src/tickets.mjs';
import { ID_A, ID_B, ZONE, host, randomKey, randomOwner, setup } from './helpers.mjs';

const forwarded = (r) => r.type === 'forward';
const status = (r) => (r.type === 'respond' ? r.status : 'forward');
const UPSTREAM_A = 'vm-i-abcdefghijklmnop-e1-sidecar:8080';

// ---- matrix rows -----------------------------------------------------------------------------------------------------------------------------

test('good ticket: 302 to /, host-only cookie with the right attributes, no-referrer, then the cookie opens the shop', () => {
  const s = setup();
  const r = s.get(`/_vm/enter?t=${s.ticket()}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['cache-control'], 'no-store');
  const attrs = r.headers['set-cookie'].split('; ');
  assert.ok(attrs[0].startsWith(`${COOKIE_NAME}=`));
  assert.deepEqual(attrs.slice(1).sort(), ['HttpOnly', 'Path=/', 'SameSite=Lax', 'Secure']);
  assert.ok(!/domain|max-age|expires/i.test(r.headers['set-cookie']), 'no Domain, Max-Age or Expires');
  const f = s.get('/', { cookie: attrs[0] });
  assert.equal(f.type, 'forward');
  assert.equal(f.upstream, UPSTREAM_A);
});

test('reused ticket: the second use is refused with the generic 403 page', () => {
  const s = setup();
  const t = s.ticket();
  assert.equal(s.get(`/_vm/enter?t=${t}`).status, 302);
  const again = s.get(`/_vm/enter?t=${t}`);
  assert.equal(again.status, 403);
  assert.equal(again.headers['set-cookie'], undefined);
  s.clock.ms += 5000;
  assert.equal(s.get(`/_vm/enter?t=${t}`).status, 403, 'still refused later inside the life of the ticket');
});

test('refused tickets: expired, forged, other instance, other owner, old epoch (and newer epoch): 403, nothing forwarded, same page', () => {
  const s = setup();
  const cases = {
    expired: s.ticket({ exp: s.clock.nowS() }),
    'too far ahead': s.ticket({ exp: s.clock.nowS() + 61 }),
    forged: s.ticket({}, randomKey()),
    'other instance': s.ticket({ inst: ID_B }),
    'other owner': s.ticket({ own: s.ownerB }),
    'old epoch': s.ticket({ ae: 2 }),
    'newer epoch than the state': s.ticket({ ae: 4 }),
  };
  const pages = new Set();
  for (const [name, t] of Object.entries(cases)) {
    const r = s.get(`/_vm/enter?t=${t}`);
    assert.equal(status(r), 403, name);
    assert.equal(r.headers['set-cookie'], undefined, name);
    pages.add(r.body);
  }
  assert.equal(pages.size, 1, 'one identical page for every refusal');
  // a refused ticket does not spend its id: the good one with that id is still usable
  const jti = newJti();
  assert.equal(s.get(`/_vm/enter?t=${s.ticket({ jti, own: s.ownerB })}`).status, 403);
  assert.equal(s.get(`/_vm/enter?t=${s.ticket({ jti })}`).status, 302);
});

test('cookie of instance A on host B: refused', () => {
  const s = setup();
  const cookie = s.login();
  assert.equal(s.get('/', { id: ID_A, cookie }).type, 'forward');
  assert.equal(status(s.get('/', { id: ID_B, cookie })), 403);
});

test('cookie signed for instance A, owner and epoch of B, sent to host B: refused (instance differs)', () => {
  const s = setup();
  const v = signCookie({ current: s.keys.current }, { inst: ID_A, own: s.ownerB, ae: 3 });
  assert.equal(status(s.get('/', { id: ID_B, cookie: `${COOKIE_NAME}=${v}` })), 403);
});

test('old cookie after a new open (state access epoch raised): refused until a new ticket', () => {
  const s = setup();
  const old = s.login();
  s.put(ID_A, s.ownerA, { access_epoch: 4 });
  assert.equal(status(s.get('/', { cookie: old })), 403);
  assert.equal(s.get(`/_vm/enter?t=${s.ticket({ ae: 3 })}`).status, 403, 'a ticket of the old epoch is refused too');
  const fresh = s.login({ ae: 4 });
  assert.equal(s.get('/', { cookie: fresh }).type, 'forward');
  assert.equal(status(s.get('/', { cookie: old })), 403, 'the old cookie stays refused');
});

test('cookie of another owner (state owner changed): refused', () => {
  const s = setup();
  const cookie = s.login();
  const other = randomOwner();
  s.put(ID_A, other, { access_epoch: 4 });
  assert.equal(status(s.get('/', { cookie })), 403);
  const forgedOwner = signCookie({ current: s.keys.current }, { inst: ID_A, own: s.ownerA, ae: 4 });
  assert.equal(status(s.get('/', { cookie: `${COOKIE_NAME}=${forgedOwner}` })), 403);
});

test('frozen: a cookie that was valid gets the 423 page and nothing is forwarded; thawing needs a new ticket (the epoch rises, as in IF-5)', () => {
  const s = setup();
  const cookie = s.login();
  assert.equal(s.get('/', { cookie }).type, 'forward');
  s.put(ID_A, s.ownerA, { access: 'frozen', access_epoch: 4 });
  const r = s.get('/', { cookie });
  assert.equal(r.status, 423);
  assert.equal(forwarded(r), false);
  assert.equal(s.get(`/_vm/enter?t=${s.ticket({ ae: 4 })}`).status, 423, 'no ticket exchange while frozen');
  assert.notEqual(r.body, s.get('/', { id: 'i-AAAAAAAAAAAAAAAA' }).body, 'the paused page differs from the ended page');
  s.put(ID_A, s.ownerA, { access: 'open', access_epoch: 5 });
  assert.equal(status(s.get('/', { cookie })), 403, 'the old cookie does not survive the thaw');
  assert.equal(s.get('/', { cookie: s.login({ ae: 5 }) }).type, 'forward');
});

test('closed or unknown: 410 page, nothing forwarded, the same page for both', () => {
  const s = setup();
  const cookie = s.login();
  s.put(ID_A, s.ownerA, { access: 'closed', access_epoch: 4 });
  const closed = s.get('/', { cookie });
  assert.equal(closed.status, 410);
  const removed = s.gate.store.remove(ID_B);
  assert.equal(removed.status, 204);
  const unknown = s.get('/', { id: ID_B });
  assert.equal(unknown.status, 410);
  assert.equal(closed.body, unknown.body);
  assert.equal(s.get('/', { id: 'i-AAAAAAAAAAAAAAAA' }).status, 410, 'a well-formed host that never had a record');
  assert.equal(s.get(`/_vm/enter?t=${s.ticket({ ae: 4 })}`).status, 410, 'a closed instance gives no cookie');
});

test('crafted Host values: refused as unknown (410, same page), before any state lookup', () => {
  const keys = { current: randomKey() };
  const store = createStore({ zone: ZONE });
  let lookups = 0;
  const counting = { ...store, get: (label) => { lookups += 1; return store.get(label); } };
  const gate = createGate({ keys, zone: ZONE, store: counting });
  const owner = randomOwner();
  assert.equal(store.put(ID_A, { hostname: host(ID_A), instance_id: ID_A, epoch: 1, owner, access: 'open', access_epoch: 3 }).status, 204);
  const good = host(ID_A);
  const crafted = [
    'i-x.labs.evil', `${good}.evil.com`, `${good.toUpperCase()}`, `I-abcdefghijklmnop.${ZONE}`, `i-abcdefghijklmnop.${ZONE.toUpperCase()}`,
    `${good}:443`, `${good}:`, `${good}.`, `i-abcdefghijklmno.${ZONE}`, `i-abcdefghijklmnopq.${ZONE}`, `x.${good}`, `a.b.${good}`,
    `user@${good}`, `user:pw@${good}`, ` ${good}`, `${good} `, `${good}\n`, `${good}\0`, `i-abcdefghijklmno1.${ZONE}`, `i-abcdefghijklmno8.${ZONE}`,
    `i-abcdefghijklmn-p.${ZONE}`, `i-abcdefghijklmnop${ZONE}`, `i-abcdefghijklmnop..${ZONE}`, `.${good}`, ZONE, '', 'localhost', '127.0.0.1', '[::1]',
    `i-abcdefghijklmnop.labs.test.attacker.example`, `xi-abcdefghijklmnop.${ZONE}`, 'i-abcdefghijklmnop.labs', undefined, null, 42, ['a', 'b'], [good],
  ];
  const cookie = `${COOKIE_NAME}=${signCookie(keys, { inst: ID_A, own: owner, ae: 3 })}`;
  let page;
  for (const h of crafted) {
    const r = gate.decide({ method: 'GET', url: '/', headers: { host: h, cookie } });
    assert.equal(status(r), 410, `Host ${JSON.stringify(h)}`);
    page ??= r.body;
    assert.equal(r.body, page);
  }
  assert.equal(lookups, 0, 'no state lookup for a refused host');
  assert.equal(gate.decide({ method: 'GET', url: '/', headers: { host: good, cookie } }).type, 'forward');
  assert.equal(lookups, 1);
  // X-Forwarded-Host never counts
  assert.equal(status(gate.decide({ method: 'GET', url: '/', headers: { host: 'evil.example', 'x-forwarded-host': good, cookie } })), 410);
  assert.equal(status(gate.decide({ method: 'GET', url: '/', headers: { cookie } })), 410, 'no Host header');
});

test('other /_vm/ paths: 404 for any method, nothing forwarded', () => {
  const s = setup();
  const cookie = s.login();
  const paths = ['/_vm', '/_vm/', '/_vm/x', '/_vm/enter/', '/_vm/enter/x', '/_vm/ENTER', '/_VM/enter', '/%5Fvm/enter', '/%5fVM/x', '/a/../_vm/x', '/./_vm/x', '//_vm/x', '/\\_vm/x', '/_vm//enter', '/x/%2e%2e/_vm/enter', '/_vm/enter%2fx', '/%255Fvm/x'];
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']) {
    for (const p of paths) {
      const r = s.get(p, { method, cookie });
      // '/%255Fvm/x' decodes once to '/%5Fvm/x', which is an ordinary path the shop may serve: the gate allows it with a valid cookie
      if (p === '/%255Fvm/x') { assert.equal(r.type, 'forward'); continue; }
      assert.equal(status(r), 404, `${method} ${p}`);
    }
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']) {
    assert.equal(status(s.get(`/_vm/enter?t=${s.ticket()}`, { method })), 404, `${method} /_vm/enter`);
  }
  assert.equal(status(s.get('/_vm/enter')), 404, 'no t');
  assert.equal(status(s.get('/_vm/enter?t=')), 404, 'empty t');
  assert.equal(status(s.get(`/_vm/enter?t=${s.ticket()}&t=${s.ticket()}`)), 404, 'two t');
  assert.equal(status(s.get('/_vm/enter?x=1')), 404);
  assert.equal(status(s.get('/_vm/enter?t=' + 'a'.repeat(2000))), 403, 'oversized ticket');
  for (const p of ['*', 'http://evil/', '', 'x', undefined]) assert.equal(status(s.get(p, { cookie })), 404, `url ${p}`);
  assert.equal(status(s.get('/%zz', { cookie })), 404, 'undecodable path');
});

// ---- cookie and ticket properties -----------------------------------------------------------------------------------------------------------

test('cookie: absent, empty, garbage, duplicated, forged and ticket-as-cookie are all the same 403', () => {
  const s = setup();
  const good = s.login();
  const value = good.slice(COOKIE_NAME.length + 1);
  const flip = value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');
  const cases = {
    absent: undefined,
    empty: `${COOKIE_NAME}=`,
    garbage: `${COOKIE_NAME}=garbage`,
    'other name': `vm_gate=${value}`,
    'wrong prefix name': `Host-vm_gate=${value}`,
    forged: `${COOKIE_NAME}=${flip}`,
    duplicated: `${good}; ${good}`,
    'ticket as cookie': `${COOKIE_NAME}=${s.ticket()}`,
    'previous-key-only unknown key': `${COOKIE_NAME}=${signCookie({ current: randomKey() }, { inst: ID_A, own: s.ownerA, ae: 3 })}`,
  };
  const pages = new Set();
  for (const [name, cookie] of Object.entries(cases)) {
    const r = s.get('/', { cookie });
    assert.equal(status(r), 403, name);
    pages.add(r.body);
  }
  assert.equal(pages.size, 1);
});

test('key rotation: the previous key is accepted, an unknown key is not, and new cookies are signed with the current key', () => {
  const s = setup();
  assert.equal(s.get(`/_vm/enter?t=${s.ticket({}, s.keys.previous)}`).status, 302);
  assert.equal(s.get(`/_vm/enter?t=${s.ticket({}, randomKey())}`).status, 403);
  const cookie = s.login();
  const rotated = createGate({ keys: { current: s.keys.current }, zone: ZONE, store: s.gate.store, now: () => s.clock.ms });
  const f = rotated.decide({ method: 'GET', url: '/', headers: { host: host(ID_A), cookie } });
  assert.equal(f.type, 'forward', 'the cookie works with the current key alone');
  const onlyNew = createGate({ keys: { current: randomKey() }, zone: ZONE, store: s.gate.store, now: () => s.clock.ms });
  assert.equal(onlyNew.decide({ method: 'GET', url: '/', headers: { host: host(ID_A), cookie } }).status, 403);
});

test('forward: the gate cookie is stripped, other cookies stay, the upstream name comes from the record, no header is added', () => {
  const s = setup();
  const cookie = s.login();
  const r = s.get('/shop?x=1', { cookie: `a=1; ${cookie}; b=2` });
  assert.equal(r.type, 'forward');
  assert.equal(r.cookie, 'a=1; b=2');
  assert.equal(r.upstream, UPSTREAM_A);
  assert.deepEqual(Object.keys(r).sort(), ['cookie', 'type', 'upstream'], 'only the upstream and the cookie: no security header is added to shop responses');
  assert.equal(s.get('/', { cookie }).cookie, undefined, 'nothing left of the Cookie header');
  s.put(ID_A, s.ownerA, { epoch: 2, access_epoch: 3 });
  assert.equal(s.get('/', { cookie }).upstream, 'vm-i-abcdefghijklmnop-e2-sidecar:8080', 'a reset moves the upstream name');
});

test('the used-ticket set is bounded: when it is full a new ticket is refused, and ids are forgotten only after their expiry', () => {
  const s = setup();
  for (let i = 0; i < MAX_USED_TICKETS; i++) {
    const r = s.get(`/_vm/enter?t=${s.ticket({ exp: s.clock.nowS() + 60 })}`);
    assert.equal(r.status, 302);
  }
  assert.equal(s.gate.usedTickets(), MAX_USED_TICKETS);
  assert.equal(s.get(`/_vm/enter?t=${s.ticket()}`).status, 403, 'full: refused (fail closed)');
  s.clock.ms += 61_000;
  assert.equal(s.get(`/_vm/enter?t=${s.ticket()}`).status, 302, 'after the expiry the set is purged');
  assert.equal(s.gate.usedTickets(), 1);
});

test('a stale ticket id is not accepted again after a purge only when the ticket itself is expired', () => {
  const s = setup();
  const t = s.ticket({ exp: s.clock.nowS() + 10 });
  assert.equal(s.get(`/_vm/enter?t=${t}`).status, 302);
  s.clock.ms += 10_000;
  assert.equal(s.get(`/_vm/enter?t=${t}`).status, 403, 'expired');
});

test('decide never throws and refuses garbage requests', () => {
  const s = setup();
  for (const r of [undefined, null, {}, { headers: null }, { headers: { host: host(ID_A) } }, { url: '/', headers: { host: host(ID_A), cookie: 5 } }, { url: '/', method: 'GET', headers: { host: host(ID_A), cookie: { toString() { throw new Error('x'); } } } }]) {
    const out = s.gate.decide(r);
    assert.ok(out.type === 'respond' && [403, 404, 410].includes(out.status), JSON.stringify(out.status));
  }
});

test('an unknown instance with a ticket gets 410, like any unknown host (no state is created by a ticket)', () => {
  const s = setup();
  const t = signTicket({ current: s.keys.current }, { inst: 'i-AAAAAAAAAAAAAAAA', own: s.ownerA, ae: 3, exp: s.clock.nowS() + 30, jti: newJti() });
  assert.equal(s.get(`/_vm/enter?t=${t}`, { id: 'i-AAAAAAAAAAAAAAAA' }).status, 410);
});

test('createGate refuses weak keys and bad zones', () => {
  const k = { current: randomKey() };
  for (const bad of [undefined, {}, { current: Buffer.alloc(31) }, { current: 'x'.repeat(40) }, { current: randomKey(), previous: Buffer.alloc(5) }]) assert.throws(() => createGate({ keys: bad, zone: ZONE }));
  for (const zone of ['Labs.test', 'labs.test.', 'labs', 'labs.test:443', '', '.labs.test', 'la bs.test', 'a..b', undefined, 5]) assert.throws(() => createGate({ keys: k, zone }), undefined, String(zone));
  assert.doesNotThrow(() => createGate({ keys: k, zone: 'labs.example.org' }));
});

test('a zone with several labels works and a host of another zone is refused', () => {
  const s = setup({ zone: 'labs.example.org' });
  assert.equal(s.get('/_vm/enter?t=' + s.ticket()).status, 302);
  assert.equal(status(s.get('/', { hostValue: `${ID_A.toLowerCase()}.example.org` })), 410);
});
