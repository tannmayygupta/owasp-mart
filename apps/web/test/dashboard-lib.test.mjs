// Story P-26: the browser-side helpers of the dashboards, run by Node directly (type stripping), with a stand-in fetch.
//   node --test apps/web/test/dashboard-lib.test.mjs
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, api, download, duration, say, setCsrf } from '../lib/api.ts';
import { safeNext } from '../lib/paths.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setCsrf(null);
});

function stub(status, body, headers = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return calls;
}

test('a GET goes to the same origin with the cookie and no CSRF header', async () => {
  const calls = stub(200, { items: [] });
  setCsrf('csrf-1');
  assert.deepEqual(await api('GET', '/api/v1/me/invites'), { items: [] });
  assert.equal(calls[0].url, '/api/v1/me/invites');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['x-csrf-token'], undefined);
});

test('a state-changing call sends the CSRF token and a JSON body', async () => {
  const calls = stub(200, { attempt_id: 'a-AAAAAAAAAAAAAAAA' });
  setCsrf('csrf-2');
  await api('POST', '/api/v1/invites/accept', { token: 't' });
  assert.equal(calls[0].init.headers['x-csrf-token'], 'csrf-2');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.body, '{"token":"t"}');
});

test('204 answers nothing, a problem body becomes an ApiError with its code and Retry-After', async () => {
  stub(204);
  assert.equal(await api('DELETE', '/api/v1/session'), undefined);
  stub(429, { code: 'REQ-RATE-LIMITED' }, { 'retry-after': '30' });
  await assert.rejects(api('POST', '/api/v1/invites/open', { token: 'x' }), (e) => e instanceof ApiError && e.status === 429 && e.code === 'REQ-RATE-LIMITED' && e.retryAfter === 30);
});

test('a network failure is the NETWORK error, not an exception from fetch', async () => {
  globalThis.fetch = async () => { throw new TypeError('failed to fetch'); };
  await assert.rejects(api('GET', '/api/v1/session'), (e) => e instanceof ApiError && e.code === 'NETWORK' && e.status === 0);
});

test('messages: known codes read as sentences, the password rule sentence is shown as it is, unknown codes are named', () => {
  assert.equal(say(new ApiError(409, 'INST-QUOTA-REACHED')), 'You already have a running instance. Stop it before starting another.');
  assert.equal(say(new ApiError(422, 'REQ-VALIDATION', 'The password is too common.')), 'The password is too common.');
  assert.equal(say(new ApiError(418, 'XYZ-NEW')), 'Something went wrong (XYZ-NEW).');
  assert.equal(say(new Error('boom')), 'Something went wrong.');
});

test('after sign-in only a same-origin path is followed (no open redirect)', () => {
  assert.equal(safeNext('/invite'), '/invite');
  assert.equal(safeNext('/assessment/a-AAAAAAAAAAAAAAAA?x=1'), '/assessment/a-AAAAAAAAAAAAAAAA?x=1');
  for (const bad of [null, '', 'https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', '/ok\nSet-Cookie: x']) {
    assert.equal(safeNext(bad), '/dashboard', String(bad));
  }
});

test('durations read as hours, minutes and seconds; a missing one is a dash (story P-27)', () => {
  assert.equal(duration(3723), '1h 02m 03s');
  assert.equal(duration(59.6), '0h 01m 00s');
  assert.equal(duration(0), '0h 00m 00s');
  assert.equal(duration(-5), '0h 00m 00s');
  for (const missing of [null, undefined, Number.NaN]) assert.equal(duration(missing), '-');
});

test('a refused export is the ApiError of its problem body, sent with the CSRF token (story P-29)', async () => {
  const calls = stub(404, { code: 'ATT-NOT-FOUND' });
  setCsrf('csrf-3');
  await assert.rejects(download('/api/v1/company/exports', { template_id: 'x' }, 'r.zip'), (e) => e instanceof ApiError && e.status === 404 && e.code === 'ATT-NOT-FOUND');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-csrf-token'], 'csrf-3');
  assert.equal(calls[0].init.body, '{"template_id":"x"}');
});
