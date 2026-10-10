// JSON Schema breaking-change diff for the contract rules (story L-07). oasdiff does not read bare JSON Schemas, so this is our own.
// The rule is the one in contracts/CHANGELOG.md: rename or removal of a property, retyping, optional to required and a removed enum value are
// breaking; so is anything that makes the accepted set smaller (a new or tightened pattern, bound or format, additionalProperties true to false,
// a removed anyOf/oneOf branch, an added allOf branch). An unknown keyword that differs is breaking too (safe side). Annotations are ignored.
// Limitation: oneOf and anyOf branches are matched only by deep equality (else compared with the branch at the same position); a branch that moved to another position and was also edited is reported as removed or changed.
// Usage: node scripts/schema-diff.mjs <base.schema.json> <revision.schema.json>      exit 1 and a list of "path: change" lines when breaking
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ANNOTATIONS = new Set(['title', 'description', '$comment', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly', '$schema']);
const MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const SCHEMA_KEYS = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'then', 'else', 'additionalItems']);
const IF_REASON = 'if condition changed: flagged breaking conservatively, because it decides which then/else branch applies and this diff does not evaluate that';
const LOWER_BOUNDS = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties', 'minContains']); // raising one is breaking
const UPPER_BOUNDS = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties', 'maxContains']); // lowering one is breaking
const ONE_OF = new Set(['oneOf', 'anyOf']);

const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const typeSet = (t) => (t === undefined ? null : [].concat(t).sort());
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isEmptySchema = (v) => isObj(v) && Object.keys(v).length === 0;

// Returns a list of { path, change } for every breaking difference between two schemas (JSON values).
export function diffSchemas(base, head) {
  const out = [];
  const add = (p, change) => out.push({ path: p || '#', change });
  walk(base, head, '#');
  return out;

  function walk(b, h, p) {
    if (isEmptySchema(b)) b = true; // {} accepts everything, exactly like true
    if (isEmptySchema(h)) h = true;
    if (typeof b === 'boolean' || typeof h === 'boolean') {
      // true accepts everything, false nothing
      if (b !== h) {
        if (b === true) add(p, 'schema true changed to a narrower schema or false');
        else if (b === false) return; // false became something: loosened
        else if (h === false) add(p, 'schema changed to false');
      }
      return;
    }
    if (!isObj(b) || !isObj(h)) {
      if (!same(b, h)) add(p, 'schema changed shape');
      return;
    }
    for (const k of Object.keys(b)) if (!(k in h)) removed(k, b[k], p);
    for (const k of Object.keys(h)) if (!(k in b)) added(k, h[k], p, h);
    for (const k of Object.keys(b)) if (k in h) both(k, b[k], h[k], p, b, h);
  }

  function removed(k, bv, p) {
    if (ANNOTATIONS.has(k)) return;
    if (k === 'required' || LOWER_BOUNDS.has(k) || UPPER_BOUNDS.has(k) || k === 'pattern' || k === 'format') return; // loosened
    if (k === 'additionalProperties' || k === 'unevaluatedProperties' || k === 'unevaluatedItems' || k === 'additionalItems') return; // loosened (a missing one allows more)
    if (k === 'properties' || k === 'patternProperties') { for (const name of Object.keys(bv)) add(`${p}/${k}/${name}`, `${k === 'properties' ? 'property' : 'pattern property'} removed`); return; }
    if (k === '$defs' || k === 'definitions') { for (const name of Object.keys(bv)) add(`${p}/${k}/${name}`, 'definition removed'); return; }
    if (k === 'type') return; // no type constraint: loosened
    if (k === 'enum' || k === 'const') return; // no enum: loosened
    if (ONE_OF.has(k)) { add(`${p}/${k}`, `${k} removed`); return; }
    if (k === 'if') { add(`${p}/if`, IF_REASON); return; }
    if (k === 'allOf' || k === 'then' || k === 'else' || k === 'not' || k === 'contains' || k === 'propertyNames' || k === 'items' || k === 'prefixItems' || k === 'dependentRequired' || k === 'dependentSchemas' || k === 'uniqueItems') return; // removing a constraint loosens
    add(`${p}/${k}`, `keyword ${k} removed`);
  }

  function added(k, hv, p) {
    if (ANNOTATIONS.has(k)) return;
    if (k === 'required') { for (const name of hv) add(`${p}/required`, `property ${name} is now required`); return; }
    if (k === 'properties' || k === 'patternProperties' || k === '$defs' || k === 'definitions') return; // new optional members
    if (k === 'if') { add(`${p}/if`, IF_REASON); return; }
    if (k === 'uniqueItems') { if (hv === true) add(`${p}/uniqueItems`, 'uniqueItems true added (tightened)'); return; }
    if (k === 'type') { add(`${p}/type`, `type constraint added (${JSON.stringify(hv)})`); return; }
    if (k === 'enum') { add(`${p}/enum`, 'enum constraint added'); return; }
    if (LOWER_BOUNDS.has(k) || UPPER_BOUNDS.has(k)) { add(`${p}/${k}`, `${k} ${JSON.stringify(hv)} added`); return; }
    if (k === 'additionalProperties' || k === 'unevaluatedProperties' || k === 'unevaluatedItems' || k === 'additionalItems') {
      if (hv === false || isObj(hv)) add(`${p}/${k}`, `${k} restricted (was open)`);
      return;
    }
    if (ONE_OF.has(k)) { add(`${p}/${k}`, `${k} added (narrows the accepted values)`); return; }
    add(`${p}/${k}`, `keyword ${k} added`);
  }

  function both(k, bv, hv, p, b, h) {
    if (ANNOTATIONS.has(k)) return;
    const here = `${p}/${k}`;
    if (MAPS.has(k)) {
      for (const name of Object.keys(bv)) {
        if (!(name in hv)) add(`${here}/${name}`, k === 'properties' ? 'property removed (or renamed)' : k === 'patternProperties' ? 'pattern property removed' : 'definition removed');
        else walk(bv[name], hv[name], `${here}/${name}`);
      }
      return;
    }
    if (k === 'required') {
      for (const name of hv) if (!bv.includes(name)) add(here, `property ${name} changed from optional to required`);
      return;
    }
    if (k === 'type') {
      const bt = typeSet(bv);
      const ht = typeSet(hv);
      if (!same(bt, ht)) {
        const dropped = bt.filter((t) => !ht.includes(t));
        add(here, dropped.length ? `type changed from ${JSON.stringify(bv)} to ${JSON.stringify(hv)}` : `type changed from ${JSON.stringify(bv)} to ${JSON.stringify(hv)} (widened; counted as retyping)`);
      }
      return;
    }
    if (k === 'enum') {
      for (const v of bv) if (!hv.some((x) => same(x, v))) add(here, `enum value ${JSON.stringify(v)} removed`);
      return;
    }
    if (k === 'if') { if (!same(bv, hv)) add(here, IF_REASON); return; }
    if (k === 'uniqueItems') { if (hv === true && bv !== true) add(here, 'uniqueItems false to true (tightened)'); return; }
    if (k === 'const') { if (!same(bv, hv)) add(here, `const changed from ${JSON.stringify(bv)} to ${JSON.stringify(hv)}`); return; }
    if (k === 'pattern' || k === 'format') { if (bv !== hv) add(here, `${k} changed from ${JSON.stringify(bv)} to ${JSON.stringify(hv)} (treated as tightened)`); return; }
    if (LOWER_BOUNDS.has(k)) { if (hv > bv) add(here, `${k} raised from ${bv} to ${hv}`); return; }
    if (UPPER_BOUNDS.has(k)) { if (hv < bv) add(here, `${k} lowered from ${bv} to ${hv}`); return; }
    if (k === 'additionalProperties' || k === 'unevaluatedProperties' || k === 'unevaluatedItems' || k === 'additionalItems') {
      if (bv === true && hv !== true) add(here, `${k} changed from true to ${JSON.stringify(hv)}`);
      else if (!same(bv, hv)) walk(bv, hv, here);
      return;
    }
    if (SCHEMA_KEYS.has(k) || k === 'not') {
      if (k === 'not') { if (!same(bv, hv)) add(here, 'not changed'); } else walk(bv, hv, here);
      return;
    }
    if (ONE_OF.has(k)) {
      bv.forEach((s, i) => {
        // match by position first; a branch that no longer exists anywhere is a removal
        const match = hv[i] !== undefined && same(s, hv[i]) ? hv[i] : hv.find((x) => same(x, s));
        if (match === undefined) {
          if (hv[i] === undefined) add(`${here}/${i}`, `${k} branch removed`);
          else walk(s, hv[i], `${here}/${i}`);
        }
      });
      return;
    }
    if (k === 'allOf') {
      if (hv.length > bv.length) add(here, 'allOf branch added (narrows the accepted values)');
      bv.forEach((s, i) => { if (hv[i] !== undefined) walk(s, hv[i], `${here}/${i}`); else add(`${here}/${i}`, 'allOf branch removed (reordered?)'); });
      return;
    }
    if (k === 'prefixItems') {
      bv.forEach((s, i) => { if (hv[i] === undefined) add(`${here}/${i}`, 'tuple item removed'); else walk(s, hv[i], `${here}/${i}`); });
      if (hv.length > bv.length) add(here, 'tuple item added');
      return;
    }
    if (!same(bv, hv)) add(here, `${k} changed from ${JSON.stringify(bv)} to ${JSON.stringify(hv)}`);
  }
}

export function diffFiles(baseFile, headFile) {
  return diffSchemas(JSON.parse(fs.readFileSync(baseFile, 'utf8')), JSON.parse(fs.readFileSync(headFile, 'utf8')));
}

function main(argv) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node scripts/schema-diff.mjs <base.schema.json> <revision.schema.json>\n');
    return 2;
  }
  const changes = diffFiles(argv[0], argv[1]);
  for (const c of changes) process.stdout.write(`BREAKING ${c.path}: ${c.change}\n`);
  if (!changes.length) process.stdout.write('no breaking schema change\n');
  return changes.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
