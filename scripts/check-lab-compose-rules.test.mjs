// Tests for the one socket exception of the lab compose lint (story 4.2, ADR 0010, D-58). Parsed YAML, no Docker, no network.
// Run: node --test scripts/check-lab-compose-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { checkComposeText, checkFiles, SOCKET_PROXY_IMAGE, SOCKET_PROXY_COMMAND } from './check-lab-compose-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOCK = '/var/run/docker.sock';
const bad = (yml) => checkComposeText(yml, 'x.yaml');
const CMD = JSON.stringify(SOCKET_PROXY_COMMAND);
// A docker-proxy service that passes; each test changes one thing.
const proxy = ({ volumes = `["${SOCK}:${SOCK}:ro"]`, ports = '["127.0.0.1:2375:2375"]', extra = '', image = SOCKET_PROXY_IMAGE } = {}) =>
  `services:\n  docker-proxy:\n    image: ${image}\n    command: ${CMD}\n    read_only: true\n    cap_drop: [ALL]\n    volumes: ${volumes}\n    ports: ${ports}\n${extra}`;

test('the committed compose file passes, and docker-proxy is the only service with the socket', () => {
  const file = path.join(ROOT, 'infra', 'compose', 'compose.yaml');
  assert.deepEqual(checkFiles([file]), []);
  const text = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  assert.equal(text.filter((l) => l.includes('docker.sock')).length, 1);
});

test('exception, allowed side: docker-proxy as written passes, short and long volume form', () => {
  assert.deepEqual(bad(proxy()), []);
  assert.deepEqual(bad(proxy({ volumes: `\n      - { type: bind, source: ${SOCK}, target: ${SOCK}, read_only: true }` })), []);
  assert.deepEqual(bad(proxy({ ports: '\n      - { target: 2375, published: 2375, host_ip: 127.0.0.1 }' })), []);
});

test('exception, refused side: every other service is refused the socket in every spelling', () => {
  const forms = [
    `- ${SOCK}:${SOCK}:ro`,
    `- "${SOCK}:/s"`,
    '- /var/run:/h:ro',
    '- /run:/h',
    '- /var:/h',
    '- /:/host',
    '- /var/run/:/h',
    '- /var/run/../run/docker.sock:/s',
    `- { type: bind, source: ${SOCK}, target: /s, read_only: true }`,
    '- type: bind\n        source: /\n        target: /host',
  ];
  for (const f of forms) {
    const out = bad(`services:\n  orchestrator:\n    volumes:\n      ${f}\n`);
    assert.equal(out.length, 1, f);
    assert.match(out[0], /Docker socket mount is not allowed.*service orchestrator/, f);
  }
  assert.match(bad(`services:\n  docker-proxy-2:\n    volumes: ["${SOCK}:${SOCK}:ro"]\n`)[0], /service docker-proxy-2/);
  assert.deepEqual(bad('services:\n  a:\n    volumes:\n      - ./data:/data\n      - named:/n\n'), []);
});

test('a service name that is quoted, anchored or written in flow style is not taken for docker-proxy and stays checked', () => {
  assert.match(bad(`services:\n  "evil":\n    volumes: ["${SOCK}:${SOCK}:ro"]\n`)[0], /service evil/);
  assert.match(bad(`services:\n  evil: &a\n    volumes: ["${SOCK}:${SOCK}:ro"]\n`)[0], /service evil/);
  assert.match(bad(`services:\n  evil: { volumes: ["${SOCK}:${SOCK}:ro"] }\n`)[0], /service evil/);
  // a merge key copies the volumes into a second service: both are seen
  const merged = bad(`x-base: &base\n  volumes: ["/:/host"]\nservices:\n  one:\n    <<: *base\n  two:\n    <<: *base\n`);
  assert.equal(merged.length, 2);
  assert.match(merged.join('\n'), /service one[\s\S]*service two/);
  assert.match(bad('services:\n  a: [broken\n')[0], /cannot parse/);
});

test('docker-proxy with a second volume, a flow-style bind or a port on every interface fails', () => {
  assert.match(bad(proxy({ volumes: `["${SOCK}:${SOCK}:ro", "/etc:/e:ro"]` }))[0], /exactly one volume/);
  assert.match(bad(proxy({ volumes: '["/:/host"]' }))[0], /exactly one volume/);
  assert.match(bad(proxy({ volumes: `["${SOCK}:${SOCK}"]` }))[0], /exactly one volume/, 'read-write');
  assert.match(bad(proxy({ volumes: `["${SOCK}:/other.sock:ro"]` }))[0], /exactly one volume/);
  assert.match(bad(proxy({ volumes: `["named:/data", "${SOCK}:${SOCK}:ro"]` }))[0], /exactly one volume/);
  assert.match(bad(proxy({ ports: '["0.0.0.0:2375:2375"]' }))[0], /127\.0\.0\.1 only/);
  assert.match(bad(proxy({ ports: '["2375:2375"]' }))[0], /127\.0\.0\.1 only/);
  assert.match(bad(proxy({ ports: '[2375]' }))[0], /127\.0\.0\.1 only/);
  assert.match(bad(proxy({ ports: '\n      - { target: 2375, published: 2375 }' }))[0], /127\.0\.0\.1 only/, 'long form without host_ip');
  assert.match(bad(proxy({ ports: '\n      - { target: 2375, published: 2375, host_ip: 0.0.0.0 }' }))[0], /127\.0\.0\.1 only/);
});

test('volumes_from, extends, include and devices are refused', () => {
  assert.match(bad('services:\n  a:\n    volumes_from: [docker-proxy]\n')[0], /volumes_from/);
  assert.match(bad('services:\n  a:\n    volumes_from:\n      - docker-proxy:ro\n')[0], /volumes_from/);
  assert.match(bad('services:\n  a:\n    extends:\n      service: docker-proxy\n')[0], /extends/);
  assert.match(bad('include:\n  - other.yaml\nservices: {}\n')[0], /include/);
  assert.match(bad(`services:\n  a:\n    devices: ["${SOCK}:/dev/x"]\n`)[0], /device/);
  assert.match(bad('services:\n  a:\n    devices: ["/:/dev/root"]\n')[0], /device/);
  assert.deepEqual(bad('services:\n  a:\n    devices: ["/dev/fuse:/dev/fuse"]\n'), []);
});

test('docker-proxy is pinned: image, command, user, privileges, capabilities', () => {
  assert.match(bad(proxy({ image: 'tecnativa/docker-socket-proxy:latest' }))[0], /image must be exactly/);
  assert.match(bad(proxy({ image: 'evil/proxy@sha256:' + '0'.repeat(64) }))[0], /image must be exactly/);
  assert.match(bad(proxy().replace(`command: ${CMD}`, 'command: ["sh"]'))[0], /command must be exactly/);
  assert.match(bad(proxy({ extra: '    user: "0"\n' }))[0], /user must not be set/);
  assert.match(bad(proxy({ extra: '    privileged: true\n' })).join('\n'), /privileged/);
  assert.match(bad(proxy({ extra: '    network_mode: host\n' })).join('\n'), /network_mode: host/);
  assert.match(bad(proxy({ extra: '    cap_add: [CHOWN]\n' }))[0], /cap_add must be empty/);
  assert.match(bad(proxy({ extra: '    cap_add: [NET_ADMIN]\n' })).join('\n'), /NET_ADMIN/);
  assert.match(bad(proxy().replace('read_only: true', 'read_only: false'))[0], /read_only must be true/);
});

test('privileged and host network stay refused in any service, in block or flow style', () => {
  assert.match(bad('services:\n  a:\n    privileged: true\n')[0], /x\.yaml:3: privileged: true/);
  assert.match(bad('services:\n  a: { privileged: true }\n')[0], /privileged/);
  assert.match(bad('services:\n  a: { network_mode: host }\n')[0], /network_mode: host/);
  assert.match(bad('services:\n  a: { pid: host }\n')[0], /pid: host/);
  assert.deepEqual(bad(`# ${SOCK} is mounted only by docker-proxy\nservices:\n  a:\n    image: x\n`), []);
});

// ---- published ports of the lab profile (story edge-2, D-62, D-28)
const lab = (name, ports, profiles = '["lab"]') => `services:\n  ${name}:\n    profiles: ${profiles}\n    ports: ${ports}\n`;

test('lab ports: edge-caddy may publish 443:443 only, in every spelling of that', () => {
  for (const p of ['["443:443"]', '["0.0.0.0:443:443"]', '["127.0.0.1:443:443"]', '["443:443/tcp"]', '\n      - { target: 443, published: 443 }', '\n      - { target: 443, published: "443", host_ip: 0.0.0.0 }']) {
    assert.deepEqual(bad(lab('edge-caddy', p)), [], p);
  }
});

test('lab ports: a lab service that publishes 8080, 8081 or 9090 fails (host side or container side, loopback or not, short or long form)', () => {
  for (const p of ['["8080:8080"]', '["127.0.0.1:8080:8080"]', '["8081:8081"]', '["9090:9090"]', '["18080:8080"]', '["8080:80"]', '["9090"]', '\n      - { target: 8080, published: 8080 }', '\n      - { target: 9090, published: 19090, host_ip: 127.0.0.1 }', '["8080:8080/tcp"]']) {
    for (const svc of ['edge-gate', 'edge-caddy', 'orchestrator']) {
      const out = bad(lab(svc, p));
      assert.ok(out.length >= 1, `${svc} ${p}`);
      assert.match(out.join('\n'), /never be published/, `${svc} ${p}`);
    }
  }
});

test('lab ports: edge-caddy publishing 80, 8443, or 443 on another host port fails; any other lab service publishing anything fails', () => {
  for (const p of ['["80:80"]', '["80:443"]', '["8443:443"]', '["443:8443"]', '["443:443", "80:80"]', '["443-444:443-444"]', '["${PORT}:443"]']) {
    assert.match(bad(lab('edge-caddy', p)).join('\n'), /may publish only 443:443|cannot be read/, p);
  }
  assert.match(bad(lab('edge-gate', '["443:443"]'))[0], /service edge-gate: a lab service must not publish a port/);
  assert.match(bad(lab('orchestrator', '["127.0.0.1:8000:8000"]'))[0], /must not publish a port/);
});

test('lab ports: services outside the lab profile and the docker-proxy loopback port are not touched by this rule', () => {
  assert.deepEqual(bad(lab('hello', '["127.0.0.1:18080:8080"]', '["hello"]')), []);
  assert.deepEqual(bad(lab('api', '["127.0.0.1:8000:8000"]', '["platform"]')), []);
  assert.deepEqual(bad('services:\n  web:\n    ports: ["8080:8080"]\n'), []);
  assert.deepEqual(bad(proxy()), []);
});

test('lab ports: the committed compose file has edge-caddy as its only lab service with a ports entry, and it is 443:443', () => {
  const doc = yaml.load(readFileSync(path.join(ROOT, 'infra', 'compose', 'compose.yaml'), 'utf8'));
  const labServices = Object.entries(doc.services).filter(([, d]) => (d.profiles ?? []).includes('lab'));
  assert.ok(labServices.some(([n]) => n === 'edge-caddy') && labServices.some(([n]) => n === 'edge-gate'));
  const publishing = labServices.filter(([, d]) => (d.ports ?? []).length).map(([n]) => n).sort();
  assert.deepEqual(publishing, ['docker-proxy', 'edge-caddy']);
  assert.deepEqual(doc.services['edge-caddy'].ports, ['443:443']);
  assert.equal(doc.services['edge-gate'].ports, undefined);
  assert.deepEqual(checkFiles([path.join(ROOT, 'infra', 'compose', 'compose.yaml')]), []);
});