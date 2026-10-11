// Bundles the browser API fragments into one OpenAPI 3.1 file: the platform fragment (IF-1, contracts/api/platform/platform.openapi.yaml)
// and the lab fragment (IF-2, contracts/api/lab/lab.openapi.yaml) become contracts/api/bundle/openapi.json, with a report of what was merged.
// Merge rules (story P-04): paths and operations are united (a repeated path and method or a repeated operationId is an error). A component
// that both fragments define is defined once when the two are equal (ignoring descriptions, titles and examples). When they differ, the
// platform fragment keeps the name (its Problem is the IF-8 body, authoritative) and the lab's one is renamed with the prefix `Lab`, every
// reference to it is rewritten, and the pair is listed in the report so stream L can adopt the shared definition later.
// Browser fragments never hold an internal route: a path under /internal/ is an error. Output is deterministic.
// Usage: node scripts/bundle-openapi.mjs [--platform <file>] [--lab <file>] [--out <folder>] [--check] [--help]
//   (no flag)  write openapi.json and bundle-report.json
//   --check    write nothing; exit 1 when a committed file is missing or differs (used by `pnpm run contracts:bundle:check`)
// Exit code 0 when done or current, 1 when a rule fails or a file is stale, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PLATFORM = path.join(ROOT, 'contracts', 'api', 'platform', 'platform.openapi.yaml');
export const DEFAULT_LAB = path.join(ROOT, 'contracts', 'api', 'lab', 'lab.openapi.yaml');
export const DEFAULT_OUT = path.join(ROOT, 'contracts', 'api', 'bundle');
export const BUNDLE_FILE = 'openapi.json';
export const REPORT_FILE = 'bundle-report.json';
export const HELP = `Bundle the browser API fragments (IF-1 and IF-2)
Usage: node scripts/bundle-openapi.mjs [--platform <file>] [--lab <file>] [--out <folder>] [--check] [--help]
  --check   write nothing; exit 1 when the committed bundle or report is missing or differs
Exit code 0 when done or current, 1 when a rule fails or a file is stale, 2 on a usage error.`;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const COSMETIC = new Set(['description', 'summary', 'title', 'example', 'examples']);
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const INTERNAL = /(^|\/)internal(\/|$)/i;
const REF = /^#\/components\/([A-Za-z]+)\/(.+)$/;
const SECTIONS = ['schemas', 'responses', 'parameters', 'examples', 'requestBodies', 'headers', 'securitySchemes', 'links', 'callbacks', 'pathItems'];

export class BundleError extends Error {}

const clone = (x) => JSON.parse(JSON.stringify(x));

// Rewrites `#/components/<section>/<Name>` references (and discriminator mappings) through a rename map { 'schemas/Problem': 'LabProblem' }.
export function rewriteRefs(node, rename) {
  const fix = (s) => {
    const m = REF.exec(s);
    if (!m) return s;
    const to = rename[`${m[1]}/${m[2]}`];
    return to ? `#/components/${m[1]}/${to}` : s;
  };
  const walk = (n, inMapping = false) => {
    if (Array.isArray(n)) return n.map((x) => walk(x));
    if (n && typeof n === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(n)) {
        if (k === '$ref' && typeof v === 'string') out[k] = fix(v);
        else if (k === 'mapping' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([mk, mv]) => [mk, typeof mv === 'string' ? fix(mv) : mv]));
        else out[k] = walk(v);
      }
      return out;
    }
    return n;
  };
  return walk(node);
}

// Deep equality that ignores the cosmetic keys (descriptions, titles, examples).
// `named` is true for a map of member names (the value of `properties`): a member may itself be called `title` or `description` and is compared.
export function sameIgnoringCosmetics(a, b, named = false) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameIgnoringCosmetics(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => named || !COSMETIC.has(k)).sort();
    const kb = Object.keys(b).filter((k) => named || !COSMETIC.has(k)).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameIgnoringCosmetics(a[k], b[k], !named && NAME_MAPS.has(k)));
  }
  return a === b;
}

function operations(doc) {
  const out = [];
  for (const [p, item] of Object.entries(doc.paths || {})) for (const m of METHODS) if (item[m]) out.push({ path: p, method: m, op: item[m] });
  return out;
}

// Every `#/components/...` reference of a document must exist in it.
export function unresolvedRefs(doc) {
  const missing = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (k === '$ref' && typeof v === 'string') {
          const m = REF.exec(v);
          if (m && !(doc.components?.[m[1]] && Object.prototype.hasOwnProperty.call(doc.components[m[1]], m[2]))) missing.add(v);
        } else walk(v);
      }
    }
  };
  walk(doc);
  return [...missing].sort();
}

// base: the authoritative fragment (platform). other: the fragment whose differing components are renamed (lab).
export function bundleFragments(base, other, { baseName = 'platform', otherName = 'lab' } = {}) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const prefix = otherName[0].toUpperCase() + otherName.slice(1);
  for (const [n, d] of [[baseName, base], [otherName, other]]) {
    if (!d || d.openapi !== '3.1.0') fail(`${n}: openapi must be 3.1.0`);
    for (const p of Object.keys(d?.paths || {})) {
      if (INTERNAL.test(p)) fail(`${n}: ${p} is an internal route; internal routes are never in a browser fragment (handoffs H-16 and H-17)`);
      if (!p.startsWith('/api/v1/')) fail(`${n}: ${p} is not under /api/v1/`);
    }
  }
  // The bundle takes the top level of the platform fragment. A lab operation without its own `security` would inherit it, so the two must agree.
  for (const key of ['security', 'servers']) {
    if (JSON.stringify(base[key] ?? null) !== JSON.stringify(other[key] ?? null)) fail(`the top-level ${key} of the two fragments differ; the bundle would change the other fragment's behaviour`);
  }
  if (problems.length) return { problems };

  // 1. Which components of `other` must be renamed: fixpoint, because renaming one changes what refers to it.
  const rename = {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of SECTIONS) {
      const a = base.components?.[section] || {};
      const b = other.components?.[section] || {};
      for (const name of Object.keys(b)) {
        if (!(name in a) || rename[`${section}/${name}`]) continue;
        if (!sameIgnoringCosmetics(a[name], rewriteRefs(b[name], rename))) { rename[`${section}/${name}`] = `${prefix}${name}`; changed = true; }
      }
    }
  }
  for (const key of Object.keys(rename)) {
    const [section, name] = key.split('/');
    if (section === 'securitySchemes') fail(`the security scheme ${name} differs between the fragments; requirements name a scheme, not a $ref, so it cannot be renamed. Align the two definitions`);
    const target = rename[key];
    if (target in (base.components?.[section] || {}) || target in (other.components?.[section] || {})) fail(`${section}/${name} would be renamed to ${target}, which already exists in a fragment`);
  }
  if (problems.length) return { problems };
  const o = rewriteRefs(other, rename);

  // 2. Merge components.
  const components = {};
  const shared = [];
  const renamed = [];
  for (const section of SECTIONS) {
    const a = base.components?.[section] || {};
    const b = other.components?.[section] || {};
    if (!Object.keys(a).length && !Object.keys(b).length) continue;
    components[section] = { ...clone(a) };
    for (const [name, def] of Object.entries(b)) {
      const key = `${section}/${name}`;
      if (rename[key]) {
        components[section][rename[key]] = clone(rewriteRefs(def, rename));
        renamed.push({ section, name, renamed_to: rename[key], reason: 'differs from the platform definition of the same name' });
      } else if (name in a) shared.push({ section, name });
      else components[section][name] = clone(def);
    }
  }

  // 3. Paths, operations, tags.
  const paths = {};
  const ids = new Map();
  const addOps = (doc, fragment) => {
    for (const [p, item] of Object.entries(doc.paths || {})) {
      if (paths[p]) {
        for (const m of METHODS) if (item[m] && paths[p][m]) fail(`${p} ${m.toUpperCase()} is defined in both fragments`);
        for (const k of Object.keys(item)) if (!METHODS.includes(k) && k in paths[p] && JSON.stringify(item[k]) !== JSON.stringify(paths[p][k])) fail(`${p}: the ${k} of the two fragments differs`);
      } else paths[p] = {};
      for (const [k, v] of Object.entries(item)) {
        if (METHODS.includes(k)) {
          const op = { ...clone(v), 'x-fragment': fragment };
          if (op.operationId) {
            if (ids.has(op.operationId)) fail(`operationId ${op.operationId} is used by ${ids.get(op.operationId)} and by ${fragment} ${p}`);
            ids.set(op.operationId, `${fragment} ${p}`);
          } else fail(`${fragment} ${k.toUpperCase()} ${p} has no operationId`);
          paths[p][k] = op;
        } else if (!(k in paths[p])) paths[p][k] = clone(v);
      }
    }
  };
  addOps(base, baseName);
  addOps(o, otherName);

  const tags = [...(base.tags || []), ...(o.tags || []).filter((t) => !(base.tags || []).some((x) => x.name === t.name))];
  const bundle = {
    openapi: '3.1.0',
    jsonSchemaDialect: base.jsonSchemaDialect || other.jsonSchemaDialect,
    info: {
      title: 'VulnMart browser API: the platform fragment (IF-1) and the lab fragment (IF-2), bundled',
      version: `${baseName} ${base.info.version} + ${otherName} ${other.info.version}`,
      description: 'Generated by scripts/bundle-openapi.mjs; do not edit. The sources are contracts/api/platform/platform.openapi.yaml and contracts/api/lab/lab.openapi.yaml. Every operation carries x-fragment (platform or lab). Lab components that differ from a platform component of the same name are prefixed Lab (see bundle-report.json).',
    },
    servers: base.servers,
    security: base.security,
    tags,
    paths,
    components,
  };
  for (const ref of unresolvedRefs(bundle)) fail(`unresolved reference ${ref}`);
  const report = {
    fragments: [baseName, otherName].map((n, i) => {
      const d = i === 0 ? base : other;
      return { name: n, version: d.info.version, operations: operations(d).length };
    }),
    operations: ids.size,
    shared_components: shared.sort((x, y) => `${x.section}/${x.name}`.localeCompare(`${y.section}/${y.name}`)),
    renamed_components: renamed.sort((x, y) => `${x.section}/${x.name}`.localeCompare(`${y.section}/${y.name}`)),
  };
  return problems.length ? { problems } : { bundle, report, problems: [] };
}

const loadYaml = (f) => yaml.load(fs.readFileSync(f, 'utf8'));
const toJson = (o) => JSON.stringify(o, null, 2) + '\n';
const normalise = (s) => s.replace(/\r\n/g, '\n');

export function run({ platform, lab, out, check }, { log = console.log, err = console.error } = {}) {
  let base;
  let other;
  try { base = loadYaml(platform); } catch (e) { err(`cannot read ${platform}: ${e.message}`); return 1; }
  try { other = loadYaml(lab); } catch (e) { err(`cannot read ${lab}: ${e.message}`); return 1; }
  const r = bundleFragments(base, other);
  if (r.problems.length) {
    err(`FAIL: ${r.problems.length} problem(s)`);
    for (const p of r.problems) err(`  - ${p}`);
    return 1;
  }
  const files = [[path.join(out, BUNDLE_FILE), toJson(r.bundle)], [path.join(out, REPORT_FILE), toJson(r.report)]];
  let stale = 0;
  for (const [file, content] of files) {
    const rel = path.relative(ROOT, file);
    const current = fs.existsSync(file) ? normalise(fs.readFileSync(file, 'utf8')) : null;
    if (check) {
      if (current !== content) { err(`STALE: ${rel} ${current === null ? 'is missing' : 'does not match the fragments'}. Run: pnpm run contracts:bundle`); stale++; }
      continue;
    }
    if (current === content) { log(`unchanged ${rel}`); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    log(`wrote ${rel}`);
  }
  if (check) {
    if (stale) return 1;
    log(`OK: the bundle is current (${r.report.operations} operations, ${r.report.shared_components.length} shared and ${r.report.renamed_components.length} renamed components).`);
  } else {
    log(`${r.report.operations} operations; ${r.report.shared_components.length} shared and ${r.report.renamed_components.length} renamed components.`);
  }
  return 0;
}

export function main(argv = process.argv.slice(2), io = {}) {
  const opts = { platform: DEFAULT_PLATFORM, lab: DEFAULT_LAB, out: DEFAULT_OUT, check: false };
  const err = io.err || console.error;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { (io.log || console.log)(HELP); return 0; }
    if (a === '--check') { opts.check = true; continue; }
    if (['--platform', '--lab', '--out'].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { err(`${a} needs a value.`); return 2; }
      opts[a.slice(2)] = path.resolve(argv[++i]);
      continue;
    }
    err(`Unknown argument "${a}". Run with --help.`);
    return 2;
  }
  return run(opts, io);
}

if (import.meta.main) process.exit(main());
