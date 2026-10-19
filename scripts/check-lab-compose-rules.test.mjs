// Tests for the one socket exception of the lab compose lint (story 4.2, ADR 0010, D-58). Parsed YAML, no Docker, no network.
// Run: node --test scripts/check-lab-compose-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { checkComposeText, checkFiles, findComposeFiles, SOCKET_PROXY_IMAGE, SOCKET_PROXY_COMMAND } from './check-lab-compose-rules.mjs';

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
    const out = bad(`services:\n  worker:\n    volumes:\n      ${f}\n`);
    assert.equal(out.length, 1, f);
    assert.match(out[0], /Docker socket mount is not allowed.*service worker/, f);
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
  assert.match(bad(lab('relay', '["127.0.0.1:8000:8000"]'))[0], /must not publish a port/);
});

// ---- the orchestrator container (edge story 6, H-343)
const ORCH_OK = `services:
  orchestrator:
    profiles: ["lab"]
    user: "65532:65532"
    read_only: true
    command: ["--templates-dir", "/t", "--docker-host", "tcp://docker-proxy:2375", "--edge-container", "vulnmart-edge-gate", "--tls-cert", "/run/secrets/tls_cert", "--tls-key", "/run/secrets/tls_key", "--tls-ca", "/run/secrets/tls_ca"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    networks: [labs-core]
    secrets: [{ source: s, target: platform_key }]
    ports: ["\${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443"]
`;
const orch = (from, to) => bad(ORCH_OK.replace(from, to));

test('orchestrator container: the service as designed passes, with the loopback form and the long form too', () => {
  assert.deepEqual(bad(ORCH_OK), []);
  assert.deepEqual(orch('"${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443"', '"127.0.0.1:9443:8443"'), []);
  assert.deepEqual(orch('["${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443"]', '\n      - { target: 8443, published: 9443, host_ip: 127.0.0.1 }'), []);
});

test('orchestrator container: a published port beyond loopback, another port or a bare publication fails', () => {
  for (const p of ['"9443:8443"', '"0.0.0.0:9443:8443"', '"${VULNMART_ORCH_BIND}:9443:8443"', '"${VULNMART_ORCH_BIND:-0.0.0.0}:9443:8443"', '"127.0.0.1:8443:8443"', '"127.0.0.1:9443:9443"', '"10.0.0.5:9443:8443"', '8443', '"127.0.0.1:9443:8443", "127.0.0.1:9444:8443"']) {
    assert.match(orch('"${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443"', p).join('\n'), /orchestrator may publish only|cannot be read/, p);
  }
  assert.match(orch('["${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443"]', '\n      - { target: 8443, published: 9443 }').join('\n'), /may publish only/);
  assert.match(orch('"${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443"', '"127.0.0.1:9090:9090"').join('\n'), /never be published/);
});

test('orchestrator container: no socket, privileged, host network, TLS bypass, fake backend, local images or Docker address other than the proxy', () => {
  assert.match(orch('networks: [labs-core]', 'networks: [labs-core]\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]').join('\n'), /Docker socket mount is not allowed.*service orchestrator/);
  assert.match(orch('networks: [labs-core]', 'networks: [labs-core]\n    volumes: ["/var/run:/r"]').join('\n'), /Docker socket mount/);
  assert.match(orch('read_only: true', 'read_only: true\n    privileged: true').join('\n'), /privileged/);
  assert.match(orch('read_only: true', 'read_only: true\n    network_mode: host').join('\n'), /network_mode: host/);
  assert.match(orch('"--templates-dir"', '"--insecure-no-tls", "--templates-dir"').join('\n'), /--insecure-no-tls/);
  assert.match(orch('"--templates-dir"', '"--allow-fake-backend", "--backend", "fake", "--templates-dir"').join('\n'), /--allow-fake-backend[\s\S]*--backend must be docker/);
  assert.match(orch('"--templates-dir"', '"--allow-local-images", "--templates-dir"').join('\n'), /--allow-local-images/);
  assert.match(orch('tcp://docker-proxy:2375', 'tcp://127.0.0.1:2375').join('\n'), /--docker-host must be tcp:\/\/docker-proxy:2375/);
  assert.match(orch('tcp://docker-proxy:2375', 'unix:///var/run/docker.sock').join('\n'), /--docker-host must be/);
  assert.match(orch('"--docker-host", "tcp://docker-proxy:2375", ', '').join('\n'), /--docker-host must be/);
  assert.match(orch('networks: [labs-core]', 'networks: [labs-core]\n    environment:\n      DOCKER_HOST: unix:///x').join('\n'), /DOCKER_HOST is not allowed/);
  assert.match(orch('"--tls-ca", "/run/secrets/tls_ca"', '"--x"').join('\n'), /must set --tls-ca/);
});

test('orchestrator container: hardening is required (non-root, read-only, cap_drop ALL, no-new-privileges, only labs-core, secret names are file names)', () => {
  assert.match(orch('    user: "65532:65532"\n', '').join('\n'), /non-root/);
  assert.match(orch('user: "65532:65532"', 'user: "0"').join('\n'), /non-root/);
  assert.match(orch('read_only: true', 'read_only: false').join('\n'), /read_only must be true/);
  assert.match(orch('cap_drop: [ALL]', 'cap_drop: [CHOWN]').join('\n'), /cap_drop must contain ALL/);
  assert.match(orch('cap_drop: [ALL]', 'cap_drop: [ALL]\n    cap_add: [CHOWN]').join('\n'), /cap_add must be empty/);
  assert.match(orch('security_opt: ["no-new-privileges:true"]', 'security_opt: []').join('\n'), /no-new-privileges/);
  assert.match(orch('networks: [labs-core]', 'networks: [labs-core, edge-public]').join('\n'), /exactly labs-core/);
  assert.match(orch('networks: [labs-core]', 'networks: [edge-public]').join('\n'), /exactly labs-core/);
  assert.match(orch('target: platform_key', 'target: /etc/key').join('\n'), /file name under \/run\/secrets/);
});

test('orchestrator container: the committed service is the one designed here (published form, no socket, secrets as files)', () => {
  const doc = yaml.load(readFileSync(path.join(ROOT, 'infra', 'compose', 'compose.yaml'), 'utf8'));
  const o = doc.services.orchestrator;
  assert.deepEqual(o.profiles, ['lab']);
  assert.deepEqual(o.ports, ['${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443']);
  assert.equal((o.volumes ?? []).filter((v) => String(v).includes('docker.sock')).length, 0);
  assert.deepEqual(o.networks, ['labs-core']);
  assert.ok(o.command.includes('tcp://docker-proxy:2375') && o.command.includes('http://edge-gate-admin:9090') && o.command.includes('vulnmart-edge-gate'));
  assert.ok(o.secrets.length === 5 && o.secrets.every((s) => s.source && /^[a-z_]+$/.test(s.target)));
  assert.deepEqual(checkFiles([path.join(ROOT, 'infra', 'compose', 'compose.yaml')]), []);
});

// ---- the report override file (edge story 7): lab.reports.yaml, only the report key and CA secrets and the two variables that name them
const REPORTS_FILE = path.join(ROOT, 'infra', 'compose', 'lab.reports.yaml');
const reportsText = () => readFileSync(REPORTS_FILE, 'utf8').replace(/\r\n/g, '\n');
const ov = (from, to) => checkComposeText(reportsText().replace(from, to), 'infra/compose/lab.reports.yaml');

test('report override: the committed file passes, is found by the default scan, and the base file does not mention it', () => {
  assert.deepEqual(checkFiles([REPORTS_FILE]), []);
  assert.ok(findComposeFiles([path.join(ROOT, 'infra', 'compose')]).some((f) => f.endsWith('lab.reports.yaml')));
  assert.ok(!readFileSync(path.join(ROOT, 'infra', 'compose', 'compose.yaml'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n').includes('lab.reports'));
  const doc = yaml.load(reportsText());
  assert.deepEqual(Object.keys(doc.services), ['orchestrator']);
  assert.deepEqual(doc.services.orchestrator.environment, { VM_ORCH_REPORT_KEY_FILE: '/run/secrets/report_key', SSL_CERT_FILE: '/run/secrets/report_ca' });
});

test('report override: a change of anything else on the orchestrator, another service, a key in the environment or a changed secret fails', () => {
  const text = (s) => s.join('\n').replace(/\s+$/, '');
  assert.match(ov('    environment:', '    ports: ["0.0.0.0:9443:8443"]\n    environment:').join('\n'), /may add only environment and secrets, not ports/);
  assert.match(ov('    environment:', '    command: ["--insecure-no-tls"]\n    environment:').join('\n'), /not command/);
  assert.match(ov('    environment:', '    privileged: true\n    environment:').join('\n'), /privileged/);
  assert.match(ov('    environment:', '    volumes: ["/var/run/docker.sock:/s"]\n    environment:').join('\n'), /Docker socket mount is not allowed/);
  assert.match(ov('services:\n', 'services:\n  edge-gate:\n    environment: { A: b }\n').join('\n'), /only the service orchestrator, not edge-gate/);
  assert.match(ov('      SSL_CERT_FILE: /run/secrets/report_ca', '      SSL_CERT_FILE: /etc/ssl/other.pem').join('\n'), /SSL_CERT_FILE must be \/run\/secrets\/report_ca/);
  assert.match(ov('      SSL_CERT_FILE: /run/secrets/report_ca', '      VM_ORCH_REPORT_KEY: hunter2hunter2hunter2hunter2hunter2').join('\n'), /VM_ORCH_REPORT_KEY is not allowed/);
  assert.match(ov('      SSL_CERT_FILE: /run/secrets/report_ca', '      DOCKER_HOST: tcp://x:1').join('\n'), /DOCKER_HOST is not allowed/);
  assert.match(ov('target: report_key', 'target: other').join('\n'), /only the secrets orch-report-key and orch-report-ca/);
  assert.match(ov('source: orch-report-ca', 'source: orch-platform-key').join('\n'), /only the secrets/);
  assert.match(ov('/secrets/report_key\n  orch-report-ca', '/secrets/../../etc/shadow\n  orch-report-ca').join('\n'), /orch-report-key must be \{file:/);
  assert.match(ov('secrets:\n  orch-report-key:', 'secrets:\n  other:\n    file: /etc/passwd\n  orch-report-key:').join('\n'), /only orch-report-key and orch-report-ca may be defined here, not other/);
  assert.match(ov('\nservices:', '\nvolumes:\n  x: {}\nservices:').join('\n'), /only services and secrets at the top, not volumes/);
  assert.equal(text(ov('nothing-to-replace', 'x')), '');
});

test('report override: the base orchestrator service takes the URL from the environment and never a key', () => {
  const o = yaml.load(readFileSync(path.join(ROOT, 'infra', 'compose', 'compose.yaml'), 'utf8')).services.orchestrator;
  assert.deepEqual(o.environment, { VM_ORCH_REPORT_URL: '${VULNMART_ORCH_REPORT_URL:-}', VM_ORCH_RUNTIME: '${VULNMART_ORCH_RUNTIME:-}' }, 'the report URL and the sandbox runtime (S-8) come from the environment, both empty by default');
  assert.ok(!o.command.includes('--report-url') && !o.command.includes('--report-key-file'));
  assert.match(orch('networks: [labs-core]', 'networks: [labs-core]\n    environment: { VM_ORCH_PLATFORM_KEY: x }').join('\n'), /VM_ORCH_PLATFORM_KEY would put a signing key into docker inspect/);
  assert.match(orch('networks: [labs-core]', 'networks: [labs-core]\n    environment: { VM_ORCH_REPORT_KEY: x }').join('\n'), /VM_ORCH_REPORT_KEY would put a signing key/);
  assert.deepEqual(orch('networks: [labs-core]', 'networks: [labs-core]\n    environment: { VM_ORCH_REPORT_URL: "${VULNMART_ORCH_REPORT_URL:-}" }'), []);
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
  assert.deepEqual(publishing, ['docker-proxy', 'edge-caddy', 'orchestrator']);
  assert.deepEqual(doc.services['edge-caddy'].ports, ['443:443']);
  assert.equal(doc.services['edge-gate'].ports, undefined);
  assert.deepEqual(checkFiles([path.join(ROOT, 'infra', 'compose', 'compose.yaml')]), []);
});
test('the rules of a lab service hold without the profile: dropping `profiles: ["lab"]` does not switch them off (review finding D4)', () => {
  const published = bad('services:\n  edge-gate:\n    image: x\n    ports: ["8080:8080"]\n');
  assert.ok(published.some((p) => /must never be published/.test(p)), published.join('\n'));
  const orch = bad('services:\n  orchestrator:\n    image: x\n    ports: ["0.0.0.0:9443:8443"]\n');
  assert.ok(orch.length > 0, 'the orchestrator port rule still applies');
  const other = bad('services:\n  edge-caddy:\n    image: x\n    ports: ["80:80"]\n');
  assert.ok(other.length > 0);
});
