// Story edge-5: one active browser session per candidate (FR-SES-11, D-65) at the gate. The access epoch is the only session binding:
// every open and every login of the platform raises it (through the orchestrator, the only writer of gate state), and the gate refuses any
// cookie or ticket of an older epoch. The platform's own session store is not in this test (handoff H-136); only the gate half is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newJti } from '../src/tickets.mjs';
import { ID_A, setup } from './helpers.mjs';

const forwarded = (r) => r.type === 'forward';
const refused = (r) => r.type === 'respond' && r.status >= 400; // 403 page, or the paused / ended page of a frozen or closed instance
// the orchestrator pushes a new access state; the platform raised the epoch first (IF-5 `access`)
const push = (s, access, access_epoch) => {
  const r = s.gate.store.put(ID_A, s.record(ID_A, s.ownerA, { access, access_epoch }));
  assert.equal(r.status, 204);
};

test('second open: ticket at epoch n+1 gives cookie B, cookie A is refused at once and B works', () => {
  const s = setup();
  const A = s.login();
  assert.ok(forwarded(s.get('/', { cookie: A })));
  push(s, 'open', 4);
  const B = s.login({ ae: 4 });
  assert.ok(refused(s.get('/', { cookie: A })), 'the earlier browser tab lost the instance');
  assert.ok(forwarded(s.get('/', { cookie: B })));
  assert.notEqual(A, B);
});

test('login bump with no new open: A and B are refused until a new ticket of the new epoch', () => {
  const s = setup();
  const A = s.login();
  push(s, 'open', 4);
  const B = s.login({ ae: 4 });
  push(s, 'open', 5); // the platform raised the epoch at a login
  assert.ok(refused(s.get('/', { cookie: A })));
  assert.ok(refused(s.get('/', { cookie: B })));
  assert.ok(refused(s.get(`/_vm/enter?t=${s.ticket({ ae: 4 })}`)), 'a ticket of the old epoch does not help');
  const C = s.login({ ae: 5 });
  assert.ok(forwarded(s.get('/', { cookie: C })));
  assert.ok(refused(s.get('/', { cookie: B })));
});

test('the same ticket twice: the replay is refused and the first cookie still works', () => {
  const s = setup();
  const t = s.ticket();
  const first = s.get(`/_vm/enter?t=${t}`);
  assert.equal(first.status, 302);
  const cookie = first.headers['set-cookie'].split(';')[0];
  assert.ok(refused(s.get(`/_vm/enter?t=${t}`)));
  assert.ok(forwarded(s.get('/', { cookie })));
});

test('freeze then thaw: a cookie from before the freeze does not survive the thaw, a new ticket is needed', () => {
  const s = setup();
  const A = s.login();
  push(s, 'frozen', 4);
  assert.ok(refused(s.get('/', { cookie: A })));
  push(s, 'open', 5);
  assert.ok(refused(s.get('/', { cookie: A })));
  assert.ok(forwarded(s.get('/', { cookie: s.login({ ae: 5 }) })));
});

test('closed: nothing works, not even a fresh ticket of the right epoch', () => {
  const s = setup();
  const A = s.login();
  push(s, 'closed', 4);
  assert.ok(refused(s.get('/', { cookie: A })));
  assert.ok(refused(s.get(`/_vm/enter?t=${s.ticket({ ae: 4 })}`)));
});

test('rotation: a ticket signed with the previous key is accepted while the previous key is configured, not after it is removed', () => {
  const s = setup();
  push(s, 'open', 4);
  const r = s.get(`/_vm/enter?t=${s.ticket({ ae: 4 }, s.keys.previous)}`);
  assert.equal(r.status, 302);
  const late = s.ticket({ ae: 4, jti: newJti() }, s.keys.previous);
  s.keys.previous = null;
  assert.ok(refused(s.get(`/_vm/enter?t=${late}`)), 'the previous key is removed');
});

test('a stale state push cannot lower the epoch: the earlier tab cannot be brought back', () => {
  const s = setup();
  const A = s.login();
  push(s, 'open', 4);
  const r = s.gate.store.put(ID_A, s.record(ID_A, s.ownerA, { access: 'open', access_epoch: 3 }));
  assert.notEqual(r.status, 204);
  assert.ok(refused(s.get('/', { cookie: A })));
});


