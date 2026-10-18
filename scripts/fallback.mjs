// Laptop fallback for the live demo (story 8.4): the platform stack on Docker Desktop in one command.
//
//   node scripts/fallback.mjs up [--no-web] [--lab]    start the platform stack (Compose project vulnmart-fallback)
//   node scripts/fallback.mjs check                    PASS or FAIL lines for the local URLs
//   node scripts/fallback.mjs down                     remove only what `up` started
//
// `--lab` also starts the lab runtime (uvicorn of the ingest entrypoint with VULNMART_LAB_RUNTIME=1 and the demo
// routes with a random token written to a temporary file). It refuses when story 1's lab runtime is not in the tree.
// The fallback shows the product on in-memory lab state with stub instances (D-96); it does not restore production data.
// Only objects of the Compose project `vulnmart-fallback` and the one process written to the state file are touched.
// The pure parts are tested in scripts/fallback.test.mjs; the commands are proved by hand
// (docs/runbooks/laptop-fallback.md, evidence docs/assets/story-8-4-backup-fallback/).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPOSE_FILE, MSG_DOCKER_DOWN, dockerRunning, portFree, run } from './dev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'vulnmart-fallback';
export const LAB_PORT = 8100;
export const STATE_DIR = path.join(os.tmpdir(), PROJECT);
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const TOKEN_FILE = path.join(STATE_DIR, 'demo-token');
export const USAGE = 'node scripts/fallback.mjs up [--no-web] [--lab] | check | down';

// ---------- pure parts ----------
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!['up', 'check', 'down'].includes(cmd)) return { error: `Unknown or missing command. Usage: ${USAGE}` };
  const o = { cmd, noWeb: false, lab: false };
  for (const a of rest) {
    if (cmd === 'up' && a === '--no-web') o.noWeb = true;
    else if (cmd === 'up' && a === '--lab') o.lab = true;
    else return { error: `Unknown option "${a}". Usage: ${USAGE}` };
  }
  return o;
}

export const profilesFor = ({ noWeb }) => (noWeb ? ['platform'] : ['platform', 'web']);
export const portsFor = ({ noWeb, lab }) => [8000, 8025, ...(noWeb ? [] : [3000]), ...(lab ? [LAB_PORT] : [])];

export function composeArgs(profiles, rest) {
  return ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...profiles.flatMap((p) => ['--profile', p]), ...rest];
}

export function urlsFor({ noWeb, lab }) {
  return [
    { name: 'api-healthz', url: 'http://127.0.0.1:8000/healthz' },
    { name: 'api-readyz', url: 'http://127.0.0.1:8000/readyz' },
    { name: 'mailpit', url: 'http://127.0.0.1:8025/readyz' },
    ...(noWeb ? [] : [{ name: 'web', url: 'http://127.0.0.1:3000/' }]),
    ...(lab ? [{ name: 'lab-runtime-healthz', url: `http://127.0.0.1:${LAB_PORT}/healthz` }] : []),
  ];
}

export function labEnv(token) {
  return { VULNMART_LAB_RUNTIME: '1', VULNMART_LAB_DEMO: '1', VULNMART_LAB_DEMO_TOKEN: token };
}

export const labArgs = () => ['run', '--project', 'apps/api', 'uvicorn', 'vulnmart.kernel.entrypoints.ingest:app', '--host', '127.0.0.1', '--port', String(LAB_PORT)];

// Names of other containers that would collide with the fixed container_name values of the Compose file.
export function collisions(psOutput) {
  return String(psOutput).split(/\r?\n/).map((s) => s.trim()).filter((n) => /^vulnmart-(postgres|valkey|mailpit|migrate|api|web)$/.test(n));
}

export function formatCheck(rows) {
  return rows.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`).join('\n');
}

export const checkExit = (rows) => (rows.length && rows.every((r) => r.ok) ? 0 : 1);

// ---------- helpers ----------
const compose = (profiles, rest, opts = {}) => run('docker', composeArgs(profiles, rest), { timeout: 1200000, ...opts });

function get(url, headers = {}) {
  return new Promise((resolve) => {
    http
      .get(url, { timeout: 5000, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      })
      .on('error', (e) => resolve({ status: 0, error: e.code || e.message }))
      .on('timeout', function () {
        this.destroy();
      });
  });
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null);

// ---------- commands ----------
export async function up(o) {
  if (!dockerRunning()) return console.error(MSG_DOCKER_DOWN), 1;
  if (readState()) return console.error('FAIL a fallback is already up (state file found). Run `node scripts/fallback.mjs down` first.'), 1;
  for (const p of portsFor(o)) if (!(await portFree(p))) return console.error(`FAIL port ${p} is busy on 127.0.0.1; free it first (nothing was started).`), 1;
  const ps = run('docker', ['ps', '-a', '--format', '{{.Names}}']);
  const clash = collisions(ps.stdout);
  if (clash.length) return console.error(`FAIL containers of another VulnMart stack exist (${clash.join(', ')}); the Compose file uses fixed names. Remove them first (nothing was started).`), 1;
  if (o.lab && !existsSync(path.join(ROOT, 'apps', 'api', 'src', 'vulnmart', 'lab'))) return console.error('FAIL --lab needs the lab runtime (story 1, apps/api/src/vulnmart/lab), which is not in this tree. Run without --lab.'), 1;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ project: PROJECT, profiles: profilesFor(o), lab: o.lab, labPid: null }));
  console.log(`starting platform stack (project ${PROJECT}, profiles ${profilesFor(o).join(' + ')}); the first run builds images and takes minutes`);
  const r = compose(profilesFor(o), ['up', '-d', '--wait', '--quiet-pull']);
  if (r.status !== 0) {
    console.error(`FAIL compose up failed: ${r.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' ')}`);
    await down();
    return 1;
  }
  if (o.lab) {
    const token = randomBytes(24).toString('hex');
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    const out = openSync(path.join(STATE_DIR, 'lab-runtime.log'), 'a');
    const child = spawn('uv', labArgs(), { cwd: ROOT, env: { ...process.env, ...labEnv(token) }, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' });
    writeFileSync(STATE_FILE, JSON.stringify({ project: PROJECT, profiles: profilesFor(o), lab: true, labPid: child.pid, noWeb: o.noWeb }));
    child.unref();
  }
  writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), noWeb: o.noWeb }));
  console.log('PASS platform stack up. URLs:');
  for (const u of urlsFor(o)) console.log(`     ${u.name}: ${u.url}`);
  if (o.lab) console.log(`     demo token file (not printed): ${TOKEN_FILE}`);
  console.log('Next: node scripts/fallback.mjs check');
  return 0;
}

export async function check() {
  const st = readState();
  if (!st) return console.error('FAIL no fallback is up (no state file). Run `node scripts/fallback.mjs up` first.'), 1;
  const rows = [];
  for (const u of urlsFor({ noWeb: !!st.noWeb, lab: !!st.lab })) {
    let r = { status: 0 };
    for (let i = 0; i < (u.name.startsWith('lab') ? 20 : 3); i++) {
      r = await get(u.url);
      if (r.status === 200) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    rows.push({ name: u.name, ok: r.status === 200, detail: r.status ? `HTTP ${r.status}` : `no answer (${r.error})` });
  }
  // The API refuses /api/* without the origin secret: proves the guard is on in the fallback too.
  const g = await get('http://127.0.0.1:8000/api/v1/health');
  rows.push({ name: 'api-refuses-without-origin-secret', ok: g.status === 403, detail: `HTTP ${g.status} (want 403)` });
  console.log(formatCheck(rows));
  return checkExit(rows);
}

export async function down() {
  const st = readState();
  const profiles = st?.profiles ?? ['platform', 'web'];
  if (st?.labPid) killTree(st.labPid);
  const r = compose(profiles, ['down', '-v', '--remove-orphans', '--timeout', '2']);
  rmSync(STATE_DIR, { recursive: true, force: true });
  const left = run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`]).stdout.trim();
  const nets = run('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).stdout.trim();
  const vols = run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).stdout.trim();
  const clean = r.status === 0 && !left && !nets && !vols;
  console.log(clean ? `PASS down: project ${PROJECT} removed (no container, network or volume left), temporary files removed` : `FAIL down: compose exit ${r.status}; left containers=${left.split(/\s+/).filter(Boolean).length} networks=${nets.split(/\s+/).filter(Boolean).length} volumes=${vols.split(/\s+/).filter(Boolean).length}`);
  return clean ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) return console.error(o.error), 2;
  return { up, check, down }[o.cmd](o);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
