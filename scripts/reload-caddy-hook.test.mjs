// The certificate renewal hook (audit of 2026-10-18): restart this host's Caddy only when the certificate files changed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'infra', 'hosts', 'vulnmart-reload-caddy.sh');
const hasSh = spawnSync('sh', ['-c', 'true']).status === 0 && spawnSync('sh', ['-c', 'command -v sha256sum find xargs']).status === 0;

test('the unit calls the reload script, not a container name that does not exist', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'infra', 'hosts', 'vulnmart-certs.service'), 'utf8');
  assert.match(unit, /^ExecStartPost=-\/usr\/local\/sbin\/vulnmart-reload-caddy\.sh$/m);
  assert.doesNotMatch(unit, /vulnmart-origin-caddy-1/);
  const script = fs.readFileSync(SCRIPT, 'utf8');
  for (const name of ['vulnmart-caddy', 'vulnmart-edge-caddy']) assert.ok(script.includes(name), `${name} is a real container name of the compose files`);
  for (const file of ['infra/deploy/platform.compose.yaml', 'infra/compose/compose.yaml']) {
    assert.ok(/container_name: vulnmart-(edge-)?caddy/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')), `${file} names a Caddy container the script knows`);
  }
});

test('first run records, an unchanged folder restarts nothing, a changed file restarts the running Caddy once', { skip: !hasSh && 'needs sh, sha256sum, find and xargs' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-'));
  try {
    const certs = path.join(dir, 'live');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(certs); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(certs, 'fullchain.pem'), 'cert one');
    const log = path.join(dir, 'docker.log');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> '${log.replace(/\\/g, '/')}'\nif [ "$1" = inspect ]; then [ "$4" = vulnmart-edge-caddy ] && echo true || echo false; fi\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CADDY_CERT_DIR: certs.replace(/\\/g, '/'), VULNMART_STATE_DIR: path.join(dir, 'state').replace(/\\/g, '/') };
    const run = () => spawnSync('sh', [SCRIPT.replace(/\\/g, '/')], { env, encoding: 'utf8' });
    const restarts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('restart')) : []);
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /first run/);
    assert.equal(restarts().length, 0);
    r = run();
    assert.match(r.stdout, /unchanged/);
    assert.equal(restarts().length, 0);
    fs.writeFileSync(path.join(certs, 'fullchain.pem'), 'cert two, renewed');
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /restarted vulnmart-edge-caddy/);
    assert.deepEqual(restarts(), ['restart vulnmart-edge-caddy']);
    r = run();
    assert.match(r.stdout, /unchanged/);
    assert.equal(restarts().length, 1, 'the same change is not applied twice');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});