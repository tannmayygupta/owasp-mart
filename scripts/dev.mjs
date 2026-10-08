#!/usr/bin/env node
// One command to start VulnMart containers on Windows, macOS and Linux. Node built-ins only.
//   node scripts/dev.mjs hello | up <profile...> | down | doctor | --help
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELLO_PORT = 18080;
export const HELLO_CONTAINER = 'vulnmart-hello';
export const PROFILES = ['platform', 'web', 'lab', 'mocks'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = path.join(ROOT, 'infra', 'compose', 'compose.yaml');

export const HELP = `VulnMart developer commands

Usage: node scripts/dev.mjs <command>

  hello             Start the hardened hello container, check it, remove it
  up <profile...>   Start Compose profiles: ${PROFILES.join(', ')}
  down              Stop and remove everything this project started
  doctor            Print tool versions (Node, pnpm, uv, Docker, Compose) with PASS or FAIL
  --help            Show this text
`;

export const MSG_DOCKER_DOWN =
  'Docker is not running. Start Docker Desktop, wait until it says "Engine running", then run this command again.';
export const msgPortBusy = (port) =>
  `Port ${port} is already in use on 127.0.0.1. Stop whatever listens on it, then run this command again.`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return { cmd: 'help' };
  if (cmd === 'hello' || cmd === 'down' || cmd === 'doctor') {
    if (rest.length) return { error: `"${cmd}" takes no arguments.` };
    return { cmd };
  }
  if (cmd === 'up') {
    if (!rest.length) return { error: `"up" needs at least one profile (${PROFILES.join(', ')}).` };
    const bad = rest.filter((p) => !PROFILES.includes(p));
    if (bad.length) return { error: `Unknown profile: ${bad.join(', ')}. Valid: ${PROFILES.join(', ')}.` };
    return { cmd, profiles: [...new Set(rest)] };
  }
  return { error: `Unknown command "${cmd}". Run with --help.` };
}

// Default runner: runs a command and returns { status, stdout, stderr }. A missing tool gives status 127.
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd !== 'docker', // pnpm is a .cmd shim on Windows
    timeout: 300000,
    killSignal: 'SIGKILL',
    ...opts,
  });
  if (r.error?.code === 'ETIMEDOUT') return { status: 124, stdout: '', stderr: `${cmd} timed out and was killed.` };
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function dockerRunning(runner = run) {
  // `docker info` can exit 0 while printing a daemon error, so also require a version on stdout.
  const r = runner('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 });
  return r.status === 0 && /^\d/.test(r.stdout.trim());
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { timeout: 5000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject)
      .on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

const compose = (args, runner = run) => runner('docker', ['compose', '-f', COMPOSE_FILE, ...args]);

export async function hello({ runner = run, isPortFree = portFree, get = httpGet, log = console.log, err = console.error } = {}) {
  if (!dockerRunning(runner)) { err(MSG_DOCKER_DOWN); return 1; }
  runner('docker', ['rm', '-f', HELLO_CONTAINER]); // stale container from an earlier run
  if (!(await isPortFree(HELLO_PORT))) { err(msgPortBusy(HELLO_PORT)); return 1; }
  let code = 0;
  try {
    const up = compose(['--profile', 'hello', 'up', '-d', '--wait', '--quiet-pull'], runner);
    if (up.status !== 0) { err(`Could not start the hello container.\n${up.stderr}`); code = 1; }
    else {
      const res = await get(`http://127.0.0.1:${HELLO_PORT}/`);
      if (res.status === 200 && res.body.includes('hello')) log(res.body.trim());
      else { err(`Unexpected answer: HTTP ${res.status}`); code = 1; }
    }
  } catch (e) {
    err(`Hello check failed: ${e.message}`); code = 1;
  } finally {
    compose(['--profile', 'hello', 'down', '--remove-orphans', '--timeout', '2'], runner);
    runner('docker', ['rm', '-f', HELLO_CONTAINER]);
  }
  return code;
}

export function up(profiles, { runner = run, log = console.log, err = console.error } = {}) {
  if (!dockerRunning(runner)) { err(MSG_DOCKER_DOWN); return 1; }
  const profArgs = profiles.flatMap((p) => ['--profile', p]);
  const svc = compose([...profArgs, 'config', '--services'], runner);
  if (svc.status !== 0) { err(`docker compose config failed.\n${svc.stderr}`); return 1; }
  if (!svc.stdout.trim()) {
    err(`Profile(s) ${profiles.join(', ')} have no services yet. A later story adds them; nothing was started.`);
    return 1;
  }
  const r = compose([...profArgs, 'up', '-d', '--wait'], runner);
  if (r.status !== 0) { err(r.stderr); return 1; }
  log(`Started: ${svc.stdout.trim().split(/\s+/).join(', ')}`);
  return 0;
}

export function down({ runner = run, log = console.log, err = console.error } = {}) {
  if (!dockerRunning(runner)) { err(MSG_DOCKER_DOWN); return 1; }
  const allProfiles = ['hello', ...PROFILES].flatMap((p) => ['--profile', p]);
  const r = compose([...allProfiles, 'down', '--remove-orphans'], runner);
  if (r.status !== 0) { err(r.stderr); return 1; }
  log('Project vulnmart stopped and removed.');
  return 0;
}

export function readPins() {
  const node = readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return { node, pnpm: String(pkg.packageManager || '').replace(/^pnpm@/, '').split('+')[0] };
}

export function doctor({ runner = run, log = console.log, nodeVersion = process.version, pins = readPins() } = {}) {
  const first = (s) => s.trim().split(/\r?\n/)[0];
  const tool = (label, cmd, args) => {
    const r = runner(cmd, args);
    return { label, ok: r.status === 0, text: r.status === 0 ? first(r.stdout) : 'not found or failed' };
  };
  const pnpmCheck = () => {
    const c = tool('pnpm', 'pnpm', ['--version']);
    if (c.ok) { c.ok = c.text === pins.pnpm; c.text = `${c.text} (pinned ${pins.pnpm})`; }
    return c;
  };
  const checks = [
    {
      label: 'Node',
      ok: nodeVersion.replace(/^v/, '').split('.')[0] === pins.node.split('.')[0],
      text: `${nodeVersion} (pinned major ${pins.node.split('.')[0]}, .node-version ${pins.node})`,
    },
    pnpmCheck(),
    tool('uv', 'uv', ['--version']),
    tool('Docker', 'docker', ['--version']),
    tool('Compose', 'docker', ['compose', 'version', '--short']),
  ];
  const daemon = dockerRunning(runner);
  checks.push({ label: 'Docker engine', ok: daemon, text: daemon ? 'running' : 'not running (start Docker Desktop)' });
  for (const c of checks) log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(14)} ${c.text}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.error) { console.error(a.error); return 1; }
  switch (a.cmd) {
    case 'help': console.log(HELP); return 0;
    case 'hello': return hello();
    case 'up': return up(a.profiles);
    case 'down': return down();
    case 'doctor': return doctor();
    default: return 1;
  }
}

if (import.meta.main) {
  main().then((c) => process.exit(c));
}
