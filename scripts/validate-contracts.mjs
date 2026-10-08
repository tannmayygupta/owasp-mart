// Validates the instance contract (IF-6) in contracts/instance/:
// schemas compile, every example maps to a schema, valid examples pass, invalid examples fail at the
// expected path, the semantic rules JSON Schema cannot express hold, and no real-looking flag or key
// is in the contract or its examples. Node and Ajv only. Usage: node scripts/validate-contracts.mjs [--dir <path>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIR = path.join(ROOT, 'contracts', 'instance');
export const SCHEMAS = ['injection-document', 'flags-file', 'instance-template'];
export const CONTRACT_MD = 'instance-contract.md';
export const HELP = `Validate the instance contract (IF-6)
Usage: node scripts/validate-contracts.mjs [--dir <contracts/instance folder>] [--help]
Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.`;

const REQUIRED_ROLES = ['shop', 'sidecar', 'injector', 'import-service', 'mock-services', 'bot-controller'];
const FAKE_FLAG = /^VM\{([A-Z2-7])\1{23}\}$/;
const FLAG_LIKE = /VM\{[A-Z2-7]{24}\}/g;
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
const esc =(s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

// Path of the thing a validation error is about (JSON Pointer).
export function errorPath(e) {
  let p = e.instancePath || '';
  if (e.params && e.params.missingProperty !== undefined) p += '/' + esc(e.params.missingProperty);
  else if (e.params && e.params.additionalProperty !== undefined) p += '/' + esc(e.params.additionalProperty);
  else if (e.propertyName !== undefined) p += '/' + esc(e.propertyName);
  return p;
}

// ---- semantic rules (what JSON Schema cannot compare) ----
function dupes(arr, key, base, label, out) {
  const seen = new Set();
  arr.forEach((x, i) => {
    const v = key(x);
    if (seen.has(v)) out.push({ path: `${base}/${i}${label}`, message: `duplicate ${v}` });
    seen.add(v);
  });
}

export function semanticInjection(d) {
  const out = [];
  dupes(d.flags, (f) => f.challenge_key, '/flags', '/challenge_key', out);
  const flagValues = new Set(d.flags.map((f) => f.flag));
  d.decoys.forEach((x, i) => {
    if (flagValues.has(x.value)) out.push({ path: `/decoys/${i}/value`, message: 'a decoy must not equal a real flag' });
  });
  dupes(d.decoys, (x) => `${x.challenge_key}#${x.index}`, '/decoys', '/index', out);
  dupes(d.flags, (f) => f.flag, '/flags', '/flag', out);
  dupes(d.decoys, (x) => x.value, '/decoys', '/value', out);
  const keys = new Set(d.flags.map((f) => f.challenge_key));
  d.decoys.forEach((x, i) => {
    if (!keys.has(x.challenge_key)) out.push({ path: `/decoys/${i}/challenge_key`, message: 'a decoy needs a flag for the same challenge key' });
  });
  return out;
}

export function semanticFlagsFile(d) {
  const out = [];
  dupes(d.flags, (f) => f.challenge_key, '/flags', '/challenge_key', out);
  return out;
}

export function semanticTemplate(d) {
  const out = [];
  const add = (p, m) => out.push({ path: p, message: m });
  dupes(d.volumes, (v) => v.name, '/volumes', '/name', out);
  dupes(d.components, (c) => c.name, '/components', '/name', out);
  const volumeNames = new Set(d.volumes.map((v) => v.name));
  const byRole = {};
  // First component of a role wins; a duplicate role is rejected by the schema.
  d.components.forEach((c, i) => { if (!byRole[c.role]) byRole[c.role] = { c, i }; });
  const mountOf = (comp, target) => {
    const j = comp.c.mounts.findIndex((m) => m.target === target);
    return j < 0 ? null : { m: comp.c.mounts[j], j };
  };

  d.components.forEach((c, i) => {
    const base = `/components/${i}`;
    dupes(c.mounts, (m) => m.target, `${base}/mounts`, '/target', out);
    c.mounts.forEach((m, j) => {
      if (m.type === 'volume' && !volumeNames.has(m.source)) add(`${base}/mounts/${j}/source`, `volume ${m.source} is not declared in volumes`);
    });
    if (c.labels['vm.component'] !== c.name) add(`${base}/labels/vm.component`, 'vm.component must equal name');
    if (c.labels['vm.template'] !== d.template_id) add(`${base}/labels/vm.template`, 'vm.template must equal template_id');
    if (c.flag_delivery_env && c.flag_delivery_env.env_name !== `VM_FLAG_${c.flag_delivery_env.challenge_key}`) {
      add(`${base}/flag_delivery_env/env_name`, 'env_name must be VM_FLAG_ plus challenge_key');
    }
  });

  const injector = byRole.injector;
  const shop = byRole.shop;
  const importer = byRole['import-service'];
  const need = (comp, target, what) => {
    if (!comp) return null;
    const found = mountOf(comp, target);
    if (!found) add(`/components/${comp.i}/mounts`, `${what} must mount ${target}`);
    return found;
  };
  // Volumes the injector writes: /run/vm (read by the shop), /run/placement/import (import service),
  // /run/placement/mock (mock-services). Consumers mount the injector's volume read-only and must mount it.
  const WRITTEN = [
    { target: '/run/vm', readers: ['shop'] },
    { target: '/run/placement/import', readers: ['import-service'] },
    { target: '/run/placement/mock', readers: ['mock-services'] },
  ];
  need(injector, '/tmp', 'the injector');
  need(shop, '/tmp', 'the shop');
  need(shop, '/data', 'the shop');
  need(importer, '/tmp', 'the import service');
  const shopImp = need(shop, '/run/import', 'the shop');
  const impImp = need(importer, '/run/import', 'the import service');
  const srcRefs = [];
  for (const w of WRITTEN) {
    const inj = need(injector, w.target, 'the injector');
    if (inj) srcRefs.push({ comp: injector, ...inj });
    for (const role of w.readers) need(byRole[role], w.target, `the ${role}`);
    if (inj && inj.m.type === 'volume' && inj.m.read_only !== false) {
      add(`/components/${injector.i}/mounts/${inj.j}/read_only`, `the injector must mount ${w.target} read-write`);
    }
    d.components.forEach((c, i) => {
      const r = mountOf({ c, i }, w.target);
      if (!r || c.role === 'injector') return;
      if (!w.readers.includes(c.role)) { add(`/components/${i}/mounts/${r.j}/target`, `only the injector and the ${w.readers.join(', ')} mount ${w.target}`); return; }
      if (r.m.type !== 'volume') return;
      if (r.m.read_only !== true) add(`/components/${i}/mounts/${r.j}/read_only`, `only the injector may write ${w.target}; others mount it read-only`);
      if (inj && inj.m.source !== r.m.source) add(`/components/${i}/mounts/${r.j}/source`, `must be the same volume the injector mounts at ${w.target}`);
    });
  }
  if (shopImp && impImp && shopImp.m.source !== impImp.m.source) {
    add(`/components/${importer.i}/mounts/${impImp.j}/source`, 'the shop and the import service must share one /run/import volume');
  }

  // The three injector volumes and the socket volume are four different volumes.
  if (shopImp) srcRefs.push({ comp: shop, ...shopImp });
  const seenSrc = new Set();
  for (const r of srcRefs) {
    if (seenSrc.has(r.m.source)) add(`/components/${r.comp.i}/mounts/${r.j}/source`, `volume ${r.m.source} is already used for another of /run/vm, /run/placement/import, /run/placement/mock, /run/import`);
    seenSrc.add(r.m.source);
  }

  // Every volume is mounted at exactly one target path across the template.
  d.volumes.forEach((v, i) => {
    const targets = new Set(d.components.flatMap((c) => c.mounts.filter((m) => m.type === 'volume' && m.source === v.name).map((m) => m.target)));
    if (targets.size > 1) add(`/volumes/${i}`, `volume ${v.name} is mounted at several targets (${[...targets].join(', ')})`);
  });

  // Readers of the injector's 0400 files run as the injector's user.
  if (injector) {
    d.components.forEach((c, i) => {
      if (['shop', 'import-service', 'mock-services'].includes(c.role) && c.user !== injector.c.user) {
        add(`/components/${i}/user`, 'must equal the injector user (placement files are mode 0400)');
      }
    });
  }

  // Who may mount the socket volume.
  d.components.forEach((c, i) => {
    c.mounts.forEach((m, j) => {
      if (m.target === '/run/import' && !['shop', 'import-service'].includes(c.role)) add(`/components/${i}/mounts/${j}/target`, 'only the shop and the import service mount /run/import');
    });
  });

  // Every declared volume is mounted somewhere.
  const mounted = new Set(d.components.flatMap((c) => c.mounts.filter((m) => m.type === 'volume').map((m) => m.source)));
  d.volumes.forEach((v, i) => { if (!mounted.has(v.name)) add(`/volumes/${i}`, `volume ${v.name} is not mounted by any component`); });

  // Label values shared by the whole instance, and schema version.
  const first = d.components[0];
  d.components.forEach((c, i) => {
    if (c.labels['vm.schema'] !== d.schema_version) add(`/components/${i}/labels/vm.schema`, 'vm.schema must equal schema_version');
    for (const k of ['vm.instance', 'vm.epoch', 'vm.expires', 'vm.host', 'vm.owner']) {
      if (c.labels[k] !== first.labels[k]) add(`/components/${i}/labels/${k}`, `${k} must be identical on every component`);
    }
  });

  // Memory-backed storage fits in the memory limit; healthcheck consistency.
  const volSize = new Map(d.volumes.map((v) => [v.name, v.size_mb]));
  d.components.forEach((c, i) => {
    const total = c.mounts.reduce((s, m) => s + (m.type === 'tmpfs' ? m.size_mb : volSize.get(m.source) || 0), 0);
    if (total > c.memory_mb) add(`/components/${i}/memory_mb`, `memory-backed mounts (${total} MB) exceed memory_mb`);
    const h = c.healthcheck;
    if (h) {
      if (h.port !== undefined && !(c.ports || []).includes(h.port)) add(`/components/${i}/healthcheck/port`, 'healthcheck port must be one of the ports');
      if (h.timeout_s > h.interval_s) add(`/components/${i}/healthcheck/timeout_s`, 'timeout_s must not exceed interval_s');
    }
  });
  return out;
}

const SEMANTIC = {
  'injection-document': semanticInjection,
  'flags-file': semanticFlagsFile,
  'instance-template': semanticTemplate,
};

// ---- helpers ----
function readJson(file, errors, rel) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${rel}: cannot read or parse JSON (${e.message})`);
    return undefined;
  }
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (IGNORED.has(ent.name)) continue;
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function scanSecrets(text, rel, errors) {
  for (const m of text.match(FLAG_LIKE) || []) {
    if (!FAKE_FLAG.test(m)) errors.push(`${rel}: flag-like value ${m} is not an obviously fake flag (one repeated letter)`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) errors.push(`${rel}: contains a private key block`);
  if (/AKIA[0-9A-Z]{16}/.test(text)) errors.push(`${rel}: contains an access-key-like value`);
}

// Returns { ok, errors, lines }.
export function validateContracts({ dir = DEFAULT_DIR } = {}) {
  const errors = [];
  const lines = [];
  const rel = (f) => path.relative(dir, f).split(path.sep).join('/');

  // strictRequired is off: "required" inside if/then/else refers to properties declared in the parent schema.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const validators = {};
  for (const name of SCHEMAS) {
    const file = path.join(dir, `${name}.schema.json`);
    if (!fs.existsSync(file)) { errors.push(`${name}.schema.json: missing`); continue; }
    scanSecrets(fs.readFileSync(file, 'utf8'), `${name}.schema.json`, errors);
    const schema = readJson(file, errors, `${name}.schema.json`);
    if (schema === undefined) continue;
    try {
      validators[name] = ajv.compile(schema);
      lines.push(`schema ok: ${name}.schema.json`);
    } catch (e) {
      errors.push(`${name}.schema.json: schema does not compile (${e.message})`);
    }
  }

  // contract text
  const mdFile = path.join(dir, CONTRACT_MD);
  if (!fs.existsSync(mdFile)) {
    errors.push(`${CONTRACT_MD}: missing`);
  } else {
    const md = fs.readFileSync(mdFile, 'utf8');
    for (let n = 1; n <= 11; n++) {
      if (!new RegExp(`^## ${n}\\. `, 'm').test(md)) errors.push(`${CONTRACT_MD}: no section "## ${n}. ..." (the 11 topics of architecture 07 section 3.2)`);
    }
    if (!/^## Open points \(to confirm\)/m.test(md)) errors.push(`${CONTRACT_MD}: no "Open points (to confirm)" section`);
    scanSecrets(md, CONTRACT_MD, errors);
    lines.push(`contract text checked: ${CONTRACT_MD}`);
  }

  // examples
  const exDir = path.join(dir, 'examples');
  const manifestFile = path.join(exDir, 'invalid', 'manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestFile)) scanSecrets(fs.readFileSync(manifestFile, 'utf8'), rel(manifestFile), errors);
  if (fs.existsSync(manifestFile)) manifest =readJson(manifestFile, errors, rel(manifestFile)) || {};
  else errors.push('examples/invalid/manifest.json: missing');

  const seenInvalid = new Set();
  let validCount = 0;
  let invalidCount = 0;
  for (const file of walkFiles(exDir)) {
    const r = rel(file);
    if (file === manifestFile) continue;
    const parts = r.split('/'); // examples, valid|invalid, <schema>, <file>
    const kind = parts[1];
    const schemaName = parts[2];
    if (parts.length !== 4 || !['valid', 'invalid'].includes(kind) || !file.endsWith('.json') || !SCHEMAS.includes(schemaName)) {
      errors.push(`${r}: orphan example (expected examples/valid|invalid/<${SCHEMAS.join('|')}>/<name>.json)`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    scanSecrets(text, r, errors);
    if (text.charCodeAt(0) === 0xfeff) errors.push(`${r}: starts with a byte-order mark`);
    const data = readJson(file, errors, r);
    if (data === undefined) continue;
    const validate = validators[schemaName];
    if (!validate) continue; // schema problem already reported
    const schemaOk = validate(data);
    const found = schemaOk ? [] : validate.errors.map((e) => ({ path: errorPath(e), message: e.message }));
    let semantic = [];
    if (schemaOk) {
      try { semantic = SEMANTIC[schemaName](data); } catch (e) { errors.push(`${r}: semantic check crashed (${e.message})`); continue; }
    }
    const all = [...found, ...semantic];

    if (kind === 'valid') {
      validCount++;
      if (all.length) errors.push(`${r}: valid example fails: ${all.map((x) => `${x.path || '/'} ${x.message}`).join('; ')}`);
      else lines.push(`valid example ok: ${r}`);
      if (schemaName === 'instance-template' && !all.length) {
        const roles = data.components.map((c) => c.role).sort().join(',');
        if (roles !== [...REQUIRED_ROLES].sort().join(',')) errors.push(`${r}: valid template must hold the six roles exactly once`);
      }
    } else {
      invalidCount++;
      const key = `${schemaName}/${parts[3]}`;
      seenInvalid.add(key);
      const exp = manifest[key];
      if (!exp || typeof exp.path !== 'string') { errors.push(`${r}: no expected error path in examples/invalid/manifest.json`); continue; }
      if (!all.length) errors.push(`${r}: invalid example passes (expected an error at ${exp.path})`);
      else if (!all.some((x) => x.path === exp.path)) {
        errors.push(`${r}: expected an error at ${exp.path}, got ${all.map((x) => x.path || '/').join(', ')}`);
      } else lines.push(`invalid example rejected at ${exp.path}: ${r}`);
    }
  }
  for (const key of Object.keys(manifest)) {
    if (!seenInvalid.has(key)) errors.push(`examples/invalid/manifest.json: entry ${key} has no example file`);
  }
  for (const name of SCHEMAS) {
    const hasValid = walkFiles(path.join(exDir, 'valid', name)).some((f) => f.endsWith('.json'));
    const hasInvalid = Object.keys(manifest).some((k) => k.startsWith(`${name}/`));
    if (!hasValid) errors.push(`${name}: no valid example`);
    if (!hasInvalid) errors.push(`${name}: no invalid example`);
  }

  lines.push(`checked ${SCHEMAS.length} schemas, ${validCount} valid and ${invalidCount} invalid examples`);
  return { ok: errors.length === 0, errors, lines };
}

export function main(argv = process.argv.slice(2), { log = console.log, err = console.error } = {}) {
  let dir = DEFAULT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { log(HELP); return 0; }
    if (argv[i] === '--dir' && argv[i + 1]) { dir = path.resolve(argv[++i]); continue; }
    err(`Unknown argument: ${argv[i]}\n${HELP}`);
    return 2;
  }
  const res = validateContracts({ dir });
  for (const l of res.lines) log(l);
  for (const e of res.errors) err(`FAIL ${e}`);
  log(res.ok ? 'contracts: PASS' : `contracts: FAIL (${res.errors.length} problem(s))`);
  return res.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
