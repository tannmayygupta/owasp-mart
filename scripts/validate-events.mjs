// Validates the instance event contract (IF-4) in contracts/events/:
// the schema compiles, the schema and the catalogue table list the same event types (and sources), every valid
// example passes and every invalid example fails at its manifest path, the signed envelope examples verify,
// the fake ingest answers as the contract matrix says, and no real-looking flag, key or byte-order mark is present.
// Node, Ajv and node:crypto only. Usage: node scripts/validate-events.mjs [--dir <contracts/events folder>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSecrets } from './validate-contracts.mjs';
import { compileEventSchema, createIngest, schemaErrors, LIMITS } from '../contracts/mocks/fake-ingest/ingest.mjs';
import { signEvent, TEST_KEY, TEST_INSTANCE, SIGNATURE_HEADER, signBody, verifySignature } from '../contracts/mocks/fake-ingest/sign.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIR = path.join(ROOT, 'contracts', 'events');
export const SCHEMA_FILE = 'instance-events.schema.json';
export const CONTRACT_MD = 'app-events.md';
export const SCHEMA_NAME = 'instance-events';
export const POSTED_FILE = 'instance-events.posted.schema.json';
export const POSTED_SOURCES = ['shop', 'import', 'mock', 'bot'];
export const POSTED_EVIDENCE_BODY_CHARS = 2048;
export const HELP = `Validate the instance event contract (IF-4)
Usage: node scripts/validate-events.mjs [--dir <contracts/events folder>] [--write-posted] [--help]
  --write-posted  regenerate instance-events.posted.schema.json from the wire schema, then exit 0
Exit code 0 when every check passes, 1 when any check fails, 2 on a usage error.`;

const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
const FAKE_FLAG = 'VM{AAAAAAAAAAAAAAAAAAAAAAAA}';

// The body a shop, import service, mock service or bot posts to the sidecar: the wire event without instance_id and seq,
// with source limited to the four posters. Types that have no poster source cannot be posted. The 4 KiB body cap is
// stated in the description (a size is not a schema rule). Evidence posted by a poster is capped at 2 KiB.
export function derivePosted(wire) {
  const s = JSON.parse(JSON.stringify(wire));
  s.$id = 'https://vulnmart.invalid/contracts/events/instance-events.posted.schema.json';
  s.title = 'Event body posted to the sidecar (IF-4, contract 0.1, derived)';
  s.description = 'DERIVED from instance-events.schema.json by "node scripts/validate-events.mjs --write-posted"; do not edit by hand. The body a shop, import service, mock service or bot posts to POST /v1/events on the sidecar: the wire event without instance_id and seq (the sidecar adds them), source limited to shop, import, mock or bot, at most 4 KiB. A posted evidence.capture body is at most 2 KiB. ' + wire.description;
  s.required = s.required.filter((k) => k !== 'instance_id' && k !== 'seq');
  delete s.properties.instance_id;
  delete s.properties.seq;
  s.properties.source = { type: 'string', enum: POSTED_SOURCES };
  for (const entry of s.allOf) {
    const t = entry.if && entry.if.properties && entry.if.properties.type && entry.if.properties.type.const;
    if (t === undefined) continue;
    const src = entry.then.properties.source;
    const allowed = (src.const !== undefined ? [src.const] : src.enum).filter((x) => POSTED_SOURCES.includes(x));
    entry.then.properties.source = allowed.length === 0 ? false : allowed.length === 1 ? { const: allowed[0] } : { enum: allowed };
  }
  s.$defs.data_evidence_capture.properties.body.maxLength = POSTED_EVIDENCE_BODY_CHARS;
  return s;
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// Event types and allowed sources as the schema states them.
export function schemaTypes(schema) {
  const list = (schema.properties && schema.properties.type && schema.properties.type.enum) || [];
  const rules = new Map();
  for (const entry of schema.allOf || []) {
    const t = entry.if && entry.if.properties && entry.if.properties.type && entry.if.properties.type.const;
    if (t === undefined) continue;
    const s = entry.then && entry.then.properties && entry.then.properties.source;
    rules.set(t, s ? (s.const !== undefined ? [s.const] : s.enum || []) : []);
  }
  return { list, rules };
}

// Rows of the catalogue table in section 7 of the contract text: { type, sources }.
export function catalogueRows(md) {
  const start = md.search(/^## 7\. /m);
  if (start < 0) return null;
  const rest = md.slice(start + 3);
  const end = rest.search(/^## /m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]*)\|/);
    if (m) rows.push({ type: m[1], sources: m[2].split(',').map((s) => s.trim()).filter(Boolean) });
  }
  return rows;
}

// Replay every row of the I/O matrix against a fresh fake ingest. Returns [{ row, ok, detail }].
export function runMatrix({ schemaFile, events, key = TEST_KEY, instance = TEST_INSTANCE }) {
  const out = [];
  const fresh = () => createIngest({ keys: { [instance]: key }, schemaFile });
  const fresh2 = (limits) => createIngest({ keys: { [instance]: key }, schemaFile, limits });
  const check = (row, ok, detail) => out.push({ row, ok, detail: ok ? 'as expected' : detail });
  const expect = (ing, row, req, status, opts = {}) => {
    const before = ing.stored.length;
    const r = ing.handle(req);
    const paths = ((r.body && r.body.errors) || []).map((e) => e.path);
    let ok = r.status === status;
    let detail = `status ${r.status}, wanted ${status}`;
    if (ok && opts.path !== undefined && !paths.includes(opts.path)) { ok = false; detail = `no error at ${opts.path}, got ${paths.join(', ') || 'none'}`; }
    if (ok && opts.stores !== undefined && ing.stored.length - before !== opts.stores) { ok = false; detail = `stored ${ing.stored.length - before} event(s), wanted ${opts.stores}`; }
    if (ok && opts.code && r.body.code !== opts.code) { ok = false; detail = `code ${r.body.code}, wanted ${opts.code}`; }
    check(row, ok, detail);
    return r;
  };
  const sign = (ev, k = key) => signEvent(k, ev);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const first = events[0] && clone(events[0].event);
  if (!first) { check('valid event', false, 'no valid example to replay'); return out; }

  // Valid event: every example type, 202, stored
  {
    const ing = fresh();
    let bad = 0;
    for (const { name, event } of events) {
      const r = ing.handle(sign(event));
      if (r.status !== 202) { bad++; check(`valid event (${name})`, false, `status ${r.status}: ${JSON.stringify(r.body.errors || r.body.code)}`); }
    }
    check('valid event: every example answers 202 and is stored', bad === 0 && ing.stored.length === events.length, `stored ${ing.stored.length} of ${events.length}`);
    // Duplicate: same (instance_id, seq)
    expect(ing, 'duplicate', sign(first), 200, { stores: 0 });
    const changed = clone(first);
    changed.ts = '2026-03-03T00:00:00Z';
    expect(ing, 'duplicate with a different body', sign(changed), 409, { stores: 0, code: 'EVT-DUPLICATE-MISMATCH' });
  }
  // Store cap
  {
    const ing = fresh2({ maxStored: 2 });
    const [a, b, c] = events.map((e) => e.event);
    expect(ing, 'store cap: first event', sign(a), 202, { stores: 1 });
    expect(ing, 'store cap: second event', sign(b), 202, { stores: 1 });
    expect(ing, 'store cap: full, new event refused', sign(c), 503, { stores: 0, code: 'EVT-STORE-FULL' });
    expect(ing, 'store cap: duplicate still answered when full', sign(a), 200, { stores: 0 });
  }
  // Signature over the raw bytes
  {
    const ing = fresh();
    const withByte = (ev, textKey) => {
      const e = clone(ev);
      e.data[textKey] = 'QQQ';
      const text = JSON.stringify(e);
      const at = text.indexOf('QQQ');
      return Buffer.concat([Buffer.from(text.slice(0, at)), Buffer.from([0xff]), Buffer.from(text.slice(at + 3))]);
    };
    const textKey = ['route_template', 'route', 'path', 'request_ref'].find((k) => typeof first.data[k] === 'string') || Object.keys(first.data).find((k) => typeof first.data[k] === 'string');
    const sigOf = (b) => ({ 'content-type': 'application/json', [SIGNATURE_HEADER.toLowerCase()]: signBody(key, first.instance_id, first.seq, b) });
    const body = withByte(first, textKey);
    // Invalid UTF-8 bytes decode to U+FFFD for parsing; the signature covers the original bytes (app-events.md section 4).
    expect(ing, 'raw bytes: a signed body with an invalid UTF-8 byte is accepted when the schema allows it', { headers: sigOf(body), body }, 202, { stores: 1 });
    const flipped = Buffer.from(body);
    flipped[flipped.indexOf(0xff)] = 0xfe;
    expect(ing, 'raw bytes: one altered byte that decodes the same is a 401', { headers: sigOf(body), body: flipped }, 401, { stores: 0 });
  }
  // Two-field rules
  {
    const ing = fresh();
    const seen = events.find((e) => e.event.type === 'proxy.flag_seen');
    if (seen) {
      const m = clone(seen.event);
      m.challenge_key = m.data.challenge_key === 'C02' ? 'C03' : 'C02';
      expect(ing, 'proxy.flag_seen: envelope and data challenge_key differ', sign(m), 422, { stores: 0, path: '/challenge_key' });
    }
    const shop = events.find((e) => e.event.source === 'shop');
    if (shop) {
      const s = clone(shop.event);
      s.session_kind = 'internal';
      expect(ing, 'session_kind internal from the shop', sign(s), 422, { stores: 0, path: '/session_kind' });
    }
    const lower = clone(first);
    const lk = Object.keys(lower.data).find((k) => typeof lower.data[k] === 'string');
    if (lk) lower.data[lk] = 'x vm{AAAA';
    expect(ing, 'flag value in data: lower-case and encoded forms', sign(lower), 422, { stores: 0, path: lk ? `/data/${lk}` : undefined });
    if (lk) {
      const enc = clone(first);
      enc.data[lk] = 'x VM%7BAAAA';
      expect(ing, 'flag value in data: percent-encoded brace', sign(enc), 422, { stores: 0, path: `/data/${lk}` });
      const name = clone(first);
      name.data['VM{AAAAAAAAAAAAAAAAAAAAAAAA}'] = 'x';
      const r = ing.handle(sign(name));
      check('error paths never echo a flag-like property name', r.status === 422 && !JSON.stringify(r.body).includes('AAAAAAAA') && r.body.errors.some((e) => e.path.includes('<redacted>')), `status ${r.status}: ${JSON.stringify(r.body.errors)}`);
    }
  }
  // Clock that cannot be read
  {
    const ing = fresh();
    const leap = clone(first);
    leap.ts = '2016-12-31T23:59:60Z';
    const r = expect(ing, 'ts that is not a usable time (leap second)', sign(leap), 422, { stores: 0, path: '/ts' });
    check('ts that is not a usable time: says so', /not a usable time/.test(JSON.stringify(r.body)), 'the message must say "ts is not a usable time"');
  }
  // Bad signature
  {
    const ing = fresh();
    expect(ing, 'bad signature: wrong key', sign(first, 'FAKE-OTHER-KEY-NOT-REAL-000000000000'), 401, { stores: 0, code: 'EVT-BAD-SIGNATURE' });
    const s = sign(first);
    const altered = JSON.stringify({ ...first, ts: '2026-02-02T00:00:00Z' });
    expect(ing, 'bad signature: altered body', { headers: s.headers, body: altered }, 401, { stores: 0 });
    expect(ing, 'bad signature: missing header', { headers: { 'content-type': 'application/json' }, body: s.body }, 401, { stores: 0 });
    expect(ing, 'bad signature: wrong format', { headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: 'v2=abc' }, body: s.body }, 401, { stores: 0 });
    check('bad signature: security event noted', ing.security.length >= 3, `security events: ${ing.security.length}`);
  }
  // Wrong instance
  {
    const ing = fresh();
    const other = clone(first);
    other.instance_id = 'i-BBBBBBBBBBBBBBBB';
    expect(ing, 'wrong instance: claims another instance, signed with this instance key', sign(other), 401, { stores: 0 });
    expect(ing, 'wrong instance: unknown instance with its own key', sign(other, 'FAKE-OTHER-KEY-NOT-REAL-000000000000'), 401, { stores: 0 });
  }
  // Malformed
  {
    const ing = fresh();
    const hdr = { 'content-type': 'application/json' };
    expect(ing, 'malformed: not JSON', { headers: hdr, body: 'this is not json' }, 422, { stores: 0 });
    const wrongType = clone(first);
    const dataKey = Object.keys(wrongType.data).find((k) => typeof wrongType.data[k] === 'number');
    if (dataKey) wrongType.data[dataKey] = String(wrongType.data[dataKey]);
    expect(ing, 'malformed: wrong field type', sign(wrongType), 422, { stores: 0, path: dataKey ? `/data/${dataKey}` : undefined });
    const unknown = clone(first);
    unknown.type = 'proxy.unknown';
    expect(ing, 'malformed: unknown type', sign(unknown), 422, { stores: 0, path: '/type' });
    const extra = clone(first);
    extra.event_id = 'evt-1';
    expect(ing, 'malformed: extra field', sign(extra), 422, { stores: 0, path: '/event_id' });
    expect(ing, 'malformed: not an object', { headers: hdr, body: '[1,2]' }, 422, { stores: 0 });
    const future = clone(first);
    future.ts = new Date(Date.now() + 3 * LIMITS.skewMs).toISOString().replace(/\.\d+Z$/, 'Z');
    expect(ing, 'malformed: ts far in the future', sign(future), 422, { stores: 0, path: '/ts' });
  }
  // Oversize
  {
    const ing = fresh();
    const big = clone(first);
    big.data = { ...big.data, pad: 'x'.repeat(LIMITS.maxBodyBytes) };
    expect(ing, 'oversize: wire event above 16 KiB', sign(big), 413, { stores: 0 });
    const ev = events.find((e) => e.event.type === 'evidence.capture');
    if (ev) {
      const cap = clone(ev.event);
      cap.data.body = 'é'.repeat(4097); // 4097 characters, 8194 UTF-8 bytes: above the 8 KiB evidence cap
      expect(ing, 'oversize: evidence.capture body above 8 KiB', sign(cap), 413, { stores: 0 });
    }
  }
  // Flag value in data
  {
    const ing = fresh();
    const f = clone(first);
    const textKey = Object.keys(f.data).find((k) => typeof f.data[k] === 'string');
    if (textKey) f.data[textKey] = `x ${FAKE_FLAG}`;
    const r = expect(ing, 'flag value in data', sign(f), 422, { stores: 0, path: textKey ? `/data/${textKey}` : undefined });
    check('flag value in data: the answer does not repeat the value', !JSON.stringify(r.body).includes('VM{'), 'the problem body echoes the value');
  }
  // Bot events
  {
    const ing = fresh();
    const bot = events.find((e) => e.event.source === 'bot');
    if (bot) {
      const b = clone(bot.event);
      b.session_kind = 'player';
      expect(ing, 'bot events: session_kind must be bot', sign(b), 422, { stores: 0, path: '/session_kind' });
    } else check('bot events', false, 'no valid example with source bot');
  }
  return out;
}

// Returns { ok, errors, lines }.
export function validateEvents({ dir = DEFAULT_DIR } = {}) {
  const errors = [];
  const lines = [];
  const rel = (f) => path.relative(dir, f).split(path.sep).join('/');

  // text files: no byte-order mark, no real-looking secrets
  // (the contract folder, the fake ingest, this script and its test)
  const scanFiles = [
    ...walkFiles(dir).map((f) => [f, rel(f)]),
    ...walkFiles(path.join(ROOT, 'contracts', 'mocks', 'fake-ingest')).map((f) => [f, path.relative(ROOT, f).split(path.sep).join('/')]),
    ...['validate-events.mjs', 'validate-events.test.mjs'].map((n) => [path.join(ROOT, 'scripts', n), `scripts/${n}`]).filter(([f]) => fs.existsSync(f)),
  ];
  for (const [file, name] of scanFiles) {
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) errors.push(`${name}: starts with a byte-order mark`);
    scanSecrets(buf.toString('utf8'), name, errors);
  }

  // schema
  const schemaPath = path.join(dir, SCHEMA_FILE);
  const postedPath = path.join(dir, POSTED_FILE);
  let schema;
  let validate;
  let validatePosted;
  if (!fs.existsSync(schemaPath)) errors.push(`${SCHEMA_FILE}: missing`);
  else {
    try { schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); } catch (e) { errors.push(`${SCHEMA_FILE}: cannot parse JSON (${e.message})`); }
    if (schema) {
      try { validate = compileEventSchema(schemaPath); lines.push(`schema ok: ${SCHEMA_FILE}`); } catch (e) { errors.push(`${SCHEMA_FILE}: schema does not compile (${e.message})`); }
      // the posted-body schema is derived from the wire schema and must not be stale
      if (!fs.existsSync(postedPath)) errors.push(`${POSTED_FILE}: missing (run node scripts/validate-events.mjs --write-posted)`);
      else {
        let onDisk;
        try { onDisk = JSON.parse(fs.readFileSync(postedPath, 'utf8')); } catch (e) { errors.push(`${POSTED_FILE}: cannot parse JSON (${e.message})`); }
        if (onDisk) {
          let derived;
          try { derived = derivePosted(schema); } catch (e) { errors.push(`${POSTED_FILE}: cannot derive from the wire schema (${e.message})`); }
          if (derived && JSON.stringify(derived) !== JSON.stringify(onDisk)) errors.push(`${POSTED_FILE}: stale, it differs from what the wire schema derives (run node scripts/validate-events.mjs --write-posted)`);
          try { validatePosted = compileEventSchema(postedPath); lines.push(`schema ok: ${POSTED_FILE}`); } catch (e) { errors.push(`${POSTED_FILE}: schema does not compile (${e.message})`); }
        }
      }
    }
  }

  // schema internal consistency and catalogue table
  let types = [];
  if (schema) {
    const { list, rules } = schemaTypes(schema);
    types = list;
    if (new Set(list).size !== list.length) errors.push(`${SCHEMA_FILE}: duplicate event type in the type list`);
    for (const t of list) {
      if (!rules.has(t)) errors.push(`${SCHEMA_FILE}: type ${t} has no per-type rule in allOf`);
      else if (!rules.get(t).length) errors.push(`${SCHEMA_FILE}: type ${t} has no allowed source`);
    }
    for (const t of rules.keys()) if (!list.includes(t)) errors.push(`${SCHEMA_FILE}: per-type rule for ${t}, which is not in the type list`);

    const mdFile = path.join(dir, CONTRACT_MD);
    if (!fs.existsSync(mdFile)) errors.push(`${CONTRACT_MD}: missing`);
    else {
      const md = fs.readFileSync(mdFile, 'utf8');
      for (let n = 1; n <= 8; n++) if (!new RegExp(`^## ${n}\\. `, 'm').test(md)) errors.push(`${CONTRACT_MD}: no section "## ${n}. ..."`);
      if (!/^## Open points \(to confirm\)/m.test(md)) errors.push(`${CONTRACT_MD}: no "Open points (to confirm)" section`);
      const rows = catalogueRows(md);
      if (rows === null) errors.push(`${CONTRACT_MD}: no section 7 (event catalogue)`);
      else {
        const seen = new Set();
        for (const r of rows) {
          if (seen.has(r.type)) errors.push(`${CONTRACT_MD}: catalogue lists ${r.type} twice`);
          seen.add(r.type);
          if (!list.includes(r.type)) errors.push(`${CONTRACT_MD}: catalogue lists ${r.type}, which is not in the schema`);
          else if (rules.has(r.type) && [...r.sources].sort().join(',') !== [...rules.get(r.type)].sort().join(',')) {
            errors.push(`${CONTRACT_MD}: catalogue sources for ${r.type} (${r.sources.join(', ')}) differ from the schema (${rules.get(r.type).join(', ')})`);
          }
        }
        for (const t of list) if (!seen.has(t)) errors.push(`${CONTRACT_MD}: schema type ${t} is not in the catalogue table`);
        lines.push(`catalogue table: ${rows.length} types, schema: ${list.length} types`);
      }
    }
  }

  // examples
  const exDir = path.join(dir, 'examples');
  const manifestFile = path.join(exDir, 'invalid', 'manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestFile)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { errors.push(`${rel(manifestFile)}: cannot parse JSON (${e.message})`); }
  } else errors.push('examples/invalid/manifest.json: missing');

  const validEvents = [];
  const seenInvalid = new Set();
  let envelopeCount = 0;
  let invalidCount = 0;
  let postedCount = 0;
  for (const file of walkFiles(exDir)) {
    if (file === manifestFile) continue;
    const r = rel(file);
    const parts = r.split('/'); // examples, valid|invalid|, <group>, <file>
    const kind = parts[1];
    const group = parts[2];
    const okGroup = (kind === 'valid' && [SCHEMA_NAME, 'envelopes', 'posted'].includes(group)) || (kind === 'invalid' && [SCHEMA_NAME, 'posted'].includes(group));
    if (parts.length !== 4 || !okGroup || !file.endsWith('.json')) { errors.push(`${r}: orphan example (expected examples/valid/<${SCHEMA_NAME}|envelopes|posted>/<name>.json or examples/invalid/<${SCHEMA_NAME}|posted>/<name>.json)`); continue; }
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { errors.push(`${r}: cannot parse JSON (${e.message})`); continue; }

    if (group === 'envelopes') {
      envelopeCount++;
      if (data === null || typeof data !== 'object' || typeof data.body !== 'string' || !data.headers || typeof data.headers !== 'object' || data.expect_status !== 202) { errors.push(`${r}: an envelope example needs headers, a body string and expect_status 202`); continue; }
      let ev;
      try { ev = JSON.parse(data.body); } catch { errors.push(`${r}: body is not JSON`); continue; }
      if (ev === null || typeof ev !== 'object') { errors.push(`${r}: body must be a JSON object`); continue; }
      const sigKey = Object.keys(data.headers).find((k) => k.toLowerCase() === 'x-vm-signature');
      const sig = sigKey === undefined ? undefined : data.headers[sigKey];
      if (!verifySignature(TEST_KEY, ev.instance_id, ev.seq, data.body, sig)) errors.push(`${r}: signature does not verify with the test key`);
      else if (validate) {
        const ing = createIngest({ keys: { [TEST_INSTANCE]: TEST_KEY }, schemaFile: schemaPath });
        const res = ing.handle({ headers: data.headers, body: data.body });
        if (res.status !== 202) errors.push(`${r}: the fake ingest answered ${res.status}, wanted 202`);
        else lines.push(`envelope example accepted (202): ${r}`);
      }
      continue;
    }
    const isPosted = group === 'posted';
    const validator = isPosted ? validatePosted : validate;
    if (!validator) continue;
    const found = schemaErrors(validator, data);
    if (kind === 'valid') {
      if (found.length) errors.push(`${r}: valid example fails: ${found.map((x) => `${x.path || '/'} ${x.message}`).join('; ')}`);
      else if (isPosted) {
        postedCount++;
        lines.push(`valid posted body ok: ${r}`);
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 4096) errors.push(`${r}: a posted body is at most 4 KiB`);
        if (parts[3] !== `${data.type}.json`) errors.push(`${r}: file name must be <type>.json (${data.type}.json)`);
      } else {
        lines.push(`valid example ok: ${r}`);
        validEvents.push({ name: parts[3], event: data });
        if (parts[3] !== `${data.type}.json`) errors.push(`${r}: file name must be <type>.json (${data.type}.json)`);
      }
    } else {
      invalidCount++;
      const key = `${group}/${parts[3]}`;
      seenInvalid.add(key);
      const exp = manifest[key];
      if (!exp || typeof exp.path !== 'string') { errors.push(`${r}: no expected error path in examples/invalid/manifest.json`); continue; }
      if (!found.length) errors.push(`${r}: invalid example passes (expected an error at ${exp.path})`);
      else if (!found.some((x) => x.path === exp.path)) errors.push(`${r}: expected an error at ${exp.path}, got ${found.map((x) => x.path || '/').join(', ')}`);
      else lines.push(`invalid example rejected at ${exp.path}: ${r}`);
    }
  }
  for (const key of Object.keys(manifest)) if (!seenInvalid.has(key)) errors.push(`examples/invalid/manifest.json: entry ${key} has no example file`);
  for (const t of types) if (!validEvents.some((v) => v.event.type === t)) errors.push(`examples/valid/${SCHEMA_NAME}: no valid example for type ${t}`);
  const typeCount = new Map();
  for (const v of validEvents) typeCount.set(v.event.type, (typeCount.get(v.event.type) || 0) + 1);
  for (const [t, n] of typeCount) if (n > 1) errors.push(`examples/valid/${SCHEMA_NAME}: ${n} valid examples for type ${t}, expected one`);
  const seqs = validEvents.map((v) => `${v.event.instance_id}#${v.event.seq}`);
  if (new Set(seqs).size !== seqs.length) errors.push(`examples/valid/${SCHEMA_NAME}: two examples share an (instance_id, seq)`);
  if (envelopeCount === 0) errors.push('examples/valid/envelopes: no signed envelope example');
  if (validatePosted && postedCount === 0) errors.push('examples/valid/posted: no valid posted body example');
  if (validatePosted && !Object.keys(manifest).some((k) => k.startsWith('posted/'))) errors.push('examples/invalid/posted: no invalid posted body example');

  // fake ingest, every matrix row
  if (validate) {
    validEvents.sort((a, b) => a.event.seq - b.event.seq);
    const results = runMatrix({ schemaFile: schemaPath, events: validEvents });
    for (const m of results) {
      if (!m.ok) errors.push(`fake ingest, ${m.row}: ${m.detail}`);
    }
    lines.push(`fake ingest: ${results.filter((m) => m.ok).length} of ${results.length} matrix checks as expected`);
  }

  lines.push(`checked 1 schema, ${types.length} event types, ${validEvents.length} valid events, ${envelopeCount} signed envelopes, ${postedCount} valid posted bodies and ${invalidCount} invalid examples`);
  return { ok: errors.length === 0, errors, lines };
}

export function main(argv = process.argv.slice(2), { log = console.log, err = console.error } = {}) {
  let dir = DEFAULT_DIR;
  let writePosted = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { log(HELP); return 0; }
    if (argv[i] === '--dir' && argv[i + 1]) { dir = path.resolve(argv[++i]); continue; }
    if (argv[i] === '--write-posted') { writePosted = true; continue; }
    err(`Unknown argument: ${argv[i]}\n${HELP}`);
    return 2;
  }
  if (writePosted) {
    try {
      const wire = JSON.parse(fs.readFileSync(path.join(dir, SCHEMA_FILE), 'utf8'));
      fs.writeFileSync(path.join(dir, POSTED_FILE), JSON.stringify(derivePosted(wire), null, 2) + '\n');
      log(`wrote ${POSTED_FILE}`);
      return 0;
    } catch (e) {
      err(`cannot write ${POSTED_FILE}: ${e.message}`);
      return 1;
    }
  }
  const res = validateEvents({ dir });
  for (const l of res.lines) log(l);
  for (const e of res.errors) err(`FAIL ${e}`);
  log(res.ok ? 'events: PASS' : `events: FAIL (${res.errors.length} problem(s))`);
  return res.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
