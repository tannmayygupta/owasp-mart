// Builds the images on this PC, ships them to the two hosts, stages the secrets and starts the stacks (docs/runbooks/live-deploy.md).
//   node scripts/live-deploy.mjs <command> [--secrets <folder>] [--zone <labs zone>] [--platform-host <name>] [--dry-run]
//   commands: build | ship-i | ship-p | lab | platform | status | down-lab | down-platform
// The hosts and their private addresses come from `terraform output` in infra/terraform/aws (the same folder the other scripts read); the secrets come from the
// folder `scripts/deploy-secrets.mjs` made (outside the repository). Secrets travel as files over ssh, are never put on a command line and never printed.
// Everything remote runs through `sudo` on the hosts as the user `ubuntu` with the key of this PC's ssh agent. Idempotent: run a command again to repair or to update.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const SSH = WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
const SCP = WIN ? 'C:\\Windows\\System32\\OpenSSH\\scp.exe' : 'scp';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new'];
export const OWNER = '65532:65532'; // the user of every container that reads a secret file

// image name on this PC -> [dockerfile, extra build args]; context is always the repository root
export const IMAGES = {
  'vulnmart-api:prod': ['apps/api/Dockerfile'],
  'vulnmart-web:prod': ['apps/web/Dockerfile.prod', 'apps/web'], // the dashboards (Next.js standalone), served on vm-p beside the lab console (ADR 0074)
  'vulnmart-orchestrator:local': ['apps/orchestrator/Dockerfile'],
  'vulnmart-edge:local': ['apps/edge/Dockerfile'],
  'vulnmart-sidecar:local': ['services/sidecar/Dockerfile', 'services/sidecar'],
  'vulnmart-stub-instance:local': ['contracts/mocks/stub-instance/Dockerfile'],
  'vulnmart-shop:local': ['apps/shop/Dockerfile', 'apps/shop'], // the real shop; its `inject` entrypoint is the real injector (IF-6 section 5)
  'vulnmart-import-service:local': ['services/import-service/Dockerfile', 'services/import-service'],
  'vulnmart-mock-services:local': ['services/mock-services/Dockerfile', 'services/mock-services'],
  'vulnmart-bot:local': ['services/bot/Dockerfile', 'services/bot'],
};
export const SHIP = { p: ['vulnmart-api:prod', 'vulnmart-web:prod'], i: ['vulnmart-orchestrator:local', 'vulnmart-edge:local', 'vulnmart-sidecar:local', 'vulnmart-stub-instance:local', 'vulnmart-shop:local', 'vulnmart-import-service:local', 'vulnmart-mock-services:local', 'vulnmart-bot:local'] };
// the instance roles of the lab: which image each role runs, and what the orchestrator may pass (a request can only name a template, never an image or a command)
export const ROLE_IMAGE = {
  shop: 'vulnmart-shop:local', injector: 'vulnmart-shop:local', 'volume-keeper': 'vulnmart-stub-instance:local', sidecar: 'vulnmart-sidecar:local',
  'import-service': 'vulnmart-import-service:local', 'mock-services': 'vulnmart-mock-services:local', 'bot-controller': 'vulnmart-bot:local',
};
const NODE_CHECK = (js) => ['CMD', '/nodejs/bin/node', '-e', js];
export const MANIFEST_EXTRAS = {
  entrypoints: { 'volume-keeper': ['node', '-e', 'setInterval(()=>{},1<<30)'] },
  commands: {
    // the shop image is distroless with `node` as its entrypoint: the shop runs its default command, the injector runs the one-shot script
    injector: ['/app/src/instance/inject.mjs'],
    // the relay URL is the whole URL of the event route (the sidecar posts to it as given); the upstream is the origin of the shop
    sidecar: ['/app/src/main.mjs', '--relay', 'http://vulnmart-edge-gate:8081/internal/v1/events', '--upstream', 'http://shop:3000'],
  },
  healthchecks: {
    shop: NODE_CHECK("fetch('http://127.0.0.1:3000/readyz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"),
    sidecar: NODE_CHECK("require('net').connect(8080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"),
    'import-service': NODE_CHECK("process.exit(require('fs').statSync('/run/import/import.sock').isSocket()?0:1)"),
    'mock-services': NODE_CHECK("require('net').connect(9101,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"),
    'bot-controller': NODE_CHECK("require('net').connect(9200,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"),
  },
};

// The example template sizes every component for the REAL shop (512 MB for the shop, 512 MB for the bot). The stub shop and the small product services
// need a fraction of that, and the orchestrator admits instances by the memory the template declares, so the demo template declares less: 768 MB an instance
// with the volume keeper instead of 1728 MB, which lets a 8 GB host hold about seven instances instead of three. Everything else (images, mounts, labels,
// hardening) is the example's, unchanged. Use the example as it is when the real shop is deployed.
export const DEMO_MEMORY_MB = { shop: 192, sidecar: 160, injector: 128, 'import-service': 64, 'mock-services': 96, 'bot-controller': 128 };
export const DEMO_CAPACITY_MB = 5600; // vm-i has 7.7 GB; Linux, Docker and the edge need the rest

export function demoTemplate(example) {
  const t = JSON.parse(JSON.stringify(example));
  for (const c of t.components) {
    if (!(c.role in DEMO_MEMORY_MB)) throw new Error(`the template has a role the demo sizes do not know: ${c.role}`);
    c.memory_mb = DEMO_MEMORY_MB[c.role];
  }
  return t;
}

/** The OCI runtime of the instance containers when the deploy is not told otherwise: gVisor (S-8, L-29). `--runtime runc` is the explicit way back. */
export const DEFAULT_RUNTIME = 'runsc';

/** The environment of the lab stack on vm-i, as the `KEY=value` words of one `env` call. */
export function labEnv({ zone, H, runtime = DEFAULT_RUNTIME }) {
  return [
    `VULNMART_LABS_ZONE=${zone}`, `VULNMART_ORCH_BIND=${H.i.priv}`, `VULNMART_EDGE_INGEST_URL=https://${H.p.priv}:9444`, 'VULNMART_EDGE_CERTS=/opt/vulnmart/certs/live',
    'VULNMART_EDGE_SECRETS=/opt/vulnmart/lab/secrets', 'VULNMART_ORCH_DIR=/opt/vulnmart/lab/orchestrator', `VULNMART_ORCH_REPORT_URL=https://${H.p.priv}:9444`, `VULNMART_ORCH_CAPACITY_MB=${DEMO_CAPACITY_MB}`,
    // the OCI runtime of the instance containers: the host needs infra/hosts/vulnmart-install-gvisor.sh first; `runc` leaves the daemon default
    ...(runtime === 'runsc' ? ['VULNMART_ORCH_RUNTIME=runsc'] : []),
  ].join(' ');
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, dryRun: false, allowMailCatcher: false };
  if (!['build', 'ship-i', 'ship-p', 'lab', 'platform', 'status', 'down-lab', 'down-platform', 'hooks'].includes(cmd)) return { error: 'usage: node scripts/live-deploy.mjs build | ship-i | ship-p | lab | platform | status | down-lab | down-platform | hooks [--secrets <folder>] [--zone <zone>] [--platform-host <name>] [--runtime runsc|runc] [--allow-mail-catcher] [--dry-run]' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--allow-mail-catcher') o.allowMailCatcher = true;
    else if (['--secrets', '--zone', '--platform-host', '--runtime', '--mail-sender'].includes(a)) {
      if (rest[i + 1] === undefined) return { error: `${a} needs a value` };
      o[{ '--secrets': 'secrets', '--zone': 'zone', '--platform-host': 'platformHost', '--runtime': 'runtime', '--mail-sender': 'mailSender' }[a]] = rest[++i];
      if (a === '--runtime' && !['runsc', 'runc'].includes(o.runtime)) return { error: '--runtime is runsc (gVisor) or runc' };
    } else return { error: `unknown argument ${a}` };
  }
  return o;
}

/** The .env of the platform stack on vm-p (mode 600, never committed). Mail: Brevo when a key was staged; the catcher only when the operator allowed it knowingly (--allow-mail-catcher). */
export function platformEnv({ pg, platformHost, zone, H, mail, sender }) {
  const lines = [`VULNMART_OWNER_DB_PASSWORD=${pg.owner}`, `VULNMART_APP_DB_PASSWORD=${pg.app}`, `VULNMART_KEYSTORE_PASSWORD=${pg.keystore}`, `VULNMART_VALKEY_PASSWORD=${pg.valkey}`,
    `VULNMART_PLATFORM_HOST=${platformHost}`, `VULNMART_LABS_ZONE=${zone}`, `VULNMART_VMI_PRIVATE_IP=${H.i.priv}`, `VULNMART_VMP_PRIVATE_IP=${H.p.priv}`, `VULNMART_EMAIL_SENDER_ADDRESS=${sender || `no-reply@${platformHost}`}`];
  if (mail === 'brevo') lines.push('VULNMART_EMAIL_PROVIDER=brevo', 'VULNMART_ALLOW_MAIL_CATCHER=false');
  else if (mail === 'catcher') lines.push('VULNMART_EMAIL_PROVIDER=smtp', 'VULNMART_SMTP_HOST=mailpit', 'VULNMART_ALLOW_MAIL_CATCHER=true', 'COMPOSE_PROFILES=mail-catcher');
  else throw new Error('mail is brevo or catcher');
  return `${lines.join('\n')}\n`;
}

/** Which mail mode a deploy runs in, from the secrets folder: a non-empty keys/brevo_api_key means Brevo; without one the deploy stops unless the catcher was asked for. */
export function mailMode({ keyText, allowCatcher }) {
  if ((keyText ?? '').trim()) return 'brevo';
  if (allowCatcher) return 'catcher';
  throw new Error('no Brevo key: put the key in <secrets folder>/keys/brevo_api_key (docs/runbooks/live-deploy.md, Real e-mail), or deploy with --allow-mail-catcher to run knowingly without real mail');
}

/** images.json of the orchestrator from the digests the local registry gave: {role: ref}. Every role of the lab must be there. */
export function buildManifest(digests) {
  const images = {};
  for (const [role, image] of Object.entries(ROLE_IMAGE)) {
    const ref = digests[image];
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$/.test(ref ?? '')) throw new Error(`no digest-pinned reference for ${image} (role ${role})`);
    images[role] = ref;
  }
  return { images, entrypoints: MANIFEST_EXTRAS.entrypoints, commands: MANIFEST_EXTRAS.commands, healthchecks: MANIFEST_EXTRAS.healthchecks };
}

// ---------- plumbing ----------
const cfg = { dryRun: false };
const log = (m) => console.log(m);
function run(cmd, args, opts = {}) {
  if (cfg.dryRun) { log(`  [dry-run] ${path.basename(cmd)} ${args.join(' ').slice(0, 200)}`); return { status: 0, stdout: '', stderr: '' }; }
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts });
}
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`); return r; };

function tf(name) {
  const r = spawnSync('terraform', [`-chdir=${path.join(ROOT, 'infra', 'terraform', 'aws')}`, 'output', '-raw', name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`terraform output ${name} failed (run from a shell with AWS_PROFILE set)`);
  return r.stdout.trim();
}
export const hosts = () => ({ i: { pub: tf('vm_i_public_ip'), priv: tf('vm_i_private_ip') }, p: { pub: tf('vm_p_public_ip'), priv: tf('vm_p_private_ip') } });

const ssh = (host, command) => run(SSH, [...SSH_OPTS, `ubuntu@${host}`, command]);
function sshScript(host, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text.replace(/\r/g, ''));
  try {
    must(run(SCP, [...SSH_OPTS, '-q', file, `ubuntu@${host}:/tmp/${name}`]), `copy ${name}`);
    const r = run(SSH, [...SSH_OPTS, `ubuntu@${host}`, `bash /tmp/${name}; rc=$?; rm -f /tmp/${name}; exit $rc`]);
    if (r.stdout) log(String(r.stdout).trimEnd());
    return must(r, `remote script ${name}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function putFile(host, local, remoteTmp) { must(run(SCP, [...SSH_OPTS, '-q', local, `ubuntu@${host}:${remoteTmp}`]), `copy ${path.basename(local)}`); }

/** Files into a remote folder with an owner and a mode, via a temp folder and `sudo install` (never a secret on a command line). */
function stage(host, files, destDir, owner, mode, dirMode = '700') {
  const tmp = `/tmp/stage-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const lines = ['set -eu', `mkdir -p ${tmp}`];
  const copy = [];
  files.forEach(({ local, name }, i) => { putFile(host, local, `${tmp}.${i}`); copy.push(`sudo install -o ${owner.split(':')[0]} -g ${owner.split(':')[1]} -m ${mode} ${tmp}.${i} ${q(`${destDir}/${name}`)}; rm -f ${tmp}.${i}`); });
  lines.push(`sudo install -d -o ${owner.split(':')[0]} -g ${owner.split(':')[1]} -m ${dirMode} ${q(destDir)}`, ...copy, `rmdir ${tmp} 2>/dev/null || true`);
  sshScript(host, `stage-${Math.floor(Math.random() * 1e6)}.sh`, lines.join('\n'));
}

function repoTar(paths) {
  // `tar -cf -` to a buffer, run inside the repository with relative paths: GNU tar reads `C:\...` as host:path and bsdtar does not mind, so no absolute path is given to it
  const out = path.join(os.tmpdir(), `repo-${Date.now()}.tar`);
  const r = cfg.dryRun ? { status: 0, stdout: Buffer.alloc(0) } : spawnSync('tar', ['-cf', '-', ...paths], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`tar of the repository files failed: ${String(r.stderr).split(/\r?\n/)[0]}`);
  fs.writeFileSync(out, r.stdout); // the working tree, so a file not yet committed is shipped too
  return out;
}
const need = (o, k, why) => { if (!o[k]) throw new Error(`${why} is required`); return o[k]; };

// ---------- commands ----------
function build() {
  for (const [tag, [dockerfile, ctx]] of Object.entries(IMAGES)) {
    log(`build ${tag}`);
    const context = ctx ? path.join(ROOT, ctx) : ROOT;
    const args = ['build', '--platform', 'linux/amd64', '-q', '-t', tag, '-f', path.join(ROOT, dockerfile)];
    if (tag === 'vulnmart-api:prod') args.push('--build-arg', `VULNMART_COMMIT=${spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()}`, '--build-arg', 'VULNMART_VERSION=demo');
    args.push(context);
    must(run('docker', args), `docker build ${tag}`);
  }
  log('PASS images built');
}

function ship(which, h) {
  const tags = SHIP[which];
  const tar = path.join(os.tmpdir(), `images-${which}-${Date.now()}.tar`);
  log(`save ${tags.join(' ')}`);
  must(run('docker', ['save', '-o', tar, ...tags]), 'docker save');
  log(`copy ${(fs.existsSync(tar) ? fs.statSync(tar).size / 1e6 : 0).toFixed(0)} MB to vm-${which}`);
  must(run(SCP, [...SSH_OPTS, '-q', tar, `ubuntu@${h.pub}:/tmp/images.tar`]), 'copy images');
  const r = ssh(h.pub, 'sudo docker load -i /tmp/images.tar && rm -f /tmp/images.tar');
  fs.rmSync(tar, { force: true });
  must(r, 'docker load');
  log(`PASS images on vm-${which}`);
}

function lab(o, H) {
  const dir = path.resolve(need(o, 'secrets', '--secrets <folder>'));
  const zone = need(o, 'zone', '--zone <labs zone>');
  const k = (n) => path.join(dir, 'keys', n);
  const p = (n) => path.join(dir, 'pki', n);
  const host = H.i.pub;
  log('repository files');
  const tar = repoTar(['infra/compose/compose.yaml', 'infra/compose/lab.reports.yaml', 'infra/compose/docker-proxy/rules.cfg', 'infra/caddy/Caddyfile.l', 'contracts/instance/examples/valid/instance-template/shop-template.json']);
  putFile(host, tar, '/tmp/repo.tar'); fs.rmSync(tar, { force: true });
  sshScript(host, 'lab-repo.sh', 'set -eu\nsudo chmod 755 /opt/vulnmart\nsudo install -d -m 755 /opt/vulnmart/lab\nsudo install -d -o ubuntu -g ubuntu -m 755 /opt/vulnmart/lab/repo\ntar -xf /tmp/repo.tar -C /opt/vulnmart/lab/repo && rm -f /tmp/repo.tar\n');
  log('secrets');
  stage(host, [{ local: k('gate_key_current'), name: 'gate_key_current' }, { local: k('gate_key_previous'), name: 'gate_key_previous' }, { local: k('gate_admin_secret'), name: 'gate_admin_secret' }, { local: p('ca.pem'), name: 'ingest_ca.pem' }], '/opt/vulnmart/lab/secrets', OWNER, '400');
  stage(host, [{ local: k('platform_key'), name: 'platform_key' }, { local: p('orch.pem'), name: 'tls_cert.pem' }, { local: p('orch.key'), name: 'tls_key.pem' }, { local: p('ca.pem'), name: 'tls_ca.pem' },
    { local: k('report_key'), name: 'report_key' }, { local: p('ca.pem'), name: 'report_ca.pem' }], '/opt/vulnmart/lab/orchestrator/secrets', OWNER, '400');
  log('template (demo sizes), registry and manifest');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'instance', 'examples', 'valid', 'instance-template', 'shop-template.json'), 'utf8'));
  const tmplFile = path.join(os.tmpdir(), `shop-v0-${Date.now()}.json`);
  fs.writeFileSync(tmplFile, `${JSON.stringify(demoTemplate(example), null, 2)}\n`);
  stage(host, [{ local: tmplFile, name: 'shop-v0.json' }], '/opt/vulnmart/lab/orchestrator/templates', OWNER, '400');
  fs.rmSync(tmplFile, { force: true });
  const manifestScript = `set -eu
sudo install -d -o ${OWNER.split(':')[0]} -g ${OWNER.split(':')[1]} -m 700 /opt/vulnmart/lab/orchestrator/templates

if ! sudo docker ps -a --format '{{.Names}}' | grep -qx vulnmart-local-registry; then
  sudo docker run -d --name vulnmart-local-registry --restart unless-stopped -p 127.0.0.1:5000:5000 --read-only --tmpfs /tmp -v vulnmart-registry:/var/lib/registry registry:2 >/dev/null
fi
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1 && break; sleep 1; done
${[...new Set(Object.values(ROLE_IMAGE))].map((img) => `sudo docker tag ${img} localhost:5000/vulnmart/${img.split(':')[0].replace('vulnmart-', '')}:demo && sudo docker push -q localhost:5000/vulnmart/${img.split(':')[0].replace('vulnmart-', '')}:demo >/dev/null && echo "DIGEST ${img} $(sudo docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/vulnmart/${img.split(':')[0].replace('vulnmart-', '')}:demo)"`).join('\n')}
`;
  const out = sshScript(host, 'lab-manifest.sh', manifestScript);
  const digests = {};
  for (const m of String(out.stdout).matchAll(/^DIGEST (\S+) (\S+)$/gm)) digests[m[1]] = m[2];
  const manifest = buildManifest(digests);
  const tmp = path.join(os.tmpdir(), `images-${Date.now()}.json`);
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  stage(host, [{ local: tmp, name: 'images.json' }], '/opt/vulnmart/lab/orchestrator', OWNER, '400');
  fs.rmSync(tmp, { force: true });
  log('start the lab stack');
  const runtime = o.runtime ?? DEFAULT_RUNTIME;
  const env = labEnv({ zone, H, runtime });
  sshScript(host, 'lab-up.sh', `set -eu
${runtime === 'runsc' ? `# instances run in gVisor (S-8, L-29): refuse to start the lab on a host that does not have the runtime, never fall back to runc by accident
sudo docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || { echo "this host has no runsc runtime: run infra/hosts/vulnmart-install-gvisor.sh first (docs/runbooks/sandbox-gvisor.md), or deploy with --runtime runc" >&2; exit 1; }
` : ''}cd /opt/vulnmart/lab/repo
sudo env ${env} docker compose -f infra/compose/compose.yaml -f infra/compose/lab.reports.yaml --profile lab up -d --no-build --pull missing --wait docker-proxy edge-gate edge-caddy orchestrator
# the orchestrator reads templates and the image manifest once at start, and compose does not restart it for a changed bind-mounted file
sudo docker restart vulnmart-orchestrator >/dev/null
for i in $(seq 1 30); do [ "$(sudo docker inspect -f '{{.State.Health.Status}}' vulnmart-orchestrator)" = healthy ] && break; sleep 2; done
sudo docker ps --format '{{.Names}} {{.Status}}' | sort
`);
  log('PASS lab stack started on vm-i');
}

function platform(o, H) {
  const dir = path.resolve(need(o, 'secrets', '--secrets <folder>'));
  const zone = need(o, 'zone', '--zone <labs zone>');
  const platformHost = need(o, 'platformHost', '--platform-host <name>');
  const k = (n) => path.join(dir, 'keys', n);
  const p = (n) => path.join(dir, 'pki', n);
  const host = H.p.pub;
  log('files');
  const tar = repoTar(['infra/deploy', 'challenges/catalog', 'apps/lab-console']);
  putFile(host, tar, '/tmp/repo.tar'); fs.rmSync(tar, { force: true });
  sshScript(host, 'plat-repo.sh', `set -eu
sudo chmod 755 /opt/vulnmart
sudo install -d -o ubuntu -g ubuntu -m 755 /opt/vulnmart/platform /opt/vulnmart/platform/stage
rm -rf /opt/vulnmart/platform/stage/*
tar -xf /tmp/repo.tar -C /opt/vulnmart/platform/stage && rm -f /tmp/repo.tar
cd /opt/vulnmart/platform
cp stage/infra/deploy/platform.compose.yaml compose.yaml
cp stage/infra/deploy/Caddyfile.platform Caddyfile
install -d postgres/initdb && cp stage/infra/deploy/10-app-role.sql postgres/initdb/
# the two folders are bind-mounted into running containers: replace their CONTENT, never the folder (a deleted and recreated folder leaves a running container with an empty, stale mount)
mkdir -p catalog console && find catalog console -mindepth 1 -delete && cp -r stage/challenges/catalog/. catalog/ && cp -r stage/apps/lab-console/. console/
rm -rf stage
`);
  log('secrets');
  // the API (uid 65532) reads its files as their owner; Caddy runs as root WITHOUT the capability that skips file modes, so what only Caddy reads belongs to root
  // and the one secret both read (the origin secret) is owned by the API user with group root, mode 440: the API reads it as owner, Caddy as gid 0, nobody else on the host
  stage(host, ['csrf_secret', 'field_secret', 'kek', 'event_master', 'flag_key', 'owner_key', 'gate_key_current', 'platform_key', 'report_key'].map((n) => ({ local: k(n), name: n })), '/opt/vulnmart/platform/secrets', OWNER, '400');
  stage(host, [{ local: k('origin_secret'), name: 'origin_secret' }], '/opt/vulnmart/platform/secrets', '65532:0', '440', '755');
  stage(host, [{ local: p('ca.pem'), name: 'ca.pem' }, { local: p('client.pem'), name: 'client.pem' }, { local: p('client.key'), name: 'client.key' }], '/opt/vulnmart/platform/pki', OWNER, '400');
  stage(host, [{ local: p('ingest.pem'), name: 'ingest.pem' }, { local: p('ingest.key'), name: 'ingest.key' }], '/opt/vulnmart/platform/pki', 'root:root', '400', '755');
  // Real e-mail (production hardening): the Brevo key is an external credential kept in the secrets folder as keys/brevo_api_key (never in the repository). The file is always staged
  // (the compose file bind-mounts it; a missing file would become a directory); empty means no key, and then the deploy stops unless the catcher was asked for.
  const brevoFile = path.join(k('brevo_api_key'));
  const brevoText = fs.existsSync(brevoFile) ? fs.readFileSync(brevoFile, 'utf8') : '';
  const mail = mailMode({ keyText: brevoText, allowCatcher: o.allowMailCatcher });
  if (mail === 'catcher') log('WARNING: no Brevo key, running with the mail catcher on purpose (--allow-mail-catcher): no e-mail reaches anyone');
  const emptyKey = path.join(os.tmpdir(), `brevo-empty-${Date.now()}`);
  fs.writeFileSync(emptyKey, '');
  stage(host, [{ local: mail === 'brevo' ? brevoFile : emptyKey, name: 'brevo_api_key' }], '/opt/vulnmart/platform/secrets', OWNER, '400');
  fs.rmSync(emptyKey, { force: true });
  // the audit anchor file (OI-28) is written by the API (uid 65532) into this folder; an operator ships it off the machine
  sshScript(host, 'plat-anchors.sh', `set -eu\nsudo install -d -o ${OWNER.split(':')[0]} -g ${OWNER.split(':')[1]} -m 750 /opt/vulnmart/platform/anchors\n`);
  const envFile = path.join(os.tmpdir(), `platform-env-${Date.now()}`);
  const rd = (n) => fs.readFileSync(k(n), 'utf8').trim();
  // a secrets folder made before the Valkey password existed gets one now (the other secrets are never touched)
  if (!fs.existsSync(k('valkey_password')) && !cfg.dryRun) fs.writeFileSync(k('valkey_password'), crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  fs.writeFileSync(envFile, platformEnv({ pg: { owner: rd('pg_owner_password'), app: rd('pg_app_password'), keystore: rd('keystore_password'), valkey: rd('valkey_password') }, platformHost, zone, H, mail, sender: o.mailSender }));
  stage(host, [{ local: envFile, name: '.env' }], '/opt/vulnmart/platform', 'root:root', '600', '755');
  fs.rmSync(envFile, { force: true });
  log('swap, images and start');
  sshScript(host, 'plat-up.sh', `set -eu
if [ ! -f /swapfile ]; then sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile && (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null); fi
cd /opt/vulnmart/platform
sudo docker compose -f compose.yaml --env-file .env config -q
sudo docker compose -f compose.yaml --env-file .env up -d --no-build --pull missing --wait --wait-timeout 300
# Caddy reads its Caddyfile only at start and compose does not recreate it for a changed bind-mounted file: restart it so the page routes of this deploy are served
sudo docker restart vulnmart-caddy >/dev/null
sudo docker ps --format '{{.Names}} {{.Status}}' | sort
`);
  log('PASS platform stack started on vm-p');
}

/** The certificate renewal hook on both running hosts (cloud-init is not re-run on a host that exists): the script that restarts this host's Caddy when its certificate files changed, and the service unit that calls it. */
function hooks(H) {
  for (const [label, h] of [['vm-p', H.p], ['vm-i', H.i]]) {
    log(`hooks on ${label}`);
    stage(h.pub, [{ local: path.join(ROOT, 'infra', 'hosts', 'vulnmart-reload-caddy.sh'), name: 'vulnmart-reload-caddy.sh' }], '/usr/local/sbin', 'root:root', '755', '755');
    stage(h.pub, [{ local: path.join(ROOT, 'infra', 'hosts', 'vulnmart-certs.service'), name: 'vulnmart-certs.service' }], '/etc/systemd/system', 'root:root', '644', '755');
    // the alert of a failed job (L-10, L-24): the script and the template unit that a failing unit calls through OnFailure=
    stage(h.pub, [{ local: path.join(ROOT, 'infra', 'hosts', 'vulnmart-alert.sh'), name: 'vulnmart-alert.sh' }], '/usr/local/sbin', 'root:root', '755', '755');
    stage(h.pub, [{ local: path.join(ROOT, 'infra', 'hosts', 'vulnmart-alert@.service'), name: 'vulnmart-alert@.service' }], '/etc/systemd/system', 'root:root', '644', '755');
    sshScript(h.pub, 'hooks.sh', 'set -eu\nsudo systemctl daemon-reload\nsudo /usr/local/sbin/vulnmart-reload-caddy.sh\nsudo systemctl cat vulnmart-certs.service | grep -E "ExecStartPost|OnFailure"\n');
  }
  // the daily backup of the platform databases, on vm-p only (L-24)
  log('backup timer on vm-p');
  stage(H.p.pub, [{ local: path.join(ROOT, 'infra', 'hosts', 'vulnmart-backup.sh'), name: 'vulnmart-backup.sh' }], '/usr/local/sbin', 'root:root', '755', '755');
  stage(H.p.pub, ['vulnmart-backup.service', 'vulnmart-backup.timer'].map((n) => ({ local: path.join(ROOT, 'infra', 'hosts', n), name: n })), '/etc/systemd/system', 'root:root', '644', '755');
  sshScript(H.p.pub, 'backup.sh', 'set -eu\nsudo systemctl daemon-reload\nsudo systemctl enable --now vulnmart-backup.timer\nsystemctl list-timers vulnmart-backup.timer --no-pager | head -3\n');
  log('PASS the renewal hook is installed on both hosts');
  // the firewall of the labs host (audit blocker B4): the script that builds the VULNMART-LABS chain, then the service that runs it
  log('egress rules on vm-i');
  stage(H.i.pub, [{ local: path.join(ROOT, 'infra', 'hosts', 'vulnmart-egress.sh'), name: 'vulnmart-egress.sh' }], '/usr/local/sbin', 'root:root', '755', '755');
  sshScript(H.i.pub, 'egress.sh', 'set -eu\nsudo systemctl restart vulnmart-egress.service\nsystemctl is-active vulnmart-egress.service\nsudo iptables -S VULNMART-LABS\n');
  log('PASS the labs chain is rebuilt on vm-i');
}

function status(H) {
  for (const w of ['i', 'p']) {
    log(`=== vm-${w}`);
    const r = ssh(H[w].pub, "sudo docker ps -a --format '{{.Names}} {{.Status}}' | sort; df -h / | tail -1; free -m | sed -n 2p");
    log(String(r.stdout).trimEnd() || String(r.stderr).trim());
  }
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) { console.error(o.error); return 2; }
  cfg.dryRun = o.dryRun;
  try {
    if (o.cmd === 'build') { build(); return 0; }
    const H = hosts();
    if (o.cmd === 'ship-i') ship('i', H.i);
    else if (o.cmd === 'ship-p') ship('p', H.p);
    else if (o.cmd === 'lab') lab(o, H);
    else if (o.cmd === 'platform') platform(o, H);
    else if (o.cmd === 'status') status(H);
    else if (o.cmd === 'hooks') hooks(H);
    else if (o.cmd === 'down-lab') must(ssh(H.i.pub, 'cd /opt/vulnmart/lab/repo && sudo docker compose -f infra/compose/compose.yaml -f infra/compose/lab.reports.yaml --profile lab down'), 'down lab');
    else if (o.cmd === 'down-platform') must(ssh(H.p.pub, 'cd /opt/vulnmart/platform && sudo docker compose -f compose.yaml --env-file .env down'), 'down platform');
    return 0;
  } catch (e) {
    console.error(`FAIL ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
