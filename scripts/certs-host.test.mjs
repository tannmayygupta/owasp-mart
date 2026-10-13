// Tests for the host certificate scripts (D-49, ADR 0030): vulnmart-certs.sh with a stub lego, a stub openssl and a fixed clock, and vulnmart-install-lego.sh with a stub curl.
// No network, no token, no Let's Encrypt. Needs a POSIX shell (Linux CI has one; on Windows Git for Windows' bash is used); the host-script tests skip if none is found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = path.join(ROOT, 'infra', 'hosts');
const fwd = (p) => p.replaceAll('\\', '/');

function findShell() {
  const c = process.platform === 'win32'
    ? ['C:\\git\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash', '/bin/sh'];
  return c.find((x) => existsSync(x));
}
const SHELL = findShell();
const skip = SHELL ? false : 'no POSIX shell found: the host script tests were not run';

// Stub lego: logs its arguments and whether the token reached it as a file (never the value), writes the certificate files unless told to fail.
const STUB_LEGO = `#!/bin/sh
echo "lego $*" >> "$STUB_LOG"
echo "token_file=\${DUCKDNS_TOKEN_FILE:-unset} token_var=\${DUCKDNS_TOKEN:-unset}" >> "$STUB_LOG"
[ "\${STUB_LEGO_FAIL:-0}" = 1 ] && { echo "lego: boom" >&2; exit 1; }
path=""; domain=""
while [ $# -gt 0 ]; do case "$1" in --path) path="$2"; shift ;; --domains) domain="$2"; shift ;; esac; shift; done
base=$(printf '%s' "$domain" | tr '*' '_')
mkdir -p "$path/certificates"
[ "\${STUB_LEGO_NOFILES:-0}" = 1 ] || { echo CERT > "$path/certificates/$base.crt"; echo KEY > "$path/certificates/$base.key"; }
if [ "\${STUB_LEGO_CRTDIR:-0}" = 1 ]; then rm -f "$path/certificates/$base.crt"; mkdir "$path/certificates/$base.crt"; echo x > "$path/certificates/$base.crt/f"; fi
`;
const STUB_OPENSSL = '#!/bin/sh\necho "notAfter=$STUB_NOTAFTER"\n';

// Run a host script with the stub folder first on PATH. Git bash (MSYS) puts its own /usr/bin first, so a stub named like a real tool (openssl, curl) must be put in front inside the shell.
const WRAP = 'PATH="$(cygpath -u "$STUBBIN" 2>/dev/null || echo "$STUBBIN"):$PATH"\nexport PATH\n_s=$1\nshift\n. "$_s"\n';
const runScript = (env, bin, script, args) => {
  const wrap = path.join(path.dirname(bin), 'wrap.sh');
  writeFileSync(wrap, WRAP);
  return spawnSync(SHELL, [fwd(wrap), fwd(path.join(HOSTS, script)), ...args], { env: { ...env, STUBBIN: fwd(bin), SHELL_PATH: SHELL }, encoding: 'utf8' });
};
function setup(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vm-certs-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  for (const [n, b] of [['lego', STUB_LEGO], ['openssl', STUB_OPENSSL]]) {
    writeFileSync(path.join(bin, n), b);
    chmodSync(path.join(bin, n), 0o755);
  }
  if (extra.STUB_CP_FAIL_CRT) { // a cp that fails only for the certificate copy: the old publish() went on, copied the key and returned 0 from its last mv
    writeFileSync(path.join(bin, 'cp'), '#!/bin/sh\ncase "$*" in *fullchain.pem.new*) exit 1 ;; esac\nexec /usr/bin/cp "$@"\n');
    chmodSync(path.join(bin, 'cp'), 0o755);
  }
  const token = path.join(dir, 'duckdns.token');
  writeFileSync(token, 'TOKEN-PLACEHOLDER-NOT-REAL\n');
  chmodSync(token, 0o600);
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    STUB_LOG: fwd(path.join(dir, 'log')), VULNMART_CERTS_ENV: '/nonexistent',
    CERT_DIR: fwd(path.join(dir, 'certs')), MARK_DIR: fwd(path.join(dir, 'marks')), TOKEN_FILE: fwd(token), LEGO_BIN: fwd(path.join(bin, 'lego')),
    CERT_NAME: 'demo.duckdns.org', CERT_EMAIL: 'ops@example.invalid', VULNMART_NOW: '1893456000', // 2030-01-01T00:00:00Z
    STUB_NOTAFTER: 'Mar  1 00:00:00 2030 GMT', OPENSSL_BIN: fwd(path.join(bin, 'openssl')), ...extra,
  };
  const run = (script, ...args) => runScript(env, bin, script, args);
  const runWith = (more, script, ...args) => runScript({ ...env, ...more }, bin, script, args);
  const log = () => (existsSync(path.join(dir, 'log')) ? readFileSync(path.join(dir, 'log'), 'utf8').split('\n').filter(Boolean) : []);
  const mark = (n) => existsSync(path.join(dir, 'marks', n));
  const put = (rel, text = 'x') => { const f = path.join(dir, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  return { dir, run, runWith, log, mark, put, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
const legoCalls = (s) => s.log().filter((l) => l.startsWith('lego '));

test('staging issue: lego runs against the staging server with the token as a file, files are written, marker set, no token value anywhere', { skip }, () => {
  const s = setup();
  try {
    const r = s.run('vulnmart-certs.sh', 'issue');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const calls = legoCalls(s);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /--server https:\/\/acme-staging-v02\.api\.letsencrypt\.org\/directory/);
    assert.match(calls[0], /--dns duckdns/);
    assert.match(calls[0], /--domains demo\.duckdns\.org/);
    assert.match(calls[0], / run$/);
    assert.ok(s.log().some((l) => l.includes('token_file=') && !l.includes('token_file=unset') && l.includes('token_var=unset')), 'token passed as a file only');
    assert.ok(existsSync(path.join(s.dir, 'certs', 'staging', 'fullchain.pem')) && existsSync(path.join(s.dir, 'certs', 'staging', 'privkey.pem')));
    assert.ok(!existsSync(path.join(s.dir, 'certs', 'live')), 'staging never writes the live folder');
    assert.ok(s.mark('certs-staging-ok') && !s.mark('certs-ok') && !s.mark('certs-failed'));
    assert.ok(!(r.stdout + r.stderr + s.log().join('\n')).includes('TOKEN-PLACEHOLDER'));
  } finally { s.clean(); }
});

test('wildcard name is accepted and the files are found under the underscore name', { skip }, () => {
  const s = setup({ CERT_NAME: '*.labs1.duckdns.org' });
  try {
    const r = s.run('vulnmart-certs.sh', 'issue');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(legoCalls(s)[0], /--domains \*\.labs1\.duckdns\.org/);
  } finally { s.clean(); }
});

test('token missing: exit 2, message, no lego call', { skip }, () => {
  const s = setup({ TOKEN_FILE: '/nonexistent/token' });
  try {
    const r = s.run('vulnmart-certs.sh', 'issue');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /token file not found/);
    assert.equal(legoCalls(s).length, 0);
  } finally { s.clean(); }
});

test('bad names are refused with exit 2 and no lego call', { skip }, () => {
  for (const name of ['example.com', 'a.b.duckdns.org', '*.a.b.duckdns.org', 'x*.duckdns.org', '.duckdns.org', '*.duckdns.org', 'evil.duckdns.org.example.com', '']) {
    const s = setup({ CERT_NAME: name });
    try {
      const r = s.run('vulnmart-certs.sh', 'issue');
      assert.equal(r.status, 2, `name "${name}": ${r.stderr}`);
      assert.equal(legoCalls(s).length, 0);
    } finally { s.clean(); }
  }
});

test('production before staging is refused with the reason; after a staging marker it runs against production and writes live/', { skip }, () => {
  const s = setup();
  try {
    const early = s.run('vulnmart-certs.sh', 'issue', '--production');
    assert.equal(early.status, 1);
    assert.match(early.stderr, /no staging success marker/);
    assert.equal(legoCalls(s).length, 0);
    assert.equal(s.run('vulnmart-certs.sh', 'issue').status, 0);
    const prod = s.run('vulnmart-certs.sh', 'issue', '--production');
    assert.equal(prod.status, 0, prod.stderr);
    assert.match(legoCalls(s).at(-1), /--server https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/);
    assert.ok(existsSync(path.join(s.dir, 'certs', 'live', 'fullchain.pem')));
    assert.ok(s.mark('certs-ok'));
  } finally { s.clean(); }
});

function production(s) {
  assert.equal(s.run('vulnmart-certs.sh', 'issue').status, 0);
  assert.equal(s.run('vulnmart-certs.sh', 'issue', '--production').status, 0);
}

test('renew when not due: no-op, exit 0, lego not called', { skip }, () => {
  const s = setup(); // notAfter 2030-03-01, now 2030-01-01: 59 days left, threshold 30
  try {
    production(s);
    const before = legoCalls(s).length;
    const r = s.run('vulnmart-certs.sh', 'renew');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to do/);
    assert.equal(legoCalls(s).length, before);
  } finally { s.clean(); }
});

test('renew when due: lego renew runs against production with --days; the clock stub decides', { skip }, () => {
  const s = setup({ STUB_NOTAFTER: 'Jan 20 00:00:00 2030 GMT' }); // 19 days left
  try {
    production(s);
    const r = s.run('vulnmart-certs.sh', 'renew');
    assert.equal(r.status, 0, r.stderr);
    const last = legoCalls(s).at(-1);
    assert.match(last, /acme-v02\.api\.letsencrypt\.org/);
    assert.match(last, / renew --days 30$/);
    assert.ok(s.mark('certs-ok') && !s.mark('certs-failed'));
  } finally { s.clean(); }
});

test('renew with no production certificate yet: no-op, exit 0, even when staging exists', { skip }, () => {
  const s = setup();
  try {
    assert.equal(s.run('vulnmart-certs.sh', 'issue').status, 0);
    const before = legoCalls(s).length;
    assert.equal(s.run('vulnmart-certs.sh', 'renew').status, 0);
    assert.equal(legoCalls(s).length, before);
  } finally { s.clean(); }
});

test('renewal failure: lego non-zero gives exit 1 and a failure marker; the next success clears it', { skip }, () => {
  const s = setup({ STUB_NOTAFTER: 'Jan 20 00:00:00 2030 GMT' });
  try {
    production(s);
    const r = s.runWith({ STUB_LEGO_FAIL: '1' }, 'vulnmart-certs.sh', 'renew');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /renewal failed/);
    assert.ok(s.mark('certs-failed'));
    const st = s.run('vulnmart-certs.sh', 'status', '--short');
    assert.match(st.stdout, /^failed:/);
    assert.equal(s.run('vulnmart-certs.sh', 'renew').status, 0);
    assert.ok(!s.mark('certs-failed'));
  } finally { s.clean(); }
});

test('issue failure writes the failure marker and exits 1; success without files is also a failure', { skip }, () => {
  const a = setup({ STUB_LEGO_FAIL: '1' });
  try {
    assert.equal(a.run('vulnmart-certs.sh', 'issue').status, 1);
    assert.ok(a.mark('certs-staging-failed') && !a.mark('certs-failed') && !a.mark('certs-staging-ok'));
  } finally { a.clean(); }
  const b = setup({ STUB_LEGO_NOFILES: '1' });
  try {
    assert.equal(b.run('vulnmart-certs.sh', 'issue').status, 1);
    assert.ok(b.mark('certs-staging-failed') && !b.mark('certs-failed') && !b.mark('certs-staging-ok'));
  } finally { b.clean(); }
});

test('status: none before issue (exit 1), ok with days after production', { skip }, () => {
  const s = setup();
  try {
    const none = s.run('vulnmart-certs.sh', 'status', '--short');
    assert.equal(none.status, 1);
    assert.equal(none.stdout.trim(), 'none:na');
    production(s);
    const ok = s.run('vulnmart-certs.sh', 'status', '--short');
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), 'ok:59');
    assert.match(s.run('vulnmart-certs.sh', 'status').stdout, /production_marker=yes/);
  } finally { s.clean(); }
});

test('unknown command and unknown option exit 2', { skip }, () => {
  const s = setup();
  try {
    assert.equal(s.run('vulnmart-certs.sh', 'bogus').status, 2);
    assert.equal(s.run('vulnmart-certs.sh', 'issue', '--bogus').status, 2);
    assert.equal(s.run('vulnmart-certs.sh', 'issue', '--production', '--bogus').status, 2);
  } finally { s.clean(); }
});

// ---- installer ----
function installerSetup(wrongSum = false, arch = 'x86_64') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vm-lego-'));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  const work = path.join(dir, 'work'); mkdirSync(work);
  writeFileSync(path.join(work, 'lego'), '#!/bin/sh\necho "lego version 5.5.2"\n');
  chmodSync(path.join(work, 'lego'), 0o755);
  const tgz = path.join(dir, 'fixture.tar.gz');
  const t = spawnSync(SHELL, ['-c', 'tar -czf fixture.tar.gz -C work lego'], { cwd: dir, encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  const sum = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nout=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done\necho "$url" >> "${fwd(path.join(dir, 'curl.log'))}"\ncp "${fwd(tgz)}" "$out"\n`);
  chmodSync(path.join(bin, 'curl'), 0o755);
  const pin = path.join(dir, 'pin.json');
  writeFileSync(pin, `{\n  "version": "v5.5.2",\n  "url_prefix": "https://example.invalid/",\n  "amd64_file": "lego_v5.5.2_linux_amd64.tar.gz",\n  "amd64_sha256": "${wrongSum && arch === 'x86_64' ? '0'.repeat(64) : sum}",\n  "arm64_file": "lego_v5.5.2_linux_arm64.tar.gz",\n  "arm64_sha256": "${wrongSum && arch === 'aarch64' ? '0'.repeat(64) : sum}"\n}\n`);
  const dest = path.join(dir, 'installed-lego');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, LEGO_PIN: fwd(pin), LEGO_DEST: fwd(dest), LEGO_ARCH: arch, CURL_BIN: fwd(path.join(bin, 'curl')) };
  return { dir, dest, curlLog: () => readFileSync(path.join(dir, 'curl.log'), 'utf8'), run: () => runScript(env, bin, 'vulnmart-install-lego.sh', []), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('installer: a matching checksum installs lego; a second run is a no-op', { skip }, () => {
  const s = installerSetup();
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(s.dest));
    assert.match(s.run().stdout, /already installed/);
  } finally { s.clean(); }
});

test('installer: a checksum mismatch is refused (exit 1) and nothing is installed', { skip }, () => {
  const s = installerSetup(true);
  try {
    const r = s.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checksum mismatch/);
    assert.ok(!existsSync(s.dest));
  } finally { s.clean(); }
});

// ---- review fixes: markers per mode, guards, settings file, lock, renew edge cases ----
test('a staging success does not hide a production renewal failure, and a staging failure does not mark a good certificate failed', { skip }, () => {
  const s = setup({ STUB_NOTAFTER: 'Jan 20 00:00:00 2030 GMT' });
  try {
    production(s);
    assert.equal(s.runWith({ STUB_LEGO_FAIL: '1' }, 'vulnmart-certs.sh', 'renew').status, 1);
    assert.ok(s.mark('certs-failed'));
    // a successful staging run clears only the staging marker; the production failure stays
    assert.equal(s.run('vulnmart-certs.sh', 'issue').status, 0);
    assert.ok(s.mark('certs-failed'), 'production failure marker survives a staging success');
    assert.match(s.run('vulnmart-certs.sh', 'status', '--short').stdout, /^failed:/);
    // a staging failure leaves the production state alone
    assert.equal(s.runWith({ STUB_LEGO_FAIL: '1' }, 'vulnmart-certs.sh', 'issue').status, 1);
    assert.ok(s.mark('certs-staging-failed'));
    assert.equal(s.run('vulnmart-certs.sh', 'renew').status, 0);
    assert.ok(!s.mark('certs-failed') && s.mark('certs-staging-failed'), 'a production success clears only the production marker');
    assert.match(s.run('vulnmart-certs.sh', 'status', '--short').stdout, /^ok:/, 'status ignores the staging marker');
  } finally { s.clean(); }
});

test('a staging failure alone does not turn a good production certificate into failed', { skip }, () => {
  const s = setup();
  try {
    production(s);
    assert.equal(s.runWith({ STUB_LEGO_FAIL: '1' }, 'vulnmart-certs.sh', 'issue').status, 1);
    assert.ok(s.mark('certs-staging-failed') && !s.mark('certs-failed'));
    assert.equal(s.run('vulnmart-certs.sh', 'status', '--short').stdout.trim(), 'ok:59');
  } finally { s.clean(); }
});

test('production guard: the staging marker must be for the same name, and an existing good certificate needs --force', { skip }, () => {
  const s = setup();
  try {
    assert.equal(s.run('vulnmart-certs.sh', 'issue').status, 0);
    const other = s.runWith({ CERT_NAME: 'other.duckdns.org' }, 'vulnmart-certs.sh', 'issue', '--production');
    assert.equal(other.status, 1);
    assert.match(other.stderr, /different name/);
    assert.ok(!legoCalls(s).some((l) => l.includes('acme-v02')), 'no production call');
    assert.equal(s.run('vulnmart-certs.sh', 'issue', '--production').status, 0);
    const calls = legoCalls(s).length;
    const dup = s.run('vulnmart-certs.sh', 'issue', '--production');
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /59 days left already exists/);
    assert.equal(legoCalls(s).length, calls);
    const forced = s.run('vulnmart-certs.sh', 'issue', '--production', '--force');
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(legoCalls(s).length, calls + 1);
  } finally { s.clean(); }
});

test('renew exits 0 with no token and no settings when there is nothing to renew or it is not due; it needs them only when it must renew', { skip }, () => {
  const none = setup({ TOKEN_FILE: '/nonexistent/token', CERT_NAME: '', CERT_EMAIL: '' });
  try {
    const r = none.run('vulnmart-certs.sh', 'renew');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(legoCalls(none).length, 0);
  } finally { none.clean(); }
  const s = setup();
  try {
    production(s);
    assert.equal(s.runWith({ TOKEN_FILE: '/nonexistent/token' }, 'vulnmart-certs.sh', 'renew').status, 0, 'not due: no token check');
  } finally { s.clean(); }
  const due = setup({ STUB_NOTAFTER: 'Jan 20 00:00:00 2030 GMT' });
  try {
    production(due);
    const r = due.runWith({ TOKEN_FILE: '/nonexistent/token' }, 'vulnmart-certs.sh', 'renew');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /token file not found/);
  } finally { due.clean(); }
});

test('renew without the lego state file fails clearly with the production failure marker', { skip }, () => {
  const s = setup({ STUB_NOTAFTER: 'Jan 20 00:00:00 2030 GMT' });
  try {
    production(s);
    rmSync(path.join(s.dir, 'certs', 'lego-production'), { recursive: true, force: true });
    const before = legoCalls(s).length;
    const r = s.run('vulnmart-certs.sh', 'renew');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lego state of the production issue is missing/);
    assert.ok(s.mark('certs-failed'));
    assert.equal(legoCalls(s).length, before);
  } finally { s.clean(); }
});

test('an expired certificate (negative days) renews, and so does an unreadable one (no days)', { skip }, () => {
  const expired = setup({ STUB_NOTAFTER: 'Dec  1 00:00:00 2029 GMT' }); // -31 days
  try {
    production(expired);
    assert.equal(expired.run('vulnmart-certs.sh', 'status', '--short').stdout.trim(), 'ok:-31');
    const before = legoCalls(expired).length;
    assert.equal(expired.run('vulnmart-certs.sh', 'renew').status, 0);
    assert.equal(legoCalls(expired).length, before + 1);
  } finally { expired.clean(); }
  const unreadable = setup();
  try {
    production(unreadable);
    const before = legoCalls(unreadable).length;
    const r = unreadable.runWith({ STUB_NOTAFTER: 'not a date' }, 'vulnmart-certs.sh', 'renew');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /days left: unknown/);
    assert.equal(legoCalls(unreadable).length, before + 1);
  } finally { unreadable.clean(); }
});

test('certs.env is read as KEY=value lines only: values, environment wins, RENEW_DAYS, quotes, nothing executed, LEGO_EXTRA_ARGS reaches lego', { skip }, () => {
  const s = setup({ CERT_NAME: undefined, CERT_EMAIL: undefined, TOKEN_FILE: undefined, CERT_DIR: undefined });
  try {
    const marker = path.join(s.dir, 'executed');
    const envFile = path.join(s.dir, 'certs.env');
    writeFileSync(envFile, [
      '# a comment', '', 'CERT_NAME="file.duckdns.org"', "CERT_EMAIL='ops@example.invalid'", 'RENEW_DAYS=70', 'LEGO_EXTRA_ARGS=--dns.propagation-wait 60s',
      'EVIL=$(touch ' + fwd(marker) + ')', 'touch ' + fwd(marker), 'CERT_DIR=' + fwd(path.join(s.dir, 'certs')), 'TOKEN_FILE=' + fwd(path.join(s.dir, 'duckdns.token')), 'UNKNOWN=1', '',
    ].join('\r\n'));
    const base = { VULNMART_CERTS_ENV: fwd(envFile) };
    // values from the file; a line with spaces or $(...) is never executed; LEGO_EXTRA_ARGS reaches lego
    assert.equal(s.runWith({ ...base, CERT_NAME: undefined }, 'vulnmart-certs.sh', 'issue').status, 0);
    assert.ok(!existsSync(marker), 'nothing from the file was executed');
    const call = legoCalls(s)[0];
    assert.match(call, /--domains file\.duckdns\.org/);
    assert.match(call, /--email ops@example\.invalid/);
    assert.match(call, /--dns\.propagation-wait 60s run$/);
    // the environment wins over the file
    const s2 = s.runWith({ ...base, CERT_NAME: 'env.duckdns.org' }, 'vulnmart-certs.sh', 'issue');
    assert.equal(s2.status, 0, s2.stderr);
    assert.match(legoCalls(s).at(-1), /--domains env\.duckdns\.org/);
  } finally { s.clean(); }
  // RENEW_DAYS from the file changes the threshold: 59 days left is "due" at 70, "not due" at the default 30
  const r = setup();
  try {
    production(r);
    const envFile = path.join(r.dir, 'certs.env');
    writeFileSync(envFile, 'CERT_NAME=demo.duckdns.org\nCERT_EMAIL=ops@example.invalid\nRENEW_DAYS=70\n');
    const before = legoCalls(r).length;
    const run = r.runWith({ VULNMART_CERTS_ENV: fwd(envFile), CERT_NAME: undefined, CERT_EMAIL: undefined }, 'vulnmart-certs.sh', 'renew');
    assert.equal(run.status, 0, run.stderr);
    assert.match(legoCalls(r).at(-1), / renew --days 70$/);
    assert.equal(legoCalls(r).length, before + 1);
  } finally { r.clean(); }
  const bad = setup({ RENEW_DAYS: 'soon' });
  try {
    assert.equal(bad.run('vulnmart-certs.sh', 'status').status === 2, true, 'a non-numeric RENEW_DAYS is refused');
  } finally { bad.clean(); }
});

test('a second run while one is running exits 1 "already running" (needs flock)', { skip: skip || (spawnSync(SHELL, ['-c', 'command -v flock'], { encoding: 'utf8' }).status !== 0 && 'flock is not available in this shell (Linux CI has it)') }, async () => {
  const s = setup();
  try {
    mkdirSync(path.join(s.dir, 'marks'), { recursive: true });
    const lock = fwd(path.join(s.dir, 'marks', 'certs.lock'));
    const { spawn } = await import('node:child_process');
    const holder = spawn(SHELL, ['-c', 'exec 9>"$1"; flock 9; sleep 5', 'x', lock], { stdio: 'ignore' });
    await new Promise((res) => setTimeout(res, 800));
    const r = s.run('vulnmart-certs.sh', 'issue');
    holder.kill();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /already running/);
    assert.equal(legoCalls(s).length, 0);
  } finally { s.clean(); }
});

test('the service has a start timeout and the script header says when Caddy may reload', () => {
  assert.match(readFileSync(path.join(HOSTS, 'vulnmart-certs.service'), 'utf8'), /^TimeoutStartSec=30min$/m);
  const sh = readFileSync(path.join(HOSTS, 'vulnmart-certs.sh'), 'utf8');
  assert.match(sh, /flock -n 9/);
  assert.match(sh, /Caddy must reload only after the run ends/);
  assert.match(sh, /^set -eu$/m, 'set -eu is on its own line (it was glued to a comment and dead)');
});

test('H2: the service reloads the origin Caddy after the run through the admin socket, and a failed reload cannot fail the unit', () => {
  const svc = readFileSync(path.join(HOSTS, 'vulnmart-certs.service'), 'utf8');
  const m = svc.match(/^ExecStartPost=(.*)$/m);
  assert.ok(m, 'ExecStartPost present');
  assert.ok(m[1].startsWith('-'), 'leading - : a failed reload is ignored');
  assert.match(m[1], /docker exec vulnmart-origin-caddy-1 caddy reload --config \/etc\/caddy\/Caddyfile --adapter caddyfile --address unix\/\/tmp\/caddy-admin\.sock/);
  const compose = readFileSync(path.join(ROOT, 'infra', 'caddy', 'compose.p.yaml'), 'utf8');
  assert.match(compose, /^name: vulnmart-origin$/m);
  assert.match(compose, /^  caddy:$/m);
  assert.match(readFileSync(path.join(ROOT, 'infra', 'caddy', 'Caddyfile.p'), 'utf8'), /admin unix\/\/tmp\/caddy-admin\.sock/);
});

test('H1: a failing copy exits 1, writes no certs-ok stamp and leaves no .new file', { skip }, () => {
  const s = setup({ STUB_CP_FAIL_CRT: '1' });
  try {
    s.put('marks/certs-staging-ok', 'demo.duckdns.org\n');
    const r = s.run('vulnmart-certs.sh', 'issue', '--production');
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.ok(!s.mark('certs-ok'), 'no success stamp after a failed publish');
    assert.ok(s.mark('certs-failed'), 'failure marker written');
    assert.ok(!existsSync(path.join(s.dir, 'certs', 'live', 'fullchain.pem.new')), 'temporary file cleaned');
  } finally { s.clean(); }
});

test('L19: a token file readable by group or others is refused with exit 2 and no lego call (POSIX only)', { skip: skip || (process.platform === 'win32' ? 'Windows shells cannot report modes' : false) }, () => {
  const s = setup();
  try {
    chmodSync(path.join(s.dir, 'duckdns.token'), 0o644);
    const r = s.run('vulnmart-certs.sh', 'issue');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /must be 0600 or stricter/);
    assert.equal(legoCalls(s).length, 0);
  } finally { s.clean(); }
});


test('installer: aarch64 picks the arm64 file and checksum, and refuses a wrong arm64 checksum', { skip }, () => {
  const ok = installerSetup(false, 'aarch64');
  try {
    const r = ok.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(ok.curlLog(), /linux_arm64\.tar\.gz/);
    assert.ok(!/linux_amd64/.test(ok.curlLog()));
  } finally { ok.clean(); }
  const bad = installerSetup(true, 'aarch64');
  try {
    const r = bad.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checksum mismatch for lego_v5\.5\.2_linux_arm64/);
    assert.ok(!existsSync(bad.dest));
  } finally { bad.clean(); }
});

// ---- static ----
test('lego.pin.json is valid JSON with one key per line, a pinned version and two 64-hex checksums', () => {
  const text = readFileSync(path.join(HOSTS, 'lego.pin.json'), 'utf8');
  const j = JSON.parse(text);
  assert.match(j.version, /^v\d+\.\d+\.\d+$/);
  for (const k of ['amd64', 'arm64']) {
    assert.match(j[`${k}_sha256`], /^[0-9a-f]{64}$/);
    assert.ok(j[`${k}_file`].includes(j.version) && j[`${k}_file`].includes(`linux_${k}`));
  }
  assert.ok(j.url_prefix.startsWith('https://github.com/go-acme/lego/releases/download/'));
  assert.ok(text.split('\n').filter((l) => l.includes('"')).every((l) => (l.match(/": "/g) ?? []).length === 1), 'one key per line (the installer parses it with sed)');
});

test('timer is Persistent=true and runs twice a day; the service reads certs.env and runs renew; no token or address in the unit files', () => {
  const timer = readFileSync(path.join(HOSTS, 'vulnmart-certs.timer'), 'utf8');
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* \d\d,\d\d:00:00$/m);
  const svc = readFileSync(path.join(HOSTS, 'vulnmart-certs.service'), 'utf8');
  assert.match(svc, /^ExecStart=\/usr\/local\/sbin\/vulnmart-certs\.sh renew$/m);
  assert.match(svc, /^EnvironmentFile=\/etc\/vulnmart\/certs\.env$/m);
  assert.match(svc, /^Type=oneshot$/m);
  for (const f of ['vulnmart-certs.sh', 'vulnmart-certs.service', 'vulnmart-certs.timer', 'vulnmart-install-lego.sh']) {
    const t = readFileSync(path.join(HOSTS, f), 'utf8');
    assert.ok(!/DUCKDNS_TOKEN=|--token|token=[0-9a-f-]{20,}|@[a-z0-9-]+\.[a-z]{2,}\b/i.test(t.replace(/ops@example\.invalid/g, '')), `${f}: no token value or email`);
  }
});

test('the baseline script installs lego and enables the timer', () => {
  const b = readFileSync(path.join(HOSTS, 'vulnmart-baseline.sh'), 'utf8');
  assert.match(b, /STEP=lego;\s+optional \/usr\/local\/sbin\/vulnmart-install-lego\.sh/);
  assert.match(b, /^optional\(\) \{ "\$@" \|\| \{.*certs-tooling-failed/m, 'the certificate steps are non-fatal and write certs-tooling-failed');
  assert.ok(b.indexOf('STEP=lego;') > b.indexOf('STEP=unattended-upgrades;'), 'the optional steps come after the existing steps');
  assert.match(b, /enable --now vulnmart-certs\.timer/);
});
