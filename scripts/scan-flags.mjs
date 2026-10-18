// Leak scan for flags (story 6.1, FR-FLG-08). Looks for the flag pattern `VM{` + 24 Base32 characters in
//   - image layers (`docker save`, layers are read as tar entries, gzip layers and nested tars are opened),
//   - container logs and `docker inspect` output of every container of an instance,
//   - a plain file (for example the orchestrator log) and a tar file you pass in.
// It also finds the forms the event contract refuses: percent-encoded brace (`VM%7B`), the full-width brace, lower case.
// The documented fake pattern (VM{AAAAAAAAAAAAAAAAAAAAAAAA}, one letter 24 times) is the only thing it ignores.
// It prints where something was found (source, layer entry) and a count, never the matched text.
//
// Usage:
//   node scripts/scan-flags.mjs --instance <instance id>   scan the images, logs and inspect output of that instance's containers
//   node scripts/scan-flags.mjs --image <ref>              scan the layers of one image
//   node scripts/scan-flags.mjs --file <path>              scan a text file (repeatable)
//   node scripts/scan-flags.mjs --tar <path>               scan a tar (for example a saved image)
//   add --output <path> to also write the report to a file
// Exit 0 clean, 1 something found, 2 usage or a scan step failed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// brace forms: `{`, `%7B`, full-width U+FF5B (EF BD 9B read as latin1); closing forms likewise.
const FLAG_ANY = /[Vv][Mm](?:\{|%7[Bb]|\xef\xbd\x9b)[A-Za-z2-7]{24}(?:\}|%7[Dd]|\xef\xbd\x9d)?/g;
const FAKE_FLAG = /^VM\{([A-Z2-7])\1{23}\}$/;
const CHUNK = 16 * 1024 * 1024;
const OVERLAP = 80;
const MAX_DEPTH = 4;

/** Count flag-pattern matches in a Buffer (the documented fake is ignored). Never returns the text. */
export function countFlagPatterns(buf) {
  let count = 0;
  for (let start = 0; start < buf.length; start += CHUNK) {
    const end = Math.min(buf.length, start + CHUNK + OVERLAP);
    const last = end === buf.length;
    const text = buf.toString('latin1', start, end);
    FLAG_ANY.lastIndex = 0;
    let m;
    while ((m = FLAG_ANY.exec(text)) !== null) {
      if (!last && m.index >= CHUNK) break; // counted again by the next chunk
      if (!FAKE_FLAG.test(m[0])) count += 1;
    }
    if (last) break;
  }
  return count;
}

function octal(buf, off, len) {
  if (buf[off] & 0x80) { // base-256 size
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = buf.toString('ascii', off, off + len).replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function looksLikeTar(buf) {
  return buf.length >= 512 && buf.toString('latin1', 257, 262) === 'ustar';
}

function* tarEntries(buf) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = h.toString('latin1', 345, 500).replace(/\0.*$/s, '');
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const start = off + 512;
    yield { name: prefix ? `${prefix}/${name}` : name, type, data: buf.subarray(start, start + size) };
    off = start + Math.ceil(size / 512) * 512;
  }
}

/** Scan a Buffer: open gzip and tar layers, count matches in everything else. Returns [{ where, count }]. */
export function scanBuffer(buf, where, depth = 0) {
  const hits = [];
  if (depth < MAX_DEPTH && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return scanBuffer(gunzipSync(buf), where, depth + 1);
    } catch {
      // not a valid gzip stream: scan the raw bytes below
    }
  }
  if (depth < MAX_DEPTH && looksLikeTar(buf)) {
    for (const e of tarEntries(buf)) {
      const nameCount = countFlagPatterns(Buffer.from(e.name, 'utf8'));
      if (nameCount) hits.push({ where: `${where} :: name of an entry`, count: nameCount });
      if (e.type !== '0' || e.data.length === 0) continue;
      hits.push(...scanBuffer(e.data, `${where} :: ${e.name}`, depth + 1));
    }
    return hits;
  }
  const count = countFlagPatterns(buf);
  if (count) hits.push({ where, count });
  return hits;
}

function docker(args, opts = {}) {
  return execFileSync('docker', args, { maxBuffer: 1024 * 1024 * 512, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

export function dockerAvailable() {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

function scanImage(ref, label, report) {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-flags-'));
  try {
    const file = path.join(dir, 'image.tar');
    docker(['save', '-o', file, ref]);
    const buf = readFileSync(file);
    report.scanned.push(`image ${label}`);
    report.hits.push(...scanBuffer(buf, `image ${label}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scanInstance(instanceId, report) {
  const ids = docker(['ps', '-a', '-q', '--filter', `label=vm.instance=${instanceId}`]).toString('utf8').split(/\s+/).filter(Boolean);
  if (ids.length === 0) throw new Error(`no container with label vm.instance=${instanceId}`);
  const images = new Set();
  ids.forEach((id, i) => {
    const label = `container ${i + 1} of ${ids.length}`;
    const inspect = docker(['inspect', id]);
    report.scanned.push(`inspect ${label}`);
    report.hits.push(...scanBuffer(inspect, `docker inspect ${label}`));
    images.add(JSON.parse(inspect.toString('utf8'))[0].Image);
    // `docker logs` replays the container's stdout on stdout and its stderr on stderr: scan both
    const r = spawnSync('docker', ['logs', id], { maxBuffer: 1024 * 1024 * 512 });
    // an unreadable log must not count as a clean one (review finding D5)
    if (r.error || r.status !== 0) throw new Error(`docker logs failed for ${label}: ${r.error ? r.error.message : `exit ${r.status}`}`);
    const logs = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]);
    report.scanned.push(`logs ${label}`);
    report.hits.push(...scanBuffer(logs, `docker logs ${label}`));
  });
  [...images].forEach((img, i) => scanImage(img, `${i + 1} of ${images.size}`, report));
}

export function newReport() {
  return { scanned: [], hits: [] };
}

export function render(report) {
  const lines = [];
  lines.push(`scan-flags: ${report.scanned.length} source(s) scanned`);
  for (const s of report.scanned) lines.push(`  scanned: ${s}`);
  const total = report.hits.reduce((n, h) => n + h.count, 0);
  if (report.hits.length === 0) lines.push('scan-flags: CLEAN, no flag pattern found');
  else {
    lines.push(`scan-flags: FOUND ${total} flag pattern(s) in ${report.hits.length} place(s) (values are never printed)`);
    for (const h of report.hits) lines.push(`  found: ${h.where} (${h.count})`);
  }
  return lines.join('\n') + '\n';
}

export function runScan(argv) {
  const report = newReport();
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    const need = () => {
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--instance') scanInstance(need(), report);
    else if (a === '--image') { const ref = need(); scanImage(ref, ref.replace(/[^A-Za-z0-9_.:-]/g, '_'), report); }
    else if (a === '--file') { const p = need(); report.scanned.push(`file ${path.basename(p)}`); report.hits.push(...scanBuffer(readFileSync(p), `file ${path.basename(p)}`)); }
    else if (a === '--tar') { const p = need(); report.scanned.push(`tar ${path.basename(p)}`); report.hits.push(...scanBuffer(readFileSync(p), `tar ${path.basename(p)}`)); }
    else if (a === '--output') output = need();
    else throw new Error(`unknown argument ${a}`);
  }
  const text = render(report);
  if (output) writeFileSync(output, text, 'utf8');
  return { report, text };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, text } = runScan(process.argv.slice(2));
    process.stdout.write(report.scanned.length === 0 ? 'scan-flags: nothing to scan (pass --instance, --image, --file or --tar)\n' : text);
    process.exit(report.hits.length === 0 ? 0 : 1);
  } catch (err) {
    process.stderr.write(`scan-flags: ${err.message}\n`);
    process.exit(2);
  }
}
