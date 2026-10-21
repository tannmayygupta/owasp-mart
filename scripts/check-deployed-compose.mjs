#!/usr/bin/env node
// Lint of the DEPLOYED platform stack (infra/deploy/platform.compose.yaml, Caddyfile.platform) against the facts the wiring audit found missing (2026-10-21 audit sections 2, 3, 7):
// the retention scheduler is on, mail is not the catcher, the orchestrator address is set (so no fake host), the lab keeps its state in Postgres, the sequenced mode is on, Valkey is
// durable and password protected and cannot silently drop queues, the dashboards are served and routed, and the memory limits fit the 1.9 GB host.
//   node scripts/check-deployed-compose.mjs        exit 0 when every check passes, 1 with the failures printed
// Pure reading of files: it starts nothing. It runs in CI (job `scripts`, through scripts/check-deployed-compose.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_RAM_MB = 1900; // vm-p
const MB = { m: 1, g: 1024 };

const toMb = (v) => {
  const m = /^(\d+)([mg])$/i.exec(String(v ?? ''));
  return m ? Number(m[1]) * MB[m[2].toLowerCase()] : null;
};
/** `${NAME:-default}` -> default; `${NAME}` or a plain value -> the text itself. */
export const defaultOf = (v) => {
  const m = /^\$\{[A-Z0-9_]+:-([^}]*)\}$/.exec(String(v));
  return m ? m[1] : String(v);
};

export function loadCompose(root = ROOT) {
  return yaml.load(fs.readFileSync(path.join(root, 'infra', 'deploy', 'platform.compose.yaml'), 'utf8'));
}

/** The page folders of apps/web/app (every route segment that holds a page). */
export function webPageFolders(root = ROOT) {
  const dir = path.join(root, 'apps', 'web', 'app');
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function checkDeployedCompose(root = ROOT) {
  const failures = [];
  const ok = (cond, msg) => { if (!cond) failures.push(msg); };
  const c = loadCompose(root);
  const svc = c.services ?? {};
  const api = svc.api?.environment ?? {};
  const worker = svc.worker?.environment ?? {};

  ok(api.VULNMART_ENV === 'production', 'api: VULNMART_ENV is production');
  // the scheduler (F-02)
  ok(String(api.VULNMART_SCHEDULER_ENABLED) === 'true', 'api: VULNMART_SCHEDULER_ENABLED is "true" (the retention scheduler runs in the deployed stack)');
  // mail (F-03): the default provider is Brevo, the catcher is only reachable through the explicit override and its profile
  for (const [name, env] of [['api', api], ['worker', worker]]) {
    ok(defaultOf(env.VULNMART_EMAIL_PROVIDER) === 'brevo', `${name}: the default mail provider is brevo, not smtp (the Mailpit catcher)`);
    ok(defaultOf(env.VULNMART_ALLOW_MAIL_CATCHER) === 'false', `${name}: VULNMART_ALLOW_MAIL_CATCHER defaults to false`);
    ok(env.VULNMART_BREVO_API_KEY_FILE === '/run/secrets/brevo_api_key', `${name}: the Brevo key is read from /run/secrets/brevo_api_key`);
  }
  for (const name of ['api', 'worker']) {
    ok((svc[name]?.volumes ?? []).some((v) => String(v).startsWith('./secrets/brevo_api_key:/run/secrets/brevo_api_key')), `${name}: the Brevo key file is mounted`);
  }
  ok(Array.isArray(svc.mailpit?.profiles) && svc.mailpit.profiles.includes('mail-catcher'), 'mailpit is behind the mail-catcher profile (off in a normal deploy)');
  ok(!Object.values(svc).some((s) => (s.depends_on && 'mailpit' in s.depends_on)), 'no service waits for the mail catcher');
  // the lab (wiring audit section 3: silent fakes)
  const orch = String(api.VULNMART_ORCH_URL ?? '');
  ok(/^https:\/\/\$\{VULNMART_VMI_PRIVATE_IP\}:\d+$/.test(orch), `api: VULNMART_ORCH_URL is the https address of vm-i (the real orchestrator), got ${orch || 'nothing'}`);
  ok(!/fake|localhost|127\.0\.0\.1|example/i.test(JSON.stringify(api)), 'api: no fake or placeholder host in the environment');
  for (const k of ['VULNMART_ORCH_KEY_FILE', 'VULNMART_ORCH_CA_FILE', 'VULNMART_ORCH_CERT_FILE', 'VULNMART_ORCH_CERT_KEY_FILE', 'VULNMART_ORCH_REPORT_KEY_FILE']) ok(Boolean(api[k]), `api: ${k} is set`);
  ok(String(api.VULNMART_LAB_RUNTIME) === '1', 'api: VULNMART_LAB_RUNTIME is "1"');
  ok(api.VULNMART_LAB_STORE === 'postgres', 'api: VULNMART_LAB_STORE is postgres (attempts and keys survive a restart)');
  ok(String(api.VULNMART_LAB_SEQUENCE) === '1', 'api: VULNMART_LAB_SEQUENCE is "1" (the sequenced learner mode)');
  ok(String(api.VULNMART_KEYSTORE_DSN ?? '').includes('vm_keystore'), 'api: the key service database is set');
  // Valkey (durable, password, no silent loss of queued work)
  const vk = svc.valkey ?? {};
  const cmd = Array.isArray(vk.command) ? vk.command.join(' ') : String(vk.command ?? '');
  ok(/--appendonly yes/.test(cmd), 'valkey: append-only persistence is on');
  ok(/--requirepass/.test(cmd), 'valkey: a password is required');
  ok(/--maxmemory-policy (volatile-lru|volatile-ttl|noeviction)/.test(cmd) && !/allkeys-/.test(cmd), 'valkey: the eviction policy never drops keys without a TTL (volatile-* or noeviction), not allkeys-*');
  ok((vk.volumes ?? []).some((v) => String(v).startsWith('valkey-data:/data')) && 'valkey-data' in (c.volumes ?? {}), 'valkey: /data is the named volume valkey-data');
  ok(String(api.VULNMART_VALKEY_URL ?? '').includes('://:${VULNMART_VALKEY_PASSWORD'), 'api: the Valkey address carries the password');
  // the dashboards
  const web = svc.web ?? {};
  ok(web.image === 'vulnmart-web:prod', 'web: the dashboards image vulnmart-web:prod is a service');
  ok(web.read_only === true, 'web: read-only root filesystem');
  ok((toMb(web.mem_limit) ?? 1e9) <= 256, 'web: memory limit is at most 256m');
  ok(svc.caddy?.depends_on && 'web' in svc.caddy.depends_on, 'caddy waits for web');
  ok((svc.caddy?.ports ?? []).includes('80:80') && (svc.caddy?.ports ?? []).includes('443:443'), 'caddy publishes 80 (redirect) and 443');
  // every hardened service keeps the hardening
  for (const [name, s] of Object.entries(svc)) {
    ok(s.read_only === true && Array.isArray(s.cap_drop) && s.cap_drop.includes('ALL'), `${name}: read_only and cap_drop ALL`);
  }
  // memory: what runs in a normal deploy (the one-shot migrate and the profile services are not resident) fits the host with room for the OS
  const resident = Object.entries(svc).filter(([n, s]) => n !== 'migrate' && !s.profiles).reduce((t, [, s]) => t + (toMb(s.mem_limit) ?? 0), 0);
  ok(resident <= HOST_RAM_MB - 200, `memory: the limits of the resident services add up to ${resident} MB, more than ${HOST_RAM_MB - 200} MB (vm-p has ${HOST_RAM_MB} MB)`);

  // Caddy: every page folder of apps/web is routed to web, and the console does not shadow it
  const caddy = fs.readFileSync(path.join(root, 'infra', 'deploy', 'Caddyfile.platform'), 'utf8');
  const matcher = /@dashboards path ([^\n]+)/.exec(caddy);
  ok(Boolean(matcher), 'Caddyfile.platform: a @dashboards matcher routes the dashboards');
  const routed = new Set((matcher?.[1] ?? '').trim().split(/\s+/));
  for (const folder of webPageFolders(root)) ok(routed.has(`/${folder}`) && routed.has(`/${folder}/*`), `Caddyfile.platform: /${folder} and /${folder}/* are routed to the dashboards`);
  ok(routed.has('/_next/*'), 'Caddyfile.platform: /_next/* (the dashboards\' scripts) is routed to the dashboards');
  ok(!routed.has('/api/*') && !routed.has('/healthz'), 'Caddyfile.platform: the API paths are not in the dashboards matcher');
  ok(/redir https:\/\/\{\$VULNMART_PLATFORM_HOST\}\{uri\}/.test(caddy), 'Caddyfile.platform: port 80 redirects to https on the configured host name');
  // the CSP of the console is strict and is NOT set for the dashboards (Next sets its own nonce CSP; two policies would intersect and break the pages)
  const dash = /handle @dashboards \{([\s\S]*?)\n\t\}/.exec(caddy)?.[1] ?? '';
  ok(dash.includes('reverse_proxy web:3000') && !/Content-Security-Policy/i.test(dash), 'Caddyfile.platform: the dashboards handler proxies to web:3000 and sets no CSP of its own');
  ok(/handle \{[\s\S]*Content-Security-Policy "default-src 'self'[^"]*style-src 'self'[^"]*"[\s\S]*root \* \/srv\/console/.test(caddy), 'Caddyfile.platform: the console keeps the strict CSP (style-src \'self\')');
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkDeployedCompose();
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(`${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('PASS deployed compose and Caddyfile: scheduler on, real mail by default, real orchestrator, postgres lab store, sequenced mode, durable Valkey, dashboards routed');
}
