// Pinned, checksum-verified oasdiff (OpenAPI breaking-change finder) for the contract rules (story L-07).
// The version and the sha256 of every release archive and binary are pinned in tools/oasdiff.json. The binary is fetched by this script into
// tools/.bin/ (git-ignored, never committed). An archive or binary whose checksum differs from the pin is never run; a wrong download writes nothing.
// Usage: node scripts/oasdiff.mjs install         fetch and verify the binary, print its path
//        node scripts/oasdiff.mjs <base.yaml> <revision.yaml>   run `oasdiff breaking` with the fixed flags
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(ROOT, 'tools', 'oasdiff.json');
export const BIN_ROOT = path.join(ROOT, 'tools', '.bin');
// Fixed flags (decision of 2026-10-10): no external $ref is followed, and a level ERR change makes the run fail. The severity file raises the checks that the
// CHANGELOG rule names (removed property, removed enum value, removal) to err; ids come from `oasdiff checks changelog`.
export const SEVERITY_FILE = path.join(ROOT, 'tools', 'oasdiff-severity.txt');
// oasdiff's own level ERR in its JSON output.
export const ERR_LEVEL = 3;
export const FIXED_FLAGS = ['--allow-external-refs=false', '--fail-on', 'ERR', '--severity-levels', SEVERITY_FILE];

export class OasdiffError extends Error {}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const loadConfig = (file = CONFIG_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

// Compare dotted versions numerically: negative, zero or positive.
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const binaryDir = (config, key, binRoot = BIN_ROOT) => path.join(binRoot, `oasdiff-${config.version}-${key}`);

export const FETCH_TIMEOUT_MS = 60_000;
export const FETCH_RETRIES = 2;

// One attempt per try, each with a 60 s limit; two retries after the first failure.
export async function defaultDownload(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, retries = FETCH_RETRIES } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
    }
  }
  throw new OasdiffError(`download of ${url} failed after ${retries + 1} tries: ${last?.message ?? last}`);
}

// Returns the path of a verified binary. Missing: download, verify, extract, verify. Present with the wrong checksum: error (never run).
export async function ensureOasdiff({ config = loadConfig(), binRoot = BIN_ROOT, download = defaultDownload, key = platformKey() } = {}) {
  if (compareVersions(config.version, config.minimumVersion) <= 0) {
    throw new OasdiffError(`pinned oasdiff ${config.version} is not above the advisory floor ${config.minimumVersion}`);
  }
  const plat = config.platforms[key];
  if (!plat) throw new OasdiffError(`no pinned oasdiff build for platform ${key}`);
  const dir = binaryDir(config, key, binRoot);
  const bin = path.join(dir, plat.binary);
  if (fs.existsSync(bin)) {
    const actual = sha256(fs.readFileSync(bin));
    if (actual !== plat.binarySha256) {
      throw new OasdiffError(`${bin} has sha256 ${actual}, expected ${plat.binarySha256}; refusing to run it (delete the folder ${dir} to fetch it again)`);
    }
    return bin;
  }
  const archive = await download(config.downloadBase + plat.asset);
  const got = sha256(archive);
  if (got !== plat.archiveSha256) throw new OasdiffError(`${plat.asset} has sha256 ${got}, expected the pinned ${plat.archiveSha256}; nothing was installed`);
  const sums = (await download(config.downloadBase + config.checksumsFile)).toString('utf8');
  const line = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1] === plat.asset);
  if (!line || line[0] !== plat.archiveSha256) {
    throw new OasdiffError(`the release ${config.checksumsFile} does not list ${plat.asset} with the pinned sha256; nothing was installed`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-oasdiff-'));
  try {
    const tgz = path.join(tmp, plat.asset);
    fs.writeFileSync(tgz, archive);
    // Relative names and cwd, because GNU tar reads "C:" in a path as a remote host.
    const x = spawnSync('tar', ['-xzf', plat.asset], { cwd: tmp, encoding: 'utf8' });
    if (x.status !== 0) throw new OasdiffError(`tar could not extract ${plat.asset}: ${x.stderr || x.error}`);
    const extracted = path.join(tmp, plat.binary);
    if (!fs.existsSync(extracted)) throw new OasdiffError(`${plat.asset} does not contain ${plat.binary}`);
    const bsum = sha256(fs.readFileSync(extracted));
    if (bsum !== plat.binarySha256) throw new OasdiffError(`extracted ${plat.binary} has sha256 ${bsum}, expected ${plat.binarySha256}; nothing was installed`);
    // Atomic install: write under a temporary name, then rename, so a parallel process never reads a partial binary.
    fs.mkdirSync(dir, { recursive: true });
    const part = `${bin}.part-${process.pid}-${Date.now()}`;
    fs.copyFileSync(extracted, part);
    fs.chmodSync(part, 0o755);
    try {
      fs.renameSync(part, bin);
    } catch (e) {
      // another process installed it first (Windows refuses to rename over a binary in use): accept it only if its checksum is right
      fs.rmSync(part, { force: true });
      if (!fs.existsSync(bin) || sha256(fs.readFileSync(bin)) !== plat.binarySha256) throw new OasdiffError(`could not install ${bin}: ${e.message}`);
    }
    return bin;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Turns the result of an `oasdiff breaking` process into { breaking: [{id, text, path, operation}], raw }. Exit 1 with a parsable list is a breaking
// result; any other non-zero exit (an unreadable spec, a crash) and any other shape of output is an OasdiffError, never a pass.
export function interpretResult(r) {
  if (r.error) throw new OasdiffError(`could not run oasdiff: ${r.error.message}`);
  if (r.status === 0) return { breaking: [], raw: r.stdout };
  if (r.status === 1) {
    let list;
    try {
      list = JSON.parse(r.stdout);
    } catch {
      throw new OasdiffError(`oasdiff exited 1 but its output is not JSON: ${String(r.stdout).slice(0, 200)}`);
    }
    if (!Array.isArray(list)) throw new OasdiffError('oasdiff exited 1 but its JSON output is not a list of changes');
    const breaking = list.filter((c) => c && c.level >= ERR_LEVEL).map((c) => ({ id: c.id, text: c.text, path: c.path, operation: c.operation }));
    if (!breaking.length) throw new OasdiffError('oasdiff exited 1 without an ERR level change');
    return { breaking, raw: r.stdout };
  }
  throw new OasdiffError(`oasdiff exited ${r.status}: ${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
}

export function runOasdiff(bin, baseFile, headFile) {
  return interpretResult(spawnSync(bin, ['breaking', baseFile, headFile, ...FIXED_FLAGS, '-f', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }));
}
async function main(argv) {
  try {
    const bin = await ensureOasdiff();
    if (argv[0] === 'install') {
      process.stdout.write(`${bin}\n`);
      return 0;
    }
    if (argv.length !== 2) {
      process.stderr.write('usage: node scripts/oasdiff.mjs install | <base> <revision>\n');
      return 2;
    }
    const res = runOasdiff(bin, argv[0], argv[1]);
    for (const c of res.breaking) process.stdout.write(`BREAKING ${c.operation ?? ''} ${c.path ?? ''}: [${c.id}] ${c.text}\n`);
    return res.breaking.length ? 1 : 0;
  } catch (e) {
    if (!(e instanceof OasdiffError)) throw e;
    process.stderr.write(`oasdiff: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
