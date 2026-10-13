#!/usr/bin/env node
// Human-run deploy of the hello stack from a CI release manifest (story L-12, ADR 0011 and 0032). CI never deploys; a person runs this.
// Usage: node scripts/deploy.mjs --manifest <release.json> --target p,i,local [--identity <ssh-private-key-path>] [--provider aws|oci | --hosts <file>]
//        [--user ubuntu] [--timeout <seconds, default 600, per ssh or docker call>] [--dry-run] [--continue]
// Targets: p (vm-p) and i (vm-i) over ssh with your key, local (this machine's Docker). Each target: pull by digest, compose up, health check.
// --dry-run prints the commands and runs nothing. Exit codes: 0 ok, 1 a step failed or a host is unreachable, 2 bad input (a manifest entry that is a tag and not a digest, bad options).
// Nothing secret or any address is printed: ssh output is redacted and hosts are shown by label.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHosts, resolveHostsFile, redact, sshRun, parseArgs } from './cloud-hosts.mjs';
import { loadImages } from './images-matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = path.join(ROOT, 'infra', 'compose', 'hello-stack.yaml');
export const CONTAINER = 'vulnmart-hello-stack';
export const REMOTE_DIR = '~/vulnmart-deploy';
export const TARGETS = { p: 'vm-p', i: 'vm-i', local: 'local' };
// registry host[:port] / path @ sha256 digest. A tag (even with a digest elsewhere) is not accepted.
const DIGEST_REF = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?\/[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/;

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export class InputError extends Error {}

/** Reads the manifest text and returns the hello image reference. Throws InputError (exit 2) unless it is a digest reference. */
export function helloImage(manifestText, registry = loadImages().registry) {
  let m;
  try {
    m = JSON.parse(manifestText.replace(/^﻿/, ''));
  } catch {
    throw new InputError('the manifest is not valid JSON');
  }
  const ref = m?.images?.hello;
  if (typeof ref !== 'string') throw new InputError('the manifest has no image "hello"');
  if (!DIGEST_REF.test(ref)) throw new InputError('the manifest entry for "hello" is not a digest reference (<registry>/<path>@sha256:<64 hex>): tags are refused');
  if (!ref.startsWith(`${registry}/`)) throw new InputError(`the manifest entry for "hello" is not from the registry of infra/images.json (${registry})`);
  // The whole path is fixed: <registry>/<owner>/<repo>/hello@sha256:<64 hex>, with owner/repo as images-release.mjs recorded them in release.json.
  const repo = m?.repo;
  if (typeof repo !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) throw new InputError('the manifest has no valid "repo" (owner/name): it was not made by scripts/images-release.mjs');
  const prefix = `${registry}/${repo}/hello@sha256:`;
  if (!(ref.startsWith(prefix) && /^[0-9a-f]{64}$/.test(ref.slice(prefix.length)))) {
    throw new InputError(`the manifest entry for "hello" must be ${registry}/${repo}/hello@sha256:<64 hex>, as recorded in the manifest`);
  }
  return ref;
}

const USER = /^[a-z_][a-z0-9_-]*$/;
export function checkSshInputs({ user, identity }) {
  if (!USER.test(user)) throw new InputError('--user must match ^[a-z_][a-z0-9_-]*$');
  if (identity !== undefined && String(identity).startsWith('-')) throw new InputError('--identity must be a path that does not start with "-"');
}

export function parseTargets(value) {
  const list = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new InputError('--target needs p, i, local or a comma list of them');
  for (const t of list) if (!TARGETS[t]) throw new InputError(`unknown target "${t}": use p, i or local`);
  return [...new Set(list)];
}

/** The remote commands (shown by --dry-run, run over ssh). */
export const remoteCommands = (image) => ({
  prepare: `mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_DIR}/hello-stack.yaml`,
  pull: `sudo -n docker pull ${image}`,
  up: `cd ${REMOTE_DIR} && sudo -n env HELLO_IMAGE=${image} docker compose -f hello-stack.yaml up -d --force-recreate --pull never`,
  // The running container must use exactly the image that was pulled by digest (image ids compared).
  // Both ids must be non-empty: two failed commands would give two empty strings that are "equal".
  verify: `a=$(sudo -n docker inspect -f '{{.Image}}' ${CONTAINER}); b=$(sudo -n docker image inspect -f '{{.Id}}' ${image}); [ -n "$a" ] && [ -n "$b" ] && [ "$a" = "$b" ] || { echo "the running container does not use the pulled image"; exit 1; }`,
  health: `for i in $(seq 1 30); do s=$(sudo -n docker inspect -f '{{.State.Health.Status}}' ${CONTAINER} 2>/dev/null); [ "$s" = healthy ] && exit 0; sleep 2; done; echo "health=$s"; exit 1`,
});

/** The local commands as argument lists. */
export const localCommands = (image, composeFile = COMPOSE_FILE) => ({
  pull: ['docker', 'pull', image],
  up: ['docker', 'compose', '-f', composeFile, 'up', '-d', '--force-recreate', '--pull', 'never'],
  containerImage: ['docker', 'inspect', '-f', '{{.Image}}', CONTAINER],
  pulledImage: (image) => ['docker', 'image', 'inspect', '-f', '{{.Id}}', image],
  health: ['docker', 'inspect', '-f', '{{.State.Health.Status}}', CONTAINER],
});

/** Real local runner: { code, stdout, stderr }. */
export function localRun(argv, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr: timedOut ? `${stderr}timed out after ${Math.round(timeoutMs / 1000)} s` : stderr });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Redact the whole text first, then keep the last lines and truncate (an address cut in half must not escape the redaction).
const firstLine = (s, redactFn = (x) => x) => redactFn(String(s)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 300);

/**
 * Deploys to the chosen targets. Injected: ssh (like sshRun), local (like localRun), hosts (for ssh targets), compose (text of the compose file), log, wait.
 * Returns the exit code (0 or 1). With dryRun nothing is run.
 */
export async function deploy({ image, targets, hosts, identity, user = 'ubuntu', dryRun = false, keepGoing = false, ssh = sshRun, local = localRun, compose, log = console.log, wait = sleep, healthAttempts = 30, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const redactOut = (text) => (hosts ? redact(text, hosts) : redact(text, {}));
  let failures = 0;
  for (const t of targets) {
    const label = TARGETS[t];
    const step = (name, ok, detail = '') => log(`${ok ? 'PASS' : 'FAIL'} ${label} ${name}${detail ? ` - ${detail}` : ''}`);
    let ok = true;
    if (t === 'local') {
      const c = localCommands(image);
      if (dryRun) {
        log(`DRY ${label} ${c.pull.join(' ')}`);
        log(`DRY ${label} HELLO_IMAGE=${image} ${c.up.join(' ')}`);
        log(`DRY ${label} ${c.health.join(' ')} (until healthy)`);
        continue;
      }
      const run = async (name, argv, env) => {
        const r = await local(argv, env, timeoutMs);
        step(name, r.code === 0, r.code === 0 ? '' : firstLine(r.stderr || r.stdout, redactOut));
        return r.code === 0;
      };
      ok = (await run('pull', c.pull)) && (await run('compose up', c.up, { HELLO_IMAGE: image }));
      if (ok) {
        const [running, pulled] = [await local(c.containerImage, {}, timeoutMs), await local(c.pulledImage(image), {}, timeoutMs)];
        ok = running.code === 0 && pulled.code === 0 && running.stdout.trim() !== '' && running.stdout.trim() === pulled.stdout.trim();
        step('verify image', ok, ok ? '' : 'the running container does not use the pulled image');
      }
      if (ok) {
        let status = '';
        for (let n = 0; n < healthAttempts; n++) {
          const r = await local(c.health, {}, timeoutMs);
          status = r.stdout.trim();
          if (status === 'healthy') break;
          await wait(2000);
        }
        ok = status === 'healthy';
        step('health check', ok, ok ? '' : `status=${status || 'unknown'}`);
      }
    } else {
      const c = remoteCommands(image);
      if (dryRun) {
        log(`DRY ${label} ssh: ${c.prepare}   (stdin: infra/compose/hello-stack.yaml)`);
        for (const k of ['pull', 'up', 'verify', 'health']) log(`DRY ${label} ssh: ${c[k]}`);
        continue;
      }
      const host = hosts?.[label]?.pub;
      if (!host) {
        step('address', false, 'no address for this host: pass --provider aws|oci or --hosts <file>');
        ok = false;
      } else {
        const remote = async (name, command, input) => {
          const r = await ssh({ host, user, identity, command, input, timeoutMs });
          if (r.code === 255) {
            step(name, false, 'cannot reach the host over ssh (check the address file, your IP in the security group and the key)');
            return false;
          }
          step(name, r.code === 0, r.code === 0 ? '' : firstLine(r.stderr || r.stdout, redactOut));
          return r.code === 0;
        };
        ok = (await remote('copy compose file', c.prepare, compose)) && (await remote('pull', c.pull)) && (await remote('compose up', c.up)) && (await remote('verify image', c.verify)) && (await remote('health check', c.health));
      }
    }
    if (!ok) {
      failures++;
      if (!keepGoing) break;
    }
  }
  if (dryRun) return 0;
  log(failures ? `RESULT FAIL (${failures} target(s) failed)` : 'RESULT PASS');
  return failures ? 1 : 0;
}

export async function main(argv, { log = console.log, err = console.error, read = (f) => readFileSync(f, 'utf8'), ...inject } = {}) {
  let opts;
  try {
    opts = parseArgs(argv, { values: ['manifest', 'target', 'identity', 'hosts', 'provider', 'user', 'timeout'] });
    const timeoutMs = opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(opts.timeout) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new InputError('--timeout must be a positive number of seconds');
    if (!opts.manifest) throw new InputError('--manifest <release.json> is required');
    const targets = parseTargets(opts.target);
    let text;
    try {
      text = read(opts.manifest);
    } catch {
      throw new InputError(`cannot read the manifest ${opts.manifest}`);
    }
    const image = helloImage(text);
    const needSsh = targets.some((t) => t !== 'local');
    const dryRun = !!opts['dry-run'];
    let hosts;
    if (needSsh && !dryRun) {
      if (!opts.identity) throw new InputError('--identity <ssh-private-key-path> is required for targets p and i');
      checkSshInputs({ user: opts.user ?? 'ubuntu', identity: opts.identity });
      try {
        hosts = (inject.loadHosts ?? loadHosts)(resolveHostsFile(opts));
      } catch (e) {
        throw new InputError(e.message);
      }
    }
    const compose = read(COMPOSE_FILE);
    return await deploy({ image, targets, hosts, identity: opts.identity, user: opts.user ?? 'ubuntu', dryRun, keepGoing: !!opts.continue, compose, log, ssh: inject.ssh, local: inject.local, wait: inject.wait, timeoutMs });
  } catch (e) {
    if (e instanceof InputError || /^usage:/.test(e.message)) {
      err(`error: ${e.message}`);
      return 2;
    }
    err(`error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
