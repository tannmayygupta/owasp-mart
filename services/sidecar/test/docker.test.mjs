// The real image under the runtime profile (IF-6 section 7): built, started with a read-only root, user 65532, all capabilities dropped,
// no-new-privileges, tmpfs /tmp, the start document on standard input; it must become healthy, pass a flag response through unchanged and
// deliver signed events to a fake ingest that runs in this test. Everything it creates is labelled and removed; the test checks that nothing is left.
// Skipped with a message when no Docker daemon answers. Set VM_SKIP_DOCKER=1 to skip on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../contracts/mocks/fake-ingest/server.mjs';
import { closeServer, listen } from '../src/common.mjs';
import { freshValues, startDoc, flagOf, sha256, postedEvent, until, request, wait } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT = path.resolve(HERE, '..');
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 600000, ...opts });
const daemonUp = !process.env.VM_SKIP_DOCKER && docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15000 }).status === 0;

test('image: builds, starts under the runtime profile, is healthy, passes a gzip flag response through and delivers signed events', { skip: daemonUp ? false : 'no Docker daemon (or VM_SKIP_DOCKER set): the image steps are skipped, run them where Docker is available', timeout: 600000 }, async (t) => {
  const id = crypto.randomBytes(5).toString('hex');
  const label = `vm.test=sidecar-${id}`;
  const tag = `vulnmart-sidecar:test-${id}`;
  const name = `vm-sidecar-test-${id}`;
  let child; let ing; let up;
  try {
    const build = docker(['build', '-f', path.join(CONTEXT, 'Dockerfile'), '-t', tag, '--label', label, CONTEXT]);
    assert.equal(build.status, 0, `docker build failed: ${build.stderr.slice(-500)}`);
    const size = Number(docker(['image', 'inspect', tag, '--format', '{{.Size}}']).stdout.trim());
    t.diagnostic(`image size (local, Docker Desktop, amd64): ${size} bytes = ${(size / 1048576).toFixed(1)} MiB`);
    assert.ok(size > 0 && size < 120 * 1048576, 'the image is a small distroless one');

    const v = freshValues();
    const flag = flagOf(v, 'C05');
    const page = zlib.gzipSync(Buffer.from(`<p>${flag}</p>`));
    up = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'x-vm-ticket': 'must-not-come-out' }); res.end(page); });
    const upPort = await listen(up, 0, '0.0.0.0');
    ing = await startServer({ key: v.event_key, instance: v.instance_id, epoch: v.epoch, port: 0, host: '0.0.0.0', log: () => {} });

    child = spawn('docker', ['run', '-i', '--name', name, '--label', label, '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,uid=65532,gid=65532,mode=1777', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '128',
      '-p', '127.0.0.1:0:8080', '-p', '127.0.0.1:0:9000', '--add-host', 'host.docker.internal:host-gateway', tag,
      '/app/src/main.mjs', '--relay', `http://host.docker.internal:${ing.port}/internal/v1/events`, '--upstream', `http://host.docker.internal:${upPort}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', (c) => (logs += c)); child.stderr.on('data', (c) => (logs += c));
    child.stdin.end(JSON.stringify(startDoc(v)));

    const health = () => docker(['inspect', name, '--format', '{{.State.Health.Status}}']).stdout.trim();
    assert.ok(await until(() => health() === 'healthy', 60000), `the container did not become healthy (health: ${health()}); logs: ${logs.slice(-300)}`);

    const insp = JSON.parse(docker(['inspect', name]).stdout)[0];
    assert.equal(insp.Config.User, '65532:65532');
    assert.equal(insp.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(insp.HostConfig.CapDrop, ['ALL']);
    assert.equal(insp.HostConfig.Privileged, false);
    assert.ok(insp.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.deepEqual(insp.Config.Healthcheck.Test.slice(0, 2), ['CMD', '/nodejs/bin/node'], 'the health check is a direct exec, no shell');
    assert.ok(!JSON.stringify(insp).includes(v.event_key) && !JSON.stringify(insp).includes(flag), 'no key or flag in the container settings');

    const port = (p) => Number(docker(['port', name, `${p}/tcp`]).stdout.trim().split(/\r?\n/)[0].split(':').pop());
    const playerPort = port(8080); const eventsPort = port(9000);
    const r = await request(playerPort, { path: '/page?x=1', headers: { 'user-agent': 'docker-test', 'x-vm-session-kind': 'bot' } });
    assert.ok(r.body.equals(page), 'identical bytes');
    assert.equal(r.headers['x-vm-ticket'], undefined, 'no x-vm-* header goes back out');
    assert.ok(await until(() => ing.ingest.stored.length >= 2, 15000), 'events delivered');
    const types = ing.ingest.stored.map((x) => x.event.type);
    assert.ok(types.includes('proxy.flag_seen') && types.includes('evidence.capture'), types.join(','));
    const seen = ing.ingest.stored.find((x) => x.event.type === 'proxy.flag_seen').event;
    assert.equal(seen.data.candidate_sha256, sha256(flag));
    assert.equal(seen.data.challenge_key, 'C05');
    assert.equal(ing.ingest.security.length, 0, 'signatures verified at the ingest');
    assert.ok(!JSON.stringify(ing.ingest.stored).includes(flag), 'no flag value in any event');
    const posted = await request(eventsPort, { method: 'POST', path: '/v1/events', headers: { 'content-type': 'application/json' }, body: JSON.stringify(postedEvent()) });
    assert.equal(posted.status, 202);
    assert.ok(!logs.includes(v.event_key) && !logs.includes(flag), 'no key or flag in the container log');

    // Story 6.5: the detection helper inside the image. An SQLi request through the player port: the answer is the same bytes as a clean request
    // to the same shop route, and a valid proxy.crs_match with the attack_sqli tag reaches the fake ingest. The helper needs about a second to load.
    const sqliPath = '/api/products/search?q=%27%20UNION%20SELECT%201,2,3,4--';
    let crsEvent;
    assert.ok(await until(async () => {
      await request(playerPort, { path: sqliPath, headers: { 'user-agent': 'docker-test' } });
      await wait(250);
      crsEvent = ing.ingest.stored.map((x) => x.event).find((e) => e.type === 'proxy.crs_match' && e.data.tags.includes('attack_sqli'));
      return Boolean(crsEvent);
    }, 30000), 'proxy.crs_match reached the fake ingest');
    assert.ok(crsEvent.data.tags.includes('attack_sqli'), JSON.stringify(crsEvent.data.tags));
    assert.ok(crsEvent.data.rule_ids.length > 0 && crsEvent.data.anomaly_score > 0);
    assert.ok(crsEvent.data.tags.every((x) => /^[a-z0-9_]{1,32}$/.test(x)));
    const sqliAnswer = await request(playerPort, { path: sqliPath });
    assert.ok(sqliAnswer.body.equals(page), 'the answer to the attack request is the shop answer, unchanged');
    await wait(1500); // the second attack request above also reports; let it arrive before counting
    const benignBefore = ing.ingest.stored.filter((x) => x.event.type === 'proxy.crs_match' && x.event.data.tags.includes('attack_sqli')).length;
    await request(playerPort, { path: '/api/products/search?q=blue+lamp' });
    await wait(1000);
    assert.equal(ing.ingest.stored.filter((x) => x.event.type === 'proxy.crs_match' && x.event.data.tags.includes('attack_sqli')).length, benignBefore, 'a benign search makes no attack_sqli crs_match');
    assert.equal(ing.ingest.security.length, 0);
    assert.ok(!logs.includes(v.event_key) && !logs.includes(flag), 'no key or flag in the container log after the helper ran');

    await wait(3000);
    const mem = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name]).stdout.trim();
    t.diagnostic(`idle memory after the requests above (local, docker stats): ${mem}`);
  } finally {
    docker(['rm', '-f', name]);
    try { child?.kill(); } catch { /* gone */ }
    if (ing) await closeServer(ing.server);
    if (up) await closeServer(up);
    docker(['rmi', '-f', tag]);
    const left = docker(['ps', '-a', '--filter', `label=${label}`, '-q']).stdout.trim() + docker(['images', '--filter', `label=${label}`, '-q']).stdout.trim();
    assert.equal(left, '', 'nothing created by this test is left (containers, images)');
  }
});
