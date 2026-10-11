#!/usr/bin/env node
// Conformance check of a running or planned instance against the instance contract (IF-6) and the event contract (IF-4). Story L-06.
//   node scripts/check-instance-conformance.mjs                 resolve infra/compose/harness.yaml and check it (static rules, needs Docker Compose)
//   node scripts/check-instance-conformance.mjs --config <file> check a resolved config (`docker compose config --format json`) from a file
// The harness (scripts/harness.mjs) also runs the live checks: probes of the running stack and `docker inspect` of every container.
// Every check has a NAME (the rule). A failure names the rule, and never prints a value that could be a flag, a seed or a key.
// Node built-ins only.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HARNESS_FILE = path.join(ROOT, 'infra', 'compose', 'harness.yaml');
export const DOCKERFILE = path.join(ROOT, 'contracts', 'mocks', 'stub-instance', 'Dockerfile');

export const RUN_USER = '65532:65532';
export const ENV_ALLOWLIST = ['VM_INSTANCE_ID', 'VM_EPOCH', 'VM_PUBLIC_HOST', 'VM_SIDECAR_EVENTS_URL', 'VM_MOCK_URL', 'VM_IMPORT_SOCKET', 'VM_DB_PATH', 'VM_CATALOG_DB_PATH', 'VM_SNAPSHOT_PATH', 'VM_FLAGS_PATH', 'PORT', 'TZ', 'VM_LOG_LEVEL'];
// The only services that are not instance roles. Everything else is checked as part of the instance.
export const HARNESS_HELPERS = Object.freeze(['ingest', 'volume-keeper']);
export const TMPFS_TARGETS = ['/tmp', '/data'];
// The four named memory-backed volumes and the one target each is mounted at (IF-6 section 7).
export const VOLUMES = { 'vm-run': '/run/vm', 'vm-import': '/run/import', 'vm-placement-import': '/run/placement/import', 'vm-placement-mock': '/run/placement/mock' };
const FLAG_LIKE = /[Vv][Mm](?:\{|%7[Bb]|｛)/;
const FORBIDDEN_ENV = /^VM_FLAG_|_(KEY|SECRET|TOKEN|PASSWORD)$|SEED/i;

const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const volumesOf = (svc) => toArray(svc.volumes);
const tmpfsTargets = (svc) => toArray(svc.tmpfs).map((t) => String(t).split(':')[0]);
const bytes = (v) => Number(v);

// Returns [{ rule, ok, detail }] for a resolved compose config (object).
export function checkConfig(config, { dockerfile = '' } = {}) {
  const results = [];
  const services = config.services || {};
  const names = Object.keys(services);
  // Every service is an instance service unless it is on the explicit allowlist of harness helpers (by name).
  const inst = names.filter((n) => !HARNESS_HELPERS.includes(n));
  const each = (rule, names2, test, why) => {
    const bad = [];
    for (const n of names2) { const r = test(services[n], n); if (r) bad.push(`${n}: ${r === true ? why : r}`); }
    results.push({ rule, ok: bad.length === 0, detail: bad.join('; ') });
  };

  // generic profile, every container of the harness (instance roles and helpers)
  each('run-user-65532', names, (s) => s.user !== RUN_USER, `user must be ${RUN_USER}`);
  each('read-only-root', names, (s) => s.read_only !== true, 'root filesystem must be read-only');
  each('no-new-privileges', names, (s) => !toArray(s.security_opt).includes('no-new-privileges:true'), 'security_opt must hold no-new-privileges:true');
  each('cap-drop-all', names, (s) => !toArray(s.cap_drop).includes('ALL') || toArray(s.cap_add).length > 0, 'cap_drop must be ALL and nothing may be added');
  each('not-privileged', names, (s) => s.privileged === true || toArray(s.devices).length > 0 || toArray(s.volumes_from).length > 0, 'privileged, devices and volumes_from are not allowed');
  each('no-bind-mounts', names, (s) => volumesOf(s).some((v) => v.type === 'bind' || v.type === 'npipe') || /(^|[:/])(docker\.sock)/.test(JSON.stringify(s.volumes || '')), 'a bind mount or host path is not allowed');
  each('ports-loopback-only', names, (s) => toArray(s.ports).some((p) => p.host_ip !== '127.0.0.1'), 'every published port must be bound to 127.0.0.1');
  each('resource-limits', names, (s) => !(bytes(s.mem_limit) > 0 && Number(s.cpus) > 0 && Number(s.pids_limit) > 0), 'mem_limit, cpus and pids_limit are required');

  each('writable-places-memory-backed', names, (s) => {
    const targets = [];
    for (const t of tmpfsTargets(s)) { if (!TMPFS_TARGETS.includes(t)) return `tmpfs at ${t} (only /tmp and /data)`; targets.push(t); }
    for (const v of volumesOf(s)) {
      if (v.type === 'tmpfs') { if (!TMPFS_TARGETS.includes(v.target)) return `tmpfs at ${v.target}`; targets.push(v.target); continue; }
      if (v.type !== 'volume' || !v.source) return `mount at ${v.target} is not a named volume`;
      if (!(v.source in VOLUMES)) return `volume ${v.source} is not one of the four`;
      if (VOLUMES[v.source] !== v.target) return `volume ${v.source} must be mounted at ${VOLUMES[v.source]}`;
      targets.push(v.target);
    }
    return new Set(targets).size !== targets.length ? 'a mount target is used twice' : false;
  });

  const declared = config.volumes || {};
  const badVolumes = Object.entries(declared).filter(([n, v]) => !(n in VOLUMES) || v.driver_opts?.type !== 'tmpfs' || v.driver_opts?.device !== 'tmpfs' || !/(^|,)size=\d+[mMgG]?(,|$)/.test(v.driver_opts?.o || '') || v.external === true);
  const missing = Object.keys(VOLUMES).filter((n) => !(n in declared));
  results.push({ rule: 'named-volumes-memory-backed', ok: !badVolumes.length && !missing.length, detail: [...badVolumes.map(([n]) => `volume ${n} must be a tmpfs volume with a size`), ...missing.map((n) => `volume ${n} is missing`)].join('; ') });

  each('env-allowlist-and-no-secrets', names, (s) => {
    for (const [k, v] of Object.entries(s.environment || {})) {
      if (!ENV_ALLOWLIST.includes(k)) return `environment name ${k} is not allowed`;
      if (FORBIDDEN_ENV.test(k)) return `environment name ${k} looks like a secret`;
      if (String(v ?? '').length > 512 || FLAG_LIKE.test(String(v ?? ''))) return `environment value of ${k} is too long or flag-like`;
    }
    return toArray(s.command).concat(toArray(s.entrypoint)).some((c) => FLAG_LIKE.test(String(c))) ? 'a command holds a flag-like value' : false;
  });

  // instance roles
  each('service-kind-label', names, (s, n) => { const k = s.labels?.['vm.kind']; const want = HARNESS_HELPERS.includes(n) ? 'harness' : 'inst'; return k === want ? false : `label vm.kind is ${k === undefined ? 'missing' : 'unknown or wrong'}, must be ${want}`; }, '');
  each('explicit-container-network', names, (s) => { const m = s.network_mode; if (m !== undefined && m !== 'none') return `network_mode ${String(m).split(':')[0]} is not allowed`; return m === undefined && !Object.keys(s.networks || {}).length ? 'no explicit network (it would join the implicit default network)' : false; }, '');
  const injector = services.injector;
  results.push({ rule: 'injector-network-none', ok: !!injector && injector.network_mode === 'none' && !Object.keys(injector.networks || {}).length, detail: injector ? 'the injector must use network_mode none and no network' : 'there is no injector service' });
  each('start-order-injector-first', inst, (s, n) => (n === 'injector'
    ? Object.keys(s.depends_on || {}).length > 0
    : s.depends_on?.injector?.condition !== 'service_completed_successfully'), 'every other instance container must depend on the injector with condition service_completed_successfully (the injector depends on nothing)');

  const mounters = (target) => inst.filter((n) => volumesOf(services[n]).some((v) => v.target === target)).map((n) => ({ n, v: volumesOf(services[n]).find((x) => x.target === target) }));
  const bad = [];
  const rw = (m) => m.v.read_only !== true;
  const run = mounters('/run/vm');
  if (run.length !== 2 || !run.some((m) => m.n === 'injector' && rw(m)) || !run.some((m) => m.n === 'shop' && !rw(m))) bad.push('/run/vm: only the injector (read-write) and the shop (read-only)');
  for (const t of ['/run/placement/import', '/run/placement/mock']) {
    const m = mounters(t);
    if (!m.some((x) => x.n === 'injector' && rw(x))) bad.push(`${t}: the injector must mount it read-write`);
    if (m.some((x) => x.n !== 'injector' && rw(x))) bad.push(`${t}: only the injector may write`);
    if (m.some((x) => ['shop', 'sidecar'].includes(x.n))) bad.push(`${t}: the shop and the sidecar must not mount it`);
  }
  if (mounters('/run/import').some((m) => m.n !== 'shop')) bad.push('/run/import: only the shop (and the import service) may mount it');
  results.push({ rule: 'shared-volume-roles', ok: bad.length === 0, detail: bad.join('; ') });

  // The helper names are an allowlist of NAMES, so they must not be a way to skip rules: a helper gets the generic rules above, the
  // no-outside-network rule below, and these extra limits (no published port, only read-only volumes, no start-order or role exemption).
  const helpers = names.filter((n) => HARNESS_HELPERS.includes(n));
  each('harness-helpers-minimal', helpers, (s) => {
    if (toArray(s.ports).length) return 'a harness helper must not publish a port';
    if (volumesOf(s).some((v) => v.type === 'volume' && v.read_only !== true)) return 'a harness helper may mount shared volumes read-only only';
    return Object.keys(s.depends_on || {}).some((k) => !HARNESS_HELPERS.includes(k)) ? 'a harness helper must not depend on instance services' : false;
  }, '');

  const open = Object.entries(config.networks || {}).filter(([, n]) => n.internal !== true).map(([k]) => k);
  // Applies to helpers too: only the edge may sit on a network with outside access.
  const onOpen = names.filter((n) => Object.keys(services[n].networks || {}).some((k) => open.includes(k)));
  results.push({ rule: 'no-outside-network', ok: onOpen.every((n) => n === 'edge'), detail: `only the edge may sit on a network with outside access; found: ${onOpen.join(', ')}` });

  const shop = services.shop;
  results.push({ rule: 'shop-health-is-readyz', ok: !!shop && toArray(shop.healthcheck?.test).some((t) => String(t).includes('/readyz')), detail: 'the shop healthcheck must call /readyz' });
  results.push({ rule: 'base-image-pinned-by-digest', ok: /^FROM\s+\S+@sha256:[0-9a-f]{64}/m.test(dockerfile), detail: 'the Dockerfile FROM line must pin the base image by digest' });

  return results.map((r) => ({ ...r, detail: r.ok ? '' : r.detail }));
}

// `docker inspect` of the containers of the running stack: the effective settings must match the profile (catches drift between the file and Docker).
export function checkInspect(containers) {
  const results = [];
  const each = (rule, test, why) => {
    const bad = [];
    for (const c of containers) { const r = test(c); if (r) bad.push(`${String(c.Name).replace(/^\//, '')}: ${r === true ? why : r}`); }
    results.push({ rule, ok: bad.length === 0, detail: bad.join('; ') });
  };
  each('live-run-user', (c) => c.Config?.User !== RUN_USER, `user must be ${RUN_USER}`);
  each('live-read-only-root', (c) => c.HostConfig?.ReadonlyRootfs !== true, 'root filesystem must be read-only');
  each('live-no-new-privileges', (c) => !toArray(c.HostConfig?.SecurityOpt).includes('no-new-privileges:true'), 'no-new-privileges must be set');
  each('live-cap-drop-all', (c) => !toArray(c.HostConfig?.CapDrop).includes('ALL') || toArray(c.HostConfig?.CapAdd).length > 0, 'cap_drop ALL and no added capability');
  each('live-not-privileged', (c) => c.HostConfig?.Privileged === true, 'must not be privileged');
  each('live-no-bind-mounts', (c) => toArray(c.Mounts).some((m) => m.Type === 'bind'), 'no bind mount');
  each('live-ports-loopback-only', (c) => Object.values(c.HostConfig?.PortBindings || {}).some((b) => toArray(b).some((x) => x.HostIp !== '127.0.0.1')), 'published ports on 127.0.0.1 only');
  each('live-injector-no-network', (c) => (String(c.Name).endsWith('-injector') ? c.HostConfig?.NetworkMode !== 'none' || Object.keys(c.NetworkSettings?.Networks || {}).some((k) => k !== 'none') : false), 'the injector must have no network');
  each('live-no-secret-in-env', (c) => toArray(c.Config?.Env).some((e) => FORBIDDEN_ENV.test(String(e).split('=')[0]) || FLAG_LIKE.test(String(e))), 'no flag, seed or key in the environment');
  return results;
}

export function formatResults(results) {
  const lines = results.map((r) => (r.ok ? `PASS  ${r.rule}` : `FAIL  ${r.rule}: ${r.detail}`));
  const failed = results.filter((r) => !r.ok).length;
  lines.push(failed ? `conformance: FAIL (${failed} rule(s): ${results.filter((r) => !r.ok).map((r) => r.rule).join(', ')})` : `conformance: PASS (${results.length} rules)`);
  return { lines, ok: failed === 0 };
}

export function resolveHarnessConfig(env = {}) {
  const r = spawnSync('docker', ['compose', '-f', HARNESS_FILE, 'config', '--format', 'json'], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.error?.code === 'ENOENT') throw new Error('docker not found: install Docker (Docker Desktop or Docker Engine with the Compose plugin) and make sure `docker` is on the PATH.');
  if (r.error) throw new Error(`could not run docker: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`docker compose config failed: ${String(r.stderr ?? '').trim()}`);
  return JSON.parse(r.stdout);
}

export function main(argv = process.argv.slice(2), { log = console.log, err = console.error } = {}) {
  let file;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { log('Usage: node scripts/check-instance-conformance.mjs [--config <resolved compose config .json>]'); return 0; }
    if (argv[i] === '--config' && argv[i + 1]) { file = argv[++i]; continue; }
    err(`Unknown argument: ${argv[i]}`);
    return 2;
  }
  let config;
  try { config = file ? JSON.parse(readFileSync(file, 'utf8')) : resolveHarnessConfig(); } catch (e) { err(e.message); return 1; }
  const { lines, ok } = formatResults(checkConfig(config, { dockerfile: readFileSync(DOCKERFILE, 'utf8') }));
  for (const l of lines) (ok || l.startsWith('PASS') ? log : err)(l);
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(main());
