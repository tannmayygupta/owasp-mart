// Shared test helpers (not a test file). All keys and secrets are random throwaway values made in the test run.
import crypto from 'node:crypto';
import { createGate } from '../src/gate.mjs';
import { signTicket, newJti } from '../src/tickets.mjs';

export const ZONE = 'labs.test';
export const ID_A = 'i-ABCDEFGHIJKLMNOP';
export const ID_B = 'i-QRSTUVWXYZ234567';
export const NOW_MS = 1_800_000_000_000;
export const host = (id, zone = ZONE) => `${id.toLowerCase()}.${zone}`;
export const randomKey = () => crypto.randomBytes(32);
export const randomOwner = () => crypto.randomBytes(32).toString('hex');

export function setup({ zone = ZONE } = {}) {
  const keys = { current: randomKey(), previous: randomKey() };
  const clock = { ms: NOW_MS, nowS: () => Math.floor(clock.ms / 1000) };
  const gate = createGate({ keys, zone, now: () => clock.ms });
  const ownerA = randomOwner();
  const ownerB = randomOwner();
  const record = (id, owner, over = {}) => ({ hostname: host(id, zone), instance_id: id, epoch: 1, owner, access: 'open', access_epoch: 3, ...over });
  const put = (id, owner, over = {}) => { const r = gate.store.put(id, record(id, owner, over)); if (r.status !== 204) throw new Error(`put failed ${r.status} ${r.error}`); };
  put(ID_A, ownerA);
  put(ID_B, ownerB);
  const ticket = (over = {}, key = keys.current) => signTicket({ current: key }, { inst: ID_A, own: ownerA, ae: 3, exp: clock.nowS() + 30, jti: newJti(), ...over });
  const get = (url, { id = ID_A, cookie, method = 'GET', headers = {}, hostValue } = {}) => gate.decide({ method, url, headers: { host: hostValue ?? host(id, zone), ...(cookie ? { cookie } : {}), ...headers } });
  // enters with a fresh ticket and returns the cookie pair "name=value" the browser would send
  const login = (over = {}, id = ID_A) => {
    const r = get(`/_vm/enter?t=${ticket(over)}`, { id });
    if (r.status !== 302) throw new Error(`login failed ${r.status}`);
    return r.headers['set-cookie'].split(';')[0];
  };
  return { keys, clock, gate, ownerA, ownerB, record, put, ticket, get, login };
}
