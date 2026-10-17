import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { configFromEnv, exitCodeOf, headerProblems, runSmoke } from './live-smoke.mjs';

const GOOD = { 'x-content-type-options': 'nosniff' };

// A local server with one behaviour per path. `mode` switches the shared header set.
function server() {
  const state = { mode: 'good' };
  const srv = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    const h = { ...GOOD };
    if (state.mode === 'no-nosniff') delete h['x-content-type-options'];
    if (state.mode === 'powered-by') h['x-powered-by'] = 'Express';
    if (state.mode === 'secret-leak') h['x-origin-secret'] = 'x';
    if (req.url === '/') {
      res.writeHead(200, h);
      return res.end('<html>ok</html>');
    }
    if (req.url === '/api/v1/health') {
      res.writeHead(state.mode === 'health-500' ? 500 : 200, h);
      return res.end('{"status":"ok"}');
    }
    if (req.url === '/api/v1/version') {
      res.writeHead(200, h);
      return res.end(state.mode === 'empty-version' ? '' : '{"version":"1.2.3"}');
    }
    if (req.url === '/extra') {
      res.writeHead(200, h);
      return res.end('ok');
    }
    res.writeHead(404, h);
    res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('configFromEnv: defaults, errors, extras', () => {
  assert.match(configFromEnv({}).error, /SMOKE_BASE_URL is not set/);
  assert.match(configFromEnv({ SMOKE_BASE_URL: 'nope' }).error, /not a valid URL/);
  assert.match(configFromEnv({ SMOKE_BASE_URL: 'ftp://x' }).error, /http or https/);
  assert.match(configFromEnv({ SMOKE_BASE_URL: 'http://x', SMOKE_EXTRA_URLS: 'a b' }).error, /not a valid URL/);
  const c = configFromEnv({ SMOKE_BASE_URL: 'http://x:81/path', SMOKE_EXTRA_URLS: 'http://a/, http://b/' });
  assert.equal(c.base, 'http://x:81');
  assert.equal(c.healthPath, '/api/v1/health');
  assert.equal(c.versionPath, null);
  assert.deepEqual(c.extra, ['http://a/', 'http://b/']);
});

test('headerProblems', () => {
  assert.deepEqual(headerProblems(GOOD, 'http://x'), []);
  assert.deepEqual(headerProblems({ ...GOOD, 'strict-transport-security': 'max-age=1' }, 'https://x'), []);
  assert.match(headerProblems(GOOD, 'https://x')[0], /strict-transport-security/);
  assert.match(headerProblems({}, 'http://x')[0], /missing header x-content-type-options/);
  assert.match(headerProblems({ 'x-content-type-options': 'sniff' }, 'http://x')[0], /wrong value/);
  assert.match(headerProblems({ ...GOOD, 'x-origin-secret': 'a' }, 'http://x')[0], /forbidden header x-origin-secret/);
  assert.match(headerProblems({ ...GOOD, 'x-powered-by': 'a' }, 'http://x')[0], /x-powered-by/);
});

test('local server: all good passes', async () => {
  const { srv, base } = await server();
  try {
    const rows = await runSmoke({ base, healthPath: '/api/v1/health', versionPath: '/api/v1/version', expectVersion: '1.2.3', extra: [`${base}/extra`] });
    assert.deepEqual(rows.map((r) => r.status), ['PASS', 'PASS', 'PASS', 'PASS']);
    assert.equal(exitCodeOf(rows), 0);
  } finally {
    srv.close();
  }
});

test('local server: a bad header fails the run', async () => {
  const { srv, state, base } = await server();
  try {
    for (const [mode, re] of [['no-nosniff', /missing header x-content-type-options/], ['powered-by', /x-powered-by/], ['secret-leak', /x-origin-secret/]]) {
      state.mode = mode;
      const rows = await runSmoke({ base, healthPath: '/api/v1/health', versionPath: null, expectVersion: null, extra: [] });
      assert.equal(exitCodeOf(rows), 1, mode);
      assert.match(rows[0].detail, re);
    }
  } finally {
    srv.close();
  }
});

test('local server: a 500, a missing version text and an empty version fail', async () => {
  const { srv, state, base } = await server();
  try {
    state.mode = 'health-500';
    let rows = await runSmoke({ base, healthPath: '/api/v1/health', versionPath: null, expectVersion: null, extra: [] });
    assert.equal(rows[1].status, 'FAIL');
    assert.match(rows[1].detail, /HTTP 500/);
    state.mode = 'good';
    rows = await runSmoke({ base, healthPath: '/api/v1/health', versionPath: '/api/v1/version', expectVersion: '9.9.9', extra: [] });
    assert.match(rows[2].detail, /expected version/);
    state.mode = 'empty-version';
    rows = await runSmoke({ base, healthPath: '/api/v1/health', versionPath: '/api/v1/version', expectVersion: null, extra: [] });
    assert.match(rows[2].detail, /empty body/);
    rows = await runSmoke({ base, healthPath: '/nope', versionPath: null, expectVersion: null, extra: [] });
    assert.match(rows[1].detail, /HTTP 404/);
  } finally {
    srv.close();
  }
});

test('nothing listening: FAIL with a reason, never PASS', async () => {
  const { srv, base } = await server();
  srv.close();
  const rows = await runSmoke({ base, healthPath: '/api/v1/health', versionPath: null, expectVersion: null, extra: [] });
  assert.ok(rows.every((r) => r.status === 'FAIL' && /no answer/.test(r.detail)));
  assert.equal(exitCodeOf([]), 1);
});

test('only GET is sent', async () => {
  const methods = [];
  const srv = http.createServer((req, res) => {
    methods.push(req.method);
    res.writeHead(200, GOOD);
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await runSmoke({ base: `http://127.0.0.1:${srv.address().port}`, healthPath: '/h', versionPath: '/v', expectVersion: null, extra: [] });
    assert.deepEqual([...new Set(methods)], ['GET']);
  } finally {
    srv.close();
  }
});
