// Shared helpers for the two host checks (verify-hosts.mjs, private-link-check.mjs): reading the local address file,
// redacting addresses from evidence, and the real network and ssh runners (tests inject fakes instead).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROVIDER_HOSTS_FILES = {
  aws: path.join(ROOT, 'infra', 'terraform', 'aws', 'hosts.local.json'),
  oci: path.join(ROOT, 'infra', 'terraform', 'oci', 'hosts.local.json'),
};

/**
 * Which address file to read: --hosts wins; else --provider (aws or oci); else the only hosts.local.json that exists.
 * With none or with both present the choice is not guessed: the person must say which.
 */
export function resolveHostsFile(opts = {}, exists = existsSync) {
  if (opts.hosts) return opts.hosts;
  if (opts.provider) {
    if (!PROVIDER_HOSTS_FILES[opts.provider]) throw new Error(`--provider must be one of: ${Object.keys(PROVIDER_HOSTS_FILES).join(', ')}`);
    return PROVIDER_HOSTS_FILES[opts.provider];
  }
  const found = Object.values(PROVIDER_HOSTS_FILES).filter((f) => exists(f));
  if (found.length === 1) return found[0];
  throw new Error(found.length === 0 ? 'no address file found: run terraform output -json > hosts.local.json in the Terraform folder of your provider, then pass --provider aws|oci or --hosts <file>' : 'two address files exist (aws and oci): say which one with --provider aws|oci or --hosts <file>');
}
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV4_ANY = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)/g;

/** Reads `terraform output -json` (or a flat object) into { 'vm-p': {pub, priv}, 'vm-i': {pub, priv} }. */
export function parseHosts(json) {
  const val = (k) => {
    const v = json?.[k];
    const x = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (typeof x !== 'string' || !IPV4.test(x)) throw new Error(`address file: "${k}" is missing or not an IPv4 address`);
    return x;
  };
  return {
    'vm-p': { pub: val('vm_p_public_ip'), priv: val('vm_p_private_ip') },
    'vm-i': { pub: val('vm_i_public_ip'), priv: val('vm_i_private_ip') },
  };
}

export function loadHosts(file) {
  if (!file) throw new Error('no address file given: use resolveHostsFile');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`cannot read the address file ${file}: after "terraform apply" run: terraform output -json > hosts.local.json (in the Terraform folder of your provider, infra/terraform/aws or infra/terraform/oci)`);
  }
  return parseHosts(JSON.parse(text.replace(/^﻿/, '')));
}

const IPV6_ANY = /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{0,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces known addresses with labels (longest address first, whole addresses only), then any other IPv4 or IPv6 address. */
export function redact(text, hosts) {
  let out = String(text);
  const labelled = [];
  for (const [vm, a] of Object.entries(hosts)) labelled.push([a.pub, `<${vm}-public>`], [a.priv, `<${vm}-private>`]);
  labelled.sort((x, y) => y[0].length - x[0].length);
  for (const [addr, label] of labelled) out = out.replace(new RegExp(`(?<![\\w.:])${escapeRe(addr)}(?![\\w:]|\\.\\d)`, 'gi'), label);
  return out.replace(IPV4_ANY, '<ip>').replace(IPV6_ANY, '<ip6>');
}
/** Real TCP probe: 'open' | 'refused' | 'timeout' | 'error:<code>' */
export function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs, () => done('timeout'));
    s.once('connect', () => done('open'));
    s.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code}`));
  });
}

/** Real ssh runner. Returns { code, stdout, stderr }. Never prints keys; the identity is only a path. */
export function sshRun({ host, user = 'ubuntu', identity, command, input, options = [], timeoutMs = 60000 }) {
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', ...options];
  if (identity) args.push('-i', identity, '-o', 'IdentitiesOnly=yes');
  args.push(`${user}@${host}`);
  if (command !== undefined) args.push(command);
  return new Promise((resolve) => {
    const p = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 255, stdout, stderr: `${stderr}${e.message}` });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 255, stdout, stderr });
    });
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

export function parseKeyValues(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([a-z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function printChecks(checks, log = console.log) {
  for (const c of checks) log(`${c.ok ? (c.warn ? 'WARN' : 'PASS') : 'FAIL'} ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  log(failed ? `RESULT FAIL (${failed} of ${checks.length} checks failed)` : `RESULT PASS (${checks.length} checks)`);
  return failed === 0;
}

/**
 * Minimal option parser. `--name value`, `--name=value` (split at the first `=` only) and flags.
 * Names listed in `values` need a value: `--evidence` alone (or followed by another option) is an error.
 */
export function parseArgs(argv, { values = [] } = {}) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (eq !== -1) {
      opts[name] = a.slice(eq + 1);
    } else if (values.includes(name)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`usage: --${name} needs a value`);
      opts[name] = argv[++i];
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      opts[name] = argv[++i];
    } else {
      opts[name] = true;
    }
    if (values.includes(name) && (opts[name] === '' || opts[name] === true)) throw new Error(`usage: --${name} needs a value`);
  }
  return opts;
}