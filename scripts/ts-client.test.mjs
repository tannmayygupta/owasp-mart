// Runtime test of the hand-written part of the typed client (packages/ts-client/src/index.ts): cookies, the CSRF header, the error body.
// Node runs the TypeScript file directly (type stripping); a stub `fetch` records the requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ERROR_CODES, ERRORS, isProblem, problemType } from '../packages/ts-client/src/index.ts';

const stub = (status = 200, body = {}) => {
  const seen = [];
  const fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
  };
  return { fetch, seen };
};
const login = { email: 'ada@example.org', password: 'correct-horse-battery-staple' };

test('an unsafe request carries X-CSRF-Token, a safe one does not', async () => {
  const s = stub();
  const api = createApiClient({ baseUrl: 'http://localhost:3000', csrfToken: () => 'tok-123', fetch: s.fetch });
  await api.GET('/api/v1/health');
  await api.POST('/api/v1/session', { body: login });
  await api.PATCH('/api/v1/me', { body: { display_name: 'Ada' } });
  await api.DELETE('/api/v1/session');
  const byMethod = Object.fromEntries(s.seen.map((r) => [r.method, r.headers.get('x-csrf-token')]));
  assert.equal(byMethod.GET, null);
  assert.equal(byMethod.POST, 'tok-123');
  assert.equal(byMethod.PATCH, 'tok-123');
  assert.equal(byMethod.DELETE, 'tok-123');
});

test('the token is read when the request is made, not when the client is created', async () => {
  const s = stub();
  let token = 'first';
  const api = createApiClient({ csrfToken: () => token, fetch: s.fetch, baseUrl: 'http://localhost:3000' });
  await api.POST('/api/v1/session', { body: login });
  token = 'second';
  await api.POST('/api/v1/session', { body: login });
  assert.deepEqual(s.seen.map((r) => r.headers.get('x-csrf-token')), ['first', 'second']);
});

test('without a token (not signed in) no X-CSRF-Token is sent', async () => {
  const s = stub();
  const api = createApiClient({ csrfToken: () => undefined, fetch: s.fetch, baseUrl: 'http://localhost:3000' });
  await api.POST('/api/v1/session', { body: login });
  assert.equal(s.seen[0].headers.get('x-csrf-token'), null);
  const bare = createApiClient({ fetch: s.fetch, baseUrl: 'http://localhost:3000' });
  await bare.POST('/api/v1/session', { body: login });
  assert.equal(s.seen[1].headers.get('x-csrf-token'), null);
});

test('requests are sent with cookies (credentials include) to the base URL and the path of the bundle', async () => {
  const s = stub();
  const api = createApiClient({ baseUrl: 'http://localhost:3000', fetch: s.fetch });
  await api.GET('/api/v1/challenges/{challenge_key}', { params: { path: { challenge_key: 'C03' } } });
  assert.equal(s.seen[0].credentials, 'include');
  assert.equal(s.seen[0].url, 'http://localhost:3000/api/v1/challenges/C03');
});

test('an error answer is returned as error, and isProblem recognises the IF-8 body only', async () => {
  const problem = { type: problemType(ERROR_CODES.AUTH_INVALID_CREDENTIALS), title: ERRORS['AUTH-INVALID-CREDENTIALS'].title, status: 401, code: 'AUTH-INVALID-CREDENTIALS', request_id: 'req-0a1b2c3d' };
  const s = stub(401, problem);
  const api = createApiClient({ baseUrl: 'http://localhost:3000', fetch: s.fetch });
  const r = await api.POST('/api/v1/session', { body: login });
  assert.equal(r.data, undefined);
  assert.ok(isProblem(r.error));
  assert.equal(r.error.code, 'AUTH-INVALID-CREDENTIALS');
  assert.equal(isProblem(null), false);
  assert.equal(isProblem('x'), false);
  assert.equal(isProblem({ code: 'x' }), false);
  assert.equal(isProblem({ ...problem, status: '401' }), false);
  // the lab fragment keeps its own error body (lowercase codes, no urn type): it is not an IF-8 problem
  assert.equal(isProblem({ code: 'att_not_found', message: 'x', request_id: 'r' }), false);
});
