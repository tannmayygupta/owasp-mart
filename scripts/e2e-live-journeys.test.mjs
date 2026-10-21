import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { inviteToken, main, parseArgs, plan, readEnv, run, totp } from './e2e-live-journeys.mjs';

const ENV = { VM_E2E_RECRUITER_EMAIL: 'rec@acme.example', VM_E2E_RECRUITER_PASSWORD: 'pw-r', VM_E2E_ADMIN_EMAIL: 'adm@x.example', VM_E2E_ADMIN_PASSWORD: 'pw-a', VM_E2E_ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };

test('the RFC 6238 test vector: the secret of "12345678901234567890" gives 287082 at 59 seconds', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109000), '081804');
});

test('arguments: live needs an https origin and a mail source, local needs a loopback http origin and --skip-admin', () => {
  assert.match(parseArgs([]).error, /required/);
  assert.match(parseArgs(['--base', 'http://x.example', '--mailpit-ssh', 'ubuntu@h']).error, /https/);
  assert.match(parseArgs(['--base', 'https://x.example']).error, /mail source/);
  assert.match(parseArgs(['--base', 'https://x.example', '--mailpit-ssh', 'a b']).error, /ubuntu@host/);
  assert.match(parseArgs(['--base', 'https://x.example', '--mailpit-url', 'http://evil.example:8025']).error, /127\.0\.0\.1/);
  assert.match(parseArgs(['--local-e2e', 'https://127.0.0.1:1', '--skip-admin']).error, /http origin/);
  assert.match(parseArgs(['--local-e2e', 'http://example.com:1', '--skip-admin']).error, /127\.0\.0\.1/);
  assert.match(parseArgs(['--local-e2e', 'http://127.0.0.1:1']).error, /skip-admin/);
  assert.match(parseArgs(['--local-e2e', 'http://127.0.0.1:1', '--skip-admin', '--base', 'https://x.example']).error, /alone/);
  assert.match(parseArgs(['--nope']).error, /unknown/);
  assert.equal(parseArgs(['--base', 'https://x.example', '--mailpit-ssh', 'ubuntu@10.0.0.1']).mode, 'live');
  assert.equal(parseArgs(['--local-e2e', 'http://127.0.0.1:18080', '--skip-admin']).mode, 'local');
});

test('the environment is checked by name only and a value never appears in the message', () => {
  const o = parseArgs(['--base', 'https://x.example', '--mailpit-ssh', 'ubuntu@h']);
  const e = readEnv({ VM_E2E_RECRUITER_EMAIL: 'secret-address@x.example' }, o);
  assert.match(e.error, /VM_E2E_RECRUITER_PASSWORD/);
  assert.match(e.error, /VM_E2E_ADMIN_TOTP_SECRET/);
  assert.ok(!e.error.includes('secret-address'));
  assert.match(readEnv({ ...ENV, VM_E2E_ADMIN_TOTP_SECRET: 'not base32!' }, o).error, /base32/);
  assert.equal(readEnv(ENV, o).recruiter.email, 'rec@acme.example');
  assert.equal(readEnv({ VM_E2E_RECRUITER_EMAIL: 'a', VM_E2E_RECRUITER_PASSWORD: 'b' }, { ...o, skipAdmin: true }).admin, null);
});

test('the invite token is read from the mailed link only', () => {
  const t = 'a'.repeat(26) + '.' + 'B'.repeat(43);
  assert.equal(inviteToken(`Open https://s.example/invite?token=${t} now`), t);
  assert.equal(inviteToken('no link'), null);
  assert.equal(inviteToken('https://s.example/verify-email?token=' + 'A'.repeat(43)), null);
});

test('--dry-run prints the plan, makes no request and returns 0; a missing variable returns 2', async () => {
  const lines = []; const log = console.log; const err = console.error; console.log = (l) => lines.push(l); console.error = () => {};
  try {
    const code = await main(['--base', 'https://never-called.invalid', '--mailpit-ssh', 'ubuntu@h', '--dry-run'], ENV);
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /no request is made/);
    assert.match(text, /\[admin\] the admin signs in with the second factor/);
    assert.match(text, /\[recruiter\] the recruiter releases the results/);
    assert.ok(!text.includes('pw-r') && !text.includes('pw-a') && !text.includes('GEZDGNBV'));
    assert.equal(await main(['--base', 'https://never-called.invalid', '--mailpit-ssh', 'ubuntu@h', '--dry-run'], {}), 2);
    assert.equal(plan({ skipAdmin: true }).filter(([w]) => w === 'admin').length, 0);
  } finally { console.log = log; console.error = err; }
});

// ---- a fake platform for the local variant -----------------------------------------------------------------------------------------------------------------
function fakePlatform() {
  const state = { started: false, submitted: false, released: false, calls: [] };
  const TOKEN = 'a'.repeat(26) + '.' + 'B'.repeat(43);
  const FLAG = 'VM{' + 'A'.repeat(24) + '}';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const who = /__Host-vm_session=([a-z]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
      const j = body ? JSON.parse(body) : {};
      state.calls.push(`${req.method} ${url.pathname}`);
      const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
      const p = url.pathname;
      if (p === '/_e2e/seed') return send(200, { password: 'local-pw', candidates: { release: 'cand@c.example' }, tokens: { release: TOKEN } });
      if (p === '/_e2e/play') return send(200, { ok: true });
      if (p === '/_e2e/flag') return send(200, { flag: FLAG });
      if (p === '/api/v1/health') return send(200, { status: 'ok' });
      if (p === '/api/v1/session/mfa') {
        const ok = [-30000, 0, 30000].some((d) => totp(ENV.VM_E2E_ADMIN_TOTP_SECRET, Date.now() + d) === j.code) && j.mfa_ticket === 'T'.repeat(43);
        return ok ? send(200, { csrf_token: 'csrf-admin' }, { 'set-cookie': '__Host-vm_session=admin; Path=/; Secure; HttpOnly' }) : send(401, { code: 'AUTH-MFA-INVALID' });
      }
      if (p === '/api/v1/session' && j.email === 'adm@x.example') return j.password === 'pw-a' ? send(200, { status: 'mfa_required', mfa_ticket: 'T'.repeat(43) }) : send(401, { code: 'AUTH-INVALID-CREDENTIALS' });
      if (p === '/api/v1/session') {
        const role = j.email === 'rec@acme.example' ? 'recruiter' : j.email === 'cand@c.example' ? 'candidate' : null;
        if (!role || (j.password !== 'pw-r' && j.password !== 'local-pw')) return send(401, { code: 'AUTH-INVALID-CREDENTIALS' });
        return send(200, { csrf_token: 'csrf-' + role }, { 'set-cookie': `__Host-vm_session=${role}; Path=/; Secure; HttpOnly` });
      }
      if (p === '/api/v1/invites/open') return send(200, { company_name: 'Acme', title: 'Release assessment', state: 'sent' });
      if (who === null && p.startsWith('/api/v1/attempts/') && p.endsWith('/report')) return send(401, { code: 'AUTH-SESSION-REQUIRED' });
      if (who === null) return send(401, { code: 'AUTH-SESSION-REQUIRED' });
      if (p.startsWith('/api/v1/admin/')) return who === 'admin' ? send(200, { items: [] }) : send(404, { code: 'REQ-ROUTE-UNKNOWN' });
      if (who === 'admin' && p.startsWith('/api/v1/attempts/')) return send(404, { code: 'ATT-NOT-FOUND' });
      if (p === '/api/v1/company' && who === 'recruiter') return send(200, { state: 'active', terms_accepted: true, company_name: 'Acme' });
      if (p === '/api/v1/invites/accept') return send(200, { attempt_id: 'a-AAAAAAAAAAAAAAAA', invite_id: 'i-X' });
      if (p === '/api/v1/consent/notice') return send(200, { notice_version: '1', notice_text_sha256: '0'.repeat(64) });
      if (p === '/api/v1/consent') return send(201, {});
      if (p.endsWith('/start')) { state.started = true; return send(200, {}); }
      if (p === '/api/v1/attempts/a-AAAAAAAAAAAAAAAA') {
        const running = state.started && !state.submitted;
        return send(200, { attempt_id: 'a-AAAAAAAAAAAAAAAA', mode: 'candidate', state: state.submitted ? 'submitted' : running ? 'running' : 'ready', instance_id: running ? 'i-BBBBBBBBBBBBBBBB' : null,
          started_at: running ? '2026-10-21T10:00:00Z' : null, deadline_at: running ? '2026-10-21T10:30:00Z' : null });
      }
      if (p.endsWith('/flags')) return send(200, { challenge_key: j.challenge_key, result: j.flag === FLAG ? 'correct' : 'incorrect', credit: j.flag === FLAG ? 'credited' : 'none' });
      if (p.endsWith('/submit')) { state.submitted = true; return send(200, { state: 'submitted' }); }
      if (p.endsWith('/score')) return who === 'candidate' && !state.released ? send(404, { code: 'ATT-NOT-FOUND' }) : send(200, { score: 100 });
      if (p.endsWith('/report')) return who === 'recruiter' ? send(200, { score: 100, per_challenge: [{ challenge_key: 'C01', best_milestone: 'M3' }] }) : send(404, { code: 'ATT-NOT-FOUND' });
      if (p.endsWith('/timeline')) return send(200, { items: [{ type: 'attempt.started' }, { type: 'attempt.submitted' }] });
      if (p === '/api/v1/me/data-views') return send(200, { items: [{ company_name: 'Acme' }] });
      if (p === '/api/v1/company/invites') return send(200, { items: [{ attempt_id: 'a-AAAAAAAAAAAAAAAA', template_id: 't-1' }] });
      if (p.endsWith('/release')) { state.released = true; return send(200, { results_released: true }); }
      if (p === '/api/v1/company/exports') { res.writeHead(200, { 'content-type': 'application/zip' }); return res.end('PK-no-flag-here'); }
      return send(404, { code: 'REQ-ROUTE-UNKNOWN' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}`, FLAG })));
}

test('the local variant walks the whole hiring journey against a fake platform and every check passes', async () => {
  const f = await fakePlatform();
  const logs = []; const log = console.log; console.log = (l) => logs.push(l);
  try {
    const o = parseArgs(['--local-e2e', f.origin, '--skip-admin']);
    const creds = readEnv({ VM_E2E_RECRUITER_EMAIL: 'rec@acme.example', VM_E2E_RECRUITER_PASSWORD: 'pw-r' }, o);
    const rows = await run(o, creds, { sleep: async () => {} });
    const failed = rows.filter((r) => !r.ok);
    assert.deepEqual(failed, []);
    assert.ok(rows.length >= 18, `${rows.length} checks`);
    assert.ok(f.state.released && f.state.submitted);
    const printed = logs.join('\n');
    assert.ok(!printed.includes(f.FLAG) && !printed.includes('pw-r') && !printed.includes('local-pw'), 'nothing secret is printed');
  } finally { console.log = log; f.server.close(); }
});

test('a wrong recruiter password stops the run with one failing check', async () => {
  const f = await fakePlatform();
  const log = console.log; console.log = () => {};
  try {
    const o = parseArgs(['--local-e2e', f.origin, '--skip-admin']);
    const rows = await run(o, { recruiter: { email: 'rec@acme.example', password: 'wrong' }, admin: null }, { sleep: async () => {} });
    assert.equal(rows.filter((r) => !r.ok).length >= 2, true);
    assert.equal(rows.at(-1).name, 'the run stops here');
    assert.ok(!f.state.calls.includes('POST /api/v1/invites/accept'));
  } finally { console.log = log; f.server.close(); }
});

test('with the admin steps on, the second-factor code is computed, the admin routes answer and the candidate answers stay closed', async () => {
  const f = await fakePlatform();
  const log = console.log; console.log = () => {};
  try {
    const o = parseArgs(['--local-e2e', f.origin, '--skip-admin']);
    o.skipAdmin = false;
    const creds = readEnv(ENV, o);
    const rows = await run(o, { ...creds, recruiter: { email: 'rec@acme.example', password: 'pw-r' } }, { sleep: async () => {} });
    assert.deepEqual(rows.filter((r) => !r.ok), []);
    assert.ok(rows.some((r) => /second factor/.test(r.name)) && rows.some((r) => /break-glass/.test(r.name)));
    assert.ok(f.state.calls.includes('POST /api/v1/session/mfa'));
    const g = await fakePlatform();
    const o2 = parseArgs(['--local-e2e', g.origin, '--skip-admin']); o2.skipAdmin = false;
    const bad = await run(o2, { ...creds, recruiter: { email: 'rec@acme.example', password: 'pw-r' }, admin: { ...creds.admin, password: 'wrong' } }, { sleep: async () => {} });
    assert.ok(bad.some((r) => /second factor/.test(r.name) && !r.ok));
    g.server.close();
  } finally { console.log = log; f.server.close(); }
});