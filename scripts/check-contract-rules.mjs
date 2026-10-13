// Contract rules for pull requests (story L-07, architecture 07 section 5 and rules 3, 4, 8, 9). One rule set, read from contracts/registry.json.
// Usage: node scripts/check-contract-rules.mjs [--base <ref>] [--root <dir>]
//        CI (D-46, docs/adr/0026): node base/scripts/check-contract-rules.mjs --root head --base <base sha> --tools base/tools/oasdiff.json
//        --root is the pull request head (only read as data), the script and the pin file come from the base commit; the registry rules come from the
//        base; a change to the registry, the checker, the diff scripts, the oasdiff pins or the workflows needs the changelog line "registry change: <reason>".
//        --trusted: trusted mode with the pins of this checkout; --bootstrap: the first pull request, the checker of the head ran (printed as a NOTICE);
//        --untrusted-only: only the checks that run head code (table owners, Alembic, bundle), for the job contract-rules-untrusted.
//        Approvals (story L-09, docs/adr/0029): --reviews <file> (the pull request reviews written by `gh api`, never fetched here), --require-reviews
//        (a missing or invalid file is a FAIL instead of NOT-APPLICABLE), --pr-author <login>. The rule starts with the first tag contracts-v*.
//        Without these options nothing changes: local runs compare the working tree with origin/main as before.
// Base of the per-pull-request rules (changelog, mock, breaking declared): --base, else origin/$GITHUB_BASE_REF, else origin/main, always the merge
// base with HEAD. When a tag contracts-v* exists, the breaking comparison is also made against the latest tag (a raised version is then required).
// The head side is the working tree. If git cannot give the base, the changed files or the merge base, the run FAILs (fetch the full history);
// it never falls back to a guess.
// Every check ends in PASS, FAIL or NOT-APPLICABLE with its reason. NOT-APPLICABLE means exactly one thing: the input path of a shared check
// (table-owners file, Alembic folder, COMPAT.md, bundle command and file) does not exist, neither in the head nor in the base ref; an input that
// existed in the base and is gone in the head FAILs. A contract that declares `noMock` passes its mock rule with the stated reason.
// NOT-APPLICABLE results are counted in the summary (also written to $GITHUB_STEP_SUMMARY). Exit 1 when any check FAILs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diffSchemas } from './schema-diff.mjs';
import { ensureOasdiff, runOasdiff, loadConfig, OasdiffError } from './oasdiff.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const NA = 'NOT-APPLICABLE';
const TAG_GLOB = 'contracts-v*';
const WAIVER = /\bno mock change:\s*\S/;
// D-46 (d): the one marker of a declared breaking change: a bullet line that starts with `BREAKING:` (case-sensitive) followed by text. A
// line such as "no BREAKING changes", "not BREAKING" or "BREAKING: none" does not declare anything.
export const BREAKING_MARKER = /^\s*(?:[-*+]|\d+\.)\s+BREAKING:\s*(\S.*)$/;
const NEGATED = /^(?:none|no|nothing|n\/a|not applicable|not breaking)\.?\s*$/i;
export const isBreakingMarker = (line) => {
  const m = BREAKING_MARKER.exec(line);
  return !!m && !NEGATED.test(m[1].trim());
};
// D-46 (b): a pull request that changes the rules engine itself must say so in a new line of contracts/CHANGELOG.md. A human reads the reason.
export const REGISTRY_CHANGE_LINE = /^\s*(?:[-*+]|\d+\.)\s+registry change:\s*\S/;
// Files that make up the rules engine; in trusted mode a change to any of them is reported (FAIL without the declaration above).
// contracts/COMPAT.md is guarded too (ADR 0029): it holds the list of approvers, so an edit of it must carry a `registry change:` line.
export const GUARDED_FILES = ['contracts/registry.json', 'contracts/COMPAT.md','scripts/check-contract-rules.mjs', 'scripts/schema-diff.mjs', 'scripts/oasdiff.mjs', 'tools/oasdiff.json'];
export const GUARDED_PREFIXES = ['.github/workflows/'];
export const isGuarded = (p) => GUARDED_FILES.includes(p) || GUARDED_PREFIXES.some((x) => p.startsWith(x));
// Marker that CI greps in the base copy of this file to know that it understands --trusted (see .github/workflows/ci.yml): trusted-base-checker-v1
const NO_MOCK = /^no mock by design:\s*\S/;
const TIMEOUT_MS = { git: 120_000, python: 300_000, bundle: 300_000 };
const MOCK_IGNORED = (p) => /\.md$/i.test(p) || /\.(test|spec)\.[cm]?[jt]s$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p) || /(^|\/)__tests__\//.test(p);

const lf = (s) => s.replace(/\r\n/g, '\n');

export function spawn(label, cmd, args, opts, timeout) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout, ...opts });
  if (r.error?.code === 'ETIMEDOUT') throw new Error(`${label} did not finish within ${timeout / 1000} s and was stopped`);
  return r;
}

// Runs git. A failure throws unless allowFail (then null); a timeout always throws.
function git(root, args, { allowFail = false } = {}) {
  const r = spawn(`git ${args[0]}`, 'git', ['-C', root, ...args], {}, TIMEOUT_MS.git);
  if (r.error || (r.status !== 0 && !allowFail)) throw new Error(`git ${args.join(' ')} failed: ${r.error?.message ?? r.stderr.trim()}`);
  return r.status === 0 ? r.stdout : null;
}

// Versions --------------------------------------------------------------------------------------------------------------------------------
const parseVersion = (s) => (s.match(/^v?(\d+)\.(\d+)\.(\d+)$/) ?? []).slice(1).map(Number);
const cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export function latestTag(root) {
  const out = git(root, ['tag', '--list', TAG_GLOB]);
  const tags = out.split('\n').map((t) => t.trim()).filter((t) => /^contracts-v\d+\.\d+\.\d+$/.test(t));
  tags.sort((a, b) => cmpVersion(parseVersion(a.slice(10)), parseVersion(b.slice(10))));
  return tags.at(-1) ?? null;
}

const FULL_HISTORY = 'fetch the full history (actions/checkout with fetch-depth: 0)';

// The base of the per-pull-request rules: never the tip of the ref when the merge base cannot be found.
export function resolveBase(root, { base, env = process.env } = {}) {
  const ref = base ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'origin/main');
  const sha = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (!sha?.trim()) return { ref, error: `base ref ${ref} does not exist here; ${FULL_HISTORY}` };
  const mb = git(root, ['merge-base', ref, 'HEAD'], { allowFail: true });
  if (!mb?.trim()) return { ref, error: `no merge base between ${ref} and HEAD (shallow or unrelated history); ${FULL_HISTORY}` };
  return { ref, sha: mb.trim(), tip: sha.trim() };
}

// The latest contracts-v tag, or null when none exists.
export function resolveTag(root) {
  const tag = latestTag(root);
  if (!tag) return null;
  const sha = git(root, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { allowFail: true });
  if (!sha?.trim()) return { tag, error: `tag ${tag} does not point at a commit here; ${FULL_HISTORY}` };
  return { tag, sha: sha.trim(), version: parseVersion(tag.slice(10)) };
}

// Files -----------------------------------------------------------------------------------------------------------------------------------
// Text of a file at a commit, or null when the file does not exist there. Any other git failure throws.
const baseText = (root, sha, p) => {
  const listed = git(root, ['ls-tree', '-z', '--name-only', sha, '--', p]);
  if (!listed.split('\0').includes(p)) return null;
  return lf(git(root, ['show', `${sha}:${p}`]));
};
// Does a file or folder exist at a commit?
const existsAt = (root, sha, p) => git(root, ['ls-tree', '-z', '--name-only', sha, '--', p]).split('\0').some((x) => x === p || x.startsWith(`${p}/`));
const headText = (root, p) => {
  const f = path.join(root, p);
  return fs.existsSync(f) && fs.statSync(f).isFile() ? lf(fs.readFileSync(f, 'utf8')) : null;
};

// Paths whose content differs between the merge base and the working tree (CRLF and LF count as equal), with the kind of change. A rename shows
// as the old path deleted and the new path added (--no-renames).
export function changedFiles(root, sha) {
  const names = new Set(git(root, ['diff', '--name-only', '--no-renames', '-z', sha]).split('\0').filter(Boolean));
  for (const n of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) names.add(n);
  const out = new Map();
  for (const p of names) {
    const b = baseText(root, sha, p);
    const h = headText(root, p);
    if (b === h) continue;
    out.set(p, b === null ? 'added' : h === null ? 'deleted' : 'modified');
  }
  return out;
}

// Changelog -------------------------------------------------------------------------------------------------------------------------------
export function changelogSection(text, heading) {
  if (text === null) return null;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { end = i; break; }
  return lines.slice(start + 1, end);
}
export function addedLines(baseLines, headLines) {
  const count = new Map();
  for (const l of baseLines ?? []) count.set(l, (count.get(l) ?? 0) + 1);
  const out = [];
  for (const l of headLines ?? []) {
    if (count.get(l) > 0) count.set(l, count.get(l) - 1);
    else if (l.trim()) out.push(l);
  }
  return out;
}
// Entries of a section: each starts at a line `### ...` and runs to the next one.
export function sectionEntries(lines) {
  const out = [];
  for (const l of lines ?? []) {
    if (l.startsWith('### ')) out.push({ heading: l.trim(), lines: [l] });
    else out.at(-1)?.lines.push(l);
  }
  return out;
}
// Entries of the head section whose heading is `### X.Y.Z ...` and is not a heading of the base section.
export function newEntries(baseLines, headLines) {
  const old = new Set(sectionEntries(baseLines).map((e) => e.heading));
  return sectionEntries(headLines).filter((e) => /^### \d+\.\d+\.\d+\b/.test(e.heading) && !old.has(e.heading));
}
export function sectionVersions(lines) {
  return (lines ?? []).map((l) => l.match(/^### (\d+\.\d+\.\d+)\b/)?.[1]).filter(Boolean).map(parseVersion);
}
const maxVersion = (vs) => vs.reduce((m, v) => (m && cmpVersion(m, v) >= 0 ? m : v), null);
// Is `head` a proper raise over `base`? From 1.0.0 on a major step, before it a minor (or major) step.
const raised = (base, head) => !base || (!!head && (base[0] >= 1 ? head[0] > base[0] : head[0] > base[0] || head[1] > base[1]));
const raiseText = (base) => (base[0] >= 1 ? 'by a major step' : 'by a minor step before v1.0.0');

// Registry --------------------------------------------------------------------------------------------------------------------------------
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
export function validateRegistry(reg) {
  const p = [];
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return ['the registry is not a JSON object'];
  for (const k of ['containers', 'reserved', 'generated']) if (!isStrArr(reg[k])) p.push(`"${k}" must be an array of strings`);
  if (typeof reg.mockRoot !== 'string') p.push('"mockRoot" must be a string');
  if (!Array.isArray(reg.contracts) || !reg.contracts.length) { p.push('"contracts" must be a non-empty array'); return p; }
  reg.contracts.forEach((c, i) => {
    const at = `contracts[${i}]${typeof c?.id === 'string' ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object') { p.push(`${at} is not an object`); return; }
    if (typeof c.id !== 'string' || !c.id) p.push(`${at}: "id" must be a non-empty string`);
    if (typeof c.changelog !== 'string' || !c.changelog) p.push(`${at}: "changelog" must be a non-empty string`);
    if (!isStrArr(c.folders) || !c.folders.length) p.push(`${at}: "folders" must be a non-empty array of strings`);
    for (const k of ['schemas', 'openapi', 'mocks', 'conformance']) if (!isStrArr(c[k])) p.push(`${at}: "${k}" must be an array of strings`);
    if (isStrArr(c.mocks) && !c.mocks.length && !(typeof c.noMock === 'string' && NO_MOCK.test(c.noMock))) p.push(`${at}: no mock paths, so "noMock" must read "no mock by design: <reason>"`);
  });
  return p;
}
function parseRegistry(text) {
  if (text === null) return { error: 'contracts/registry.json does not exist' };
  let reg;
  try {
    reg = JSON.parse(text);
  } catch (e) {
    return { error: `contracts/registry.json is not valid JSON: ${e.message}` };
  }
  const problems = validateRegistry(reg);
  return problems.length ? { error: `contracts/registry.json has a wrong shape: ${problems.join('; ')}` } : { registry: reg };
}
export const loadRegistry = (root) => parseRegistry(headText(root, 'contracts/registry.json'));
// The registry as it was at a commit, or null (absent or unreadable: the head registry then stands alone).
const registryAt = (root, sha) => {
  const r = parseRegistry(baseText(root, sha, 'contracts/registry.json'));
  return r.registry ?? null;
};

const covers = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const inFolder = (p, folders) => folders.some((f) => p === f || p.startsWith(`${f}/`));

function checkRegistry(root, reg) {
  const problems = [];
  const ids = new Set();
  for (const c of reg.contracts) {
    if (ids.has(c.id)) problems.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    for (const key of ['folders', 'schemas', 'openapi', 'mocks', 'conformance']) {
      for (const p of c[key]) if (!fs.existsSync(path.join(root, p))) problems.push(`${c.id}: ${key} path ${p} does not exist`);
    }
  }
  const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'contracts']).split('\0').filter((f) => f && fs.existsSync(path.join(root, f)));
  // every schema or OpenAPI file of a contract must be listed, or its changes escape the breaking check
  for (const c of reg.contracts) {
    for (const f of files) {
      if (!inFolder(f, c.folders)) continue;
      if (/\.schema\.json$/.test(f) && !c.schemas.includes(f)) problems.push(`${c.id}: ${f} is a JSON Schema file that is not listed in "schemas"`);
      if (/\.openapi\.ya?ml$/.test(f) && !c.openapi.includes(f)) problems.push(`${c.id}: ${f} is an OpenAPI file that is not listed in "openapi"`);
    }
  }
  const units = new Map();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length < 3) continue; // a file directly in contracts/ (CHANGELOG.md, COMPAT.md, registry.json)
    const unit = reg.containers.includes(parts[1]) || `contracts/${parts[1]}` === reg.mockRoot ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
    const arr = units.get(unit) ?? [];
    arr.push(f);
    units.set(unit, arr);
  }
  const folders = reg.contracts.flatMap((c) => c.folders);
  const mocks = reg.contracts.flatMap((c) => c.mocks);
  for (const [unit, unitFiles] of units) {
    if (reg.generated.some((g) => covers(unit, g))) continue;
    if (unit.startsWith(`${reg.mockRoot}/`)) {
      if (!mocks.some((m) => covers(unit, m))) problems.push(`${unit}: mock folder not named in any entry of contracts/registry.json (add it to the \`mocks\` of its contract)`);
      continue;
    }
    if (folders.some((f) => covers(unit, f))) continue;
    if (reg.reserved.some((r) => covers(unit, r))) {
      const real = unitFiles.filter((f) => path.posix.basename(f) !== '.gitkeep');
      if (real.length) problems.push(`${unit}: has files (${real.slice(0, 3).join(', ')}) but no contract entry; add an entry to contracts/registry.json`);
      continue;
    }
    problems.push(`${unit}: unregistered contract folder; add an entry to contracts/registry.json`);
  }
  return problems.length ? { status: FAIL, details: problems } : { status: PASS, details: [`${reg.contracts.length} contracts, ${units.size} folders under contracts/ all registered`] };
}

// Breaking comparison of one contract's registered files between a commit and the working tree. The lists are the union of the head entry and
// the entry at that commit, so a file that the pull request also drops from the registry is still compared (and a deleted one is breaking).
// Dispatch is by registry list (schemas: own diff, openapi: oasdiff), never by file extension.
// Data files of a contract folder that are neither listed nor examples (D-46 e): a .json file is diffed like a schema, a deletion is breaking, and a
// changed .yaml/.yml file that no tool can compare is flagged breaking on the safe side (list it under "schemas" or "openapi" to have it compared).
const ARTEFACT = /\.(json|ya?ml)$/i;
const artefactSkipped = (p, skip) => /(^|\/)examples\//.test(p) || /(^|\/)bundle\//.test(p) || /\.schema\.json$/.test(p) || /\.openapi\.ya?ml$/.test(p) || skip.some((s) => covers(p, s));
function unlistedArtefacts(root, sha, folders, listed, skip) {
  const names = new Set();
  const inBase = git(root, ['ls-tree', '-r', '-z', '--name-only', sha, '--', ...folders], { allowFail: true });
  for (const n of (inBase ?? '').split('\0')) if (n) names.add(n);
  for (const n of git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...folders]).split('\0')) if (n) names.add(n);
  return [...names].filter((p) => ARTEFACT.test(p) && !listed.has(p) && !artefactSkipped(p, skip));
}

async function compareFiles({ root, sha, c, bc, getOasdiff, artefacts = true, skip = [] }) {
  const schemas = [...new Set([...c.schemas, ...(bc?.schemas ?? [])])];
  const openapi = [...new Set([...c.openapi, ...(bc?.openapi ?? [])])];
  const breaking = [];
  const notes = [];
  const errors = [];
  const extra = artefacts ? unlistedArtefacts(root, sha, [...new Set([...c.folders, ...(bc?.folders ?? [])])], new Set([...schemas, ...openapi]), [...skip, ...c.mocks, ...(bc?.mocks ?? [])]) : [];
  for (const [f, kind] of [...schemas.map((x) => [x, 'schema']), ...openapi.map((x) => [x, 'openapi']), ...extra.map((x) => [x, 'artefact'])]) {
    const bt = baseText(root, sha, f);
    const ht = headText(root, f);
    if (bt === ht) continue;
    if (bt === null) { notes.push(`${f}: new file, not compared (a new file is not a breaking change)`); continue; }
    if (ht === null) { breaking.push(`${f}: file removed`); continue; }
    if (kind === 'artefact') {
      if (/\.json$/i.test(f)) {
        try {
          for (const d of diffSchemas(JSON.parse(bt), JSON.parse(ht))) breaking.push(`${f} ${d.path}: ${d.change}`);
        } catch (e) {
          errors.push(`${f}: could not be compared (${e.message})`);
        }
      } else {
        breaking.push(`${f}: unlisted YAML file changed; it is not machine-comparable here (list it under "schemas" or "openapi" in contracts/registry.json, or declare the change as BREAKING)`);
      }
      continue;
    }
    if (kind === 'schema') {
      try {
        for (const d of diffSchemas(JSON.parse(bt), JSON.parse(ht))) breaking.push(`${f} ${d.path}: ${d.change}`);
      } catch (e) {
        errors.push(`${f}: could not be compared (${e.message})`);
      }
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-rules-'));
    try {
      const baseFile = path.join(tmp, `base-${path.basename(f)}`);
      const headFile = path.join(tmp, `head-${path.basename(f)}`);
      fs.writeFileSync(baseFile, bt);
      fs.writeFileSync(headFile, ht);
      const res = runOasdiff(await getOasdiff(), baseFile, headFile);
      for (const b of res.breaking) breaking.push(`${f} ${b.operation ?? ''} ${b.path ?? ''}: [${b.id}] ${b.text}`.replace(/\s+/g, ' '));
    } catch (e) {
      if (!(e instanceof OasdiffError)) throw e;
      errors.push(`${f}: could not be compared (${e.message})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { breaking, notes, errors };
}

// Does a changed file under a mock path count? Not Markdown, not a test, and not a whitespace-only edit.
function mockChanged(root, base, changed, mockPaths) {
  return [...changed].some(([p, kind]) => {
    if (!inFolder(p, mockPaths) || MOCK_IGNORED(p)) return false;
    if (kind !== 'modified') return true;
    return baseText(root, base.sha, p).replace(/\s+/g, '') !== headText(root, p).replace(/\s+/g, '');
  });
}

// Verdicts: a breaking comparison needs the exact marker (D-46 d) and a raised version in a new entry of the section.
function breakingVerdict(name, heading, cmp, baseSec, headSec, what = '') {
  const fresh = headSec ? newEntries(baseSec, headSec) : [];
  const entryLines = fresh.flatMap((e) => e.lines);
  const baseMax = maxVersion(sectionVersions(baseSec));
  const headMax = maxVersion(fresh.map((e) => parseVersion(e.heading.match(/^### (\d+\.\d+\.\d+)/)[1])));
  const marked = entryLines.some(isBreakingMarker);
  const ok = raised(baseMax, headMax);
  if (marked && ok) return { name, status: PASS, details: [`BREAKING declared in the new entry with a raised version (${headMax.join('.')}):`, ...cmp.breaking.map((b) => `  notice: ${b}`), ...cmp.notes] };
  const missing = [!marked && 'a line marked BREAKING in the new entry (a bullet starting with "BREAKING:" and a reason, exact case)', !ok && `a new entry whose version is above ${baseMax?.join('.')} ${raiseText(baseMax)} (the newest new entry is ${headMax?.join('.') ?? 'missing'})`].filter(Boolean);
  return { name, status: FAIL, details: [...cmp.breaking, `${what ? `${what}: ` : ''}needs ${missing.join(' and ')} in the section "${heading}"`] };
}
function sinceVerdict(name, tag, since, headSec) {
  const headMax = maxVersion(sectionVersions(headSec));
  if (since.errors.length) return { name, status: FAIL, details: since.errors };
  if (!since.breaking.length) return { name, status: PASS, details: [`no breaking change since ${tag.tag}`] };
  // the marker must sit in an entry newer than the tag
  const marked = sectionEntries(headSec).some((e) => {
    const v = parseVersion(e.heading.match(/^### (\d+\.\d+\.\d+)/)?.[1] ?? '');
    return v.length === 3 && cmpVersion(v, tag.version) > 0 && e.lines.some(isBreakingMarker);
  });
  if (raised(tag.version, headMax) && marked) return { name, status: PASS, details: [`breaking since ${tag.tag}, and the changelog version ${headMax.join('.')} is raised ${raiseText(tag.version)} with a BREAKING: line`, ...since.breaking.map((b) => `  notice: ${b}`)] };
  const missing = [!raised(tag.version, headMax) && `the changelog version must be raised ${raiseText(tag.version)} above ${tag.version.join('.')} (newest entry: ${headMax?.join('.') ?? 'none'})`, !marked && `an entry newer than ${tag.tag} needs a line starting with "BREAKING:" and a reason`].filter(Boolean);
  return { name, status: FAIL, details: [...since.breaking, `breaking since ${tag.tag}: ${missing.join('; and ')}`] };
}

// Per contract checks ---------------------------------------------------------------------------------------------------------------------
async function contractChecks({ root, reg, base, tag, changed, getOasdiff }) {
  const results = [];
  const baseReg = registryAt(root, base.sha);
  const baseLog = baseText(root, base.sha, 'contracts/CHANGELOG.md');
  const headLog = headText(root, 'contracts/CHANGELOG.md');
  const tagReg = tag?.sha ? registryAt(root, tag.sha) : null;

  // A registry entry of the base that is gone in the head (D-46 a). Deleting a whole contract is a breaking change: the files it registered are
  // compared with the base entry (each missing file is "file removed") and the usual declaration is needed. A rename or a merge is not a deletion
  // only when another head entry lists the same files (and covers the same folders).
  const listedAnywhere = (f) => reg.contracts.some((c) => c.schemas.includes(f) || c.openapi.includes(f));
  const folderCarried = (f) => reg.contracts.some((c) => c.folders.some((cf) => covers(f, cf)));
  for (const bc of baseReg?.contracts ?? []) {
    if (reg.contracts.some((c) => c.id === bc.id)) continue;
    const carriedFiles = (x) => [...x.schemas, ...x.openapi].filter((f) => listedAnywhere(f) && fs.existsSync(path.join(root, f)));
    const lostOf = (x) => ({ id: x.id, folders: x.folders, mocks: [], schemas: x.schemas.filter((f) => !carriedFiles(x).includes(f)), openapi: x.openapi.filter((f) => !carriedFiles(x).includes(f)) });
    const left = bc.folders.filter((f) => fs.existsSync(path.join(root, f)) && !folderCarried(f));
    const nameOf = `registry-entry[${bc.id}]`;
    if (left.length) results.push({ name: nameOf, status: FAIL, details: [`the registry entry ${bc.id} of the base was dropped, but its folder(s) ${left.join(', ')} still exist and no other entry covers them; a dropped entry would switch its checks off`] });
    else if (bc.folders.some((f) => fs.existsSync(path.join(root, f)))) results.push({ name: nameOf, status: PASS, details: [`notice: the entry ${bc.id} no longer exists; its files and folders are carried by other entries`] });
    else results.push({ name: nameOf, status: PASS, details: [`notice: contract ${bc.id} was removed together with its folders`] });

    const heading = bc.changelog;
    const lost = lostOf(bc);
    const cmp = await compareFiles({ root, sha: base.sha, c: lost, bc: undefined, getOasdiff, artefacts: false, skip: reg.generated });
    const everyFile = [...bc.schemas, ...bc.openapi];
    if (!everyFile.length && !bc.folders.every(folderCarried)) cmp.breaking.push(`contract ${bc.id} removed from the registry (it listed no schema or OpenAPI file, so no file is compared)`);
    if (cmp.errors.length) results.push({ name: `breaking[${bc.id}]`, status: FAIL, details: cmp.errors });
    else if (!cmp.breaking.length) results.push({ name: `breaking[${bc.id}]`, status: PASS, details: [`every file of the removed entry ${bc.id} is listed by another entry and still exists`] });
    else results.push(breakingVerdict(`breaking[${bc.id}]`, heading, cmp, changelogSection(baseLog, heading), changelogSection(headLog, heading), `contract ${bc.id} was removed (keep its section "## ${heading}" in contracts/CHANGELOG.md and add the entry there)`));
    const tbc = tagReg?.contracts.find((x) => x.id === bc.id);
    if (tag?.sha && tbc) {
      const since = await compareFiles({ root, sha: tag.sha, c: lostOf(tbc), bc: undefined, getOasdiff, artefacts: false, skip: reg.generated });
      results.push(sinceVerdict(`breaking-since-tag[${bc.id}]`, tag, since, changelogSection(headLog, heading)));
    }
  }

  for (const c of reg.contracts) {
    const bc = baseReg?.contracts.find((x) => x.id === c.id);
    const folders = [...new Set([...c.folders, ...(bc?.folders ?? [])])];
    const under = [...changed.keys()].filter((p) => inFolder(p, folders));
    if (!under.length) {
      results.push({ name: `contract[${c.id}]`, status: PASS, details: ['no file of this contract changed'] });
      continue;
    }
    const shown = under.slice(0, 4).join(', ') + (under.length > 4 ? `, and ${under.length - 4} more` : '');
    const baseSec = changelogSection(baseLog, bc?.changelog ?? c.changelog);
    const headSec = changelogSection(headLog, c.changelog);
    const fresh = headSec ? newEntries(baseSec, headSec) : [];
    const entryLines = fresh.flatMap((e) => e.lines);

    // rule 4: a changelog entry
    if (!headSec) {
      results.push({ name: `changelog[${c.id}]`, status: FAIL, details: [baseSec ? `${c.id} changed (${shown}) and its changelog section existed in the base but "## ${c.changelog}" is missing now (heading renamed or removed)` : `${c.id} changed (${shown}) but contracts/CHANGELOG.md has no section "## ${c.changelog}"`] });
    } else if (!fresh.length) {
      results.push({ name: `changelog[${c.id}]`, status: FAIL, details: [`${c.id} changed (${shown}) but its section "${c.changelog}" has no newly added entry heading "### X.Y.Z ..."`] });
    } else {
      results.push({ name: `changelog[${c.id}]`, status: PASS, details: [`new entr${fresh.length > 1 ? 'ies' : 'y'} for ${c.id}: ${fresh.map((e) => e.heading.slice(4)).join('; ')}`] });
    }

    // rule 4: the mock moves with the contract
    const ruleMocks = c.ruleMocks ?? c.mocks; // trusted mode: the mock paths of the base decide, not a decoy added by the pull request
    const machine = [...c.schemas, ...c.openapi].filter((p) => changed.has(p));
    if (!machine.length) results.push({ name: `mock[${c.id}]`, status: PASS, details: ['no schema or OpenAPI file changed, so no mock change is needed'] });
    else if (!ruleMocks.length) results.push({ name: `mock[${c.id}]`, status: PASS, details: [c.noMock] });
    else if (mockChanged(root, base, changed, ruleMocks)) results.push({ name: `mock[${c.id}]`, status: PASS, details: ['a mock file changed with the contract'] });
    else if (entryLines.some((l) => WAIVER.test(l))) results.push({ name: `mock[${c.id}]`, status: PASS, details: [`waived: ${entryLines.find((l) => WAIVER.test(l)).trim()}`] });
    else results.push({ name: `mock[${c.id}]`, status: FAIL, details: [`${machine.join(', ')} changed but no code file under the mock path(s) ${ruleMocks.join(', ')} changed (Markdown, test files and whitespace-only edits do not count); update the mock or add a line "no mock change: <reason>" to the new changelog entry`] });

    // rule 3: breaking changes against the pull request base
    const cmp = await compareFiles({ root, sha: base.sha, c, bc, getOasdiff, skip: reg.generated });
    if (cmp.errors.length) results.push({ name: `breaking[${c.id}]`, status: FAIL, details: cmp.errors });
    else if (!cmp.breaking.length) results.push({ name: `breaking[${c.id}]`, status: PASS, details: cmp.notes.length ? cmp.notes : ['no breaking change in the schema or OpenAPI files'] });
    else results.push(breakingVerdict(`breaking[${c.id}]`, c.changelog, cmp, baseSec, headSec));

    // the same comparison against the latest contracts-v tag
    if (tag?.sha) {
      const since = await compareFiles({ root, sha: tag.sha, c, bc: tagReg?.contracts.find((x) => x.id === c.id), getOasdiff, skip: reg.generated });
      results.push(sinceVerdict(`breaking-since-tag[${c.id}]`, tag, since, headSec));
    }
  }
  return results;
}

// Python checks (Alembic, table owners) ---------------------------------------------------------------------------------------------------
export function runPythonCheck(name, script, root) {
  if (spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: 30_000 }).status !== 0) {
    return { name, status: FAIL, details: [`${script} needs uv (the version pinned in .github/workflows/ci.yml) and the packages of the vulnmart-api workspace; uv was not found, and a bare python is not used because it would lack them`] };
  }
  const r = spawn(`check ${name}`, 'uv', ['run', '--locked', '--package', 'vulnmart-api', 'python', path.join(REPO_ROOT, 'scripts', script), '--root', root], { cwd: REPO_ROOT }, TIMEOUT_MS.python);
  const lines = (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const m = lines[0]?.match(/^(PASS|FAIL|NOT-APPLICABLE) /);
  if (r.error || !m) return { name, status: FAIL, details: [`${script} could not run (exit ${r.status}): ${(r.stderr || r.error?.message || r.stdout).trim().slice(0, 400)}`] };
  const status = m[1];
  if ((status === FAIL) !== (r.status === 1)) return { name, status: FAIL, details: [`${script} exit code ${r.status} does not match its output`] };
  return { name, status, details: lines.map((l) => l.replace(/^(PASS|FAIL|NOT-APPLICABLE) /, '')) };
}

// An input that is NOT-APPLICABLE because it is absent must also be absent in the base; if it existed there, it was deleted.
function deletedInput(result, existedInBase, what, baseRef) {
  if (result.status !== NA || !existedInBase) return result;
  return { status: FAIL, details: [`${what} existed in ${baseRef} and is missing now; the check input was deleted`] };
}

// COMPAT.md -------------------------------------------------------------------------------------------------------------------------------
// Proposed format (for Akshay, handoff in docs/dev/HANDOFFS.md): a Markdown table whose first two columns are the contract id of
// contracts/registry.json and the contract version (X.Y.Z, optionally written contracts-vX.Y.Z); more columns are free. The first table row is the
// header (whatever it is called); separator rows are skipped; bold and backticks in a cell are ignored.
// Story L-09 (ADR 0029): COMPAT.md has more than one table, so each table sits under its own `## ` heading. The table of versions is the one under
// `## Versions`; the table of approvers is the one under `## Approvals`. A file with no `## ` heading at all is read as one table of versions (the
// first format of this proposal).
const stripMd = (s) => s.replace(/[*_`]/g, '').trim();
const SEPARATOR_ROW = (cells) => cells.every((c) => /^:?-{3,}:?$/.test(c) || c === '');
// The lines under a `## <name>` heading (case-insensitive) up to the next `## ` heading, with the 0-based index of the first one; null when absent.
export function compatSection(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.slice(2).trim().toLowerCase() === name.toLowerCase());
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return { lines: lines.slice(start + 1, end), offset: start + 1 };
}
// The first pipe line is the header; separator rows are skipped. `line` is the 1-based line number in the whole file.
export function tableOf(section) {
  let header = null;
  const rows = [];
  section.lines.forEach((line, i) => {
    // A table line starts with a pipe, or has at least six pipes without the outer ones: the Approvals table is written that way so that the
    // older checker of the base commit (it reads every `|` line of the file as a row of versions) skips it.
    if (!line.trim().startsWith('|') && line.trim().split('|').length < 7) return;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(stripMd);
    if (!header) { header = cells; return; }
    if (SEPARATOR_ROW(cells)) return;
    rows.push({ cells, line: section.offset + i + 1 });
  });
  return { header, rows };
}
export const APPROVAL_COLUMNS = ['contract', 'stream', 'handle', 'role', 'version', 'date', 'status'];
export const APPROVAL_STATUSES = ['pending', 'approved'];
const HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// The approvers of the contracts: one row per contract, stream, handle and role (owner or consumer). Returns the rows and the problems found.
export function parseApprovers(text, reg) {
  const section = compatSection(text, 'Approvals');
  if (!section) return { rows: [], problems: ['contracts/COMPAT.md has no "## Approvals" section'] };
  const { header, rows } = tableOf(section);
  const problems = [];
  if (!header || APPROVAL_COLUMNS.some((c, i) => (header[i] ?? '').toLowerCase() !== c)) {
    return { rows: [], problems: [`the Approvals table must start with the columns ${APPROVAL_COLUMNS.join(' | ')} (found: ${(header ?? []).join(' | ') || 'no table'})`] };
  }
  const out = [];
  for (const { cells, line } of rows) {
    const [contract, stream, handle, role, version, date, status] = cells;
    const at = `line ${line}`;
    if (!reg.contracts.some((c) => c.id === contract)) { problems.push(`${at}: contract "${contract}" is not in contracts/registry.json`); continue; }
    if (!['L', 'P', 'T'].includes(stream)) problems.push(`${at}: stream "${stream}" must be L, P or T`);
    if (!HANDLE.test(handle ?? '')) { problems.push(`${at}: handle "${handle}" must look like @github-login`); continue; }
    if (!['owner', 'consumer'].includes(role)) { problems.push(`${at}: role "${role}" must be owner or consumer`); continue; }
    if (parseVersion(version ?? '').length !== 3) problems.push(`${at}: version "${version}" is not X.Y.Z`);
    if (!APPROVAL_STATUSES.includes(status)) problems.push(`${at}: status "${status}" must be ${APPROVAL_STATUSES.join(' or ')}`);
    out.push({ contract, stream, handle: handle.slice(1).toLowerCase(), role, version, date, status, line });
  }
  return { rows: out, problems };
}

function checkCompat(root, reg, headLog) {
  const text = headText(root, 'contracts/COMPAT.md');
  if (text === null) return { status: NA, details: ['contracts/COMPAT.md does not exist yet'] };
  const tags = new Set(git(root, ['tag', '--list', TAG_GLOB]).split('\n').map((t) => t.trim()).filter(Boolean));
  const problems = [];
  const sectioned = text.split('\n').some((l) => /^##\s/.test(l));
  const section = sectioned ? compatSection(text, 'Versions') : { lines: text.split('\n'), offset: 0 };
  if (!section) return { status: FAIL, details: ['contracts/COMPAT.md has sections but no "## Versions" section (the table of | contract id | version | rows)'] };
  const { rows } = tableOf(section);
  for (const { cells, line } of rows) {
    const c = reg.contracts.find((x) => x.id === cells[0]);
    if (!c) { problems.push(`line ${line}: contract "${cells[0]}" is not in contracts/registry.json`); continue; }
    const v = parseVersion((cells[1] ?? '').replace(/^contracts-/, ''));
    if (v.length !== 3) { problems.push(`line ${line}: ${c.id} lists the version "${cells[1] ?? ''}", which is not X.Y.Z`); continue; }
    const inLog = sectionVersions(changelogSection(headLog, c.changelog)).some((x) => cmpVersion(x, v) === 0);
    if (!inLog && !tags.has(`contracts-v${v.join('.')}`)) problems.push(`line ${line}: ${c.id} lists version ${v.join('.')}, which is neither a changelog entry nor a tag contracts-v${v.join('.')}`);
  }
  let approvers = 0;
  if (sectioned && compatSection(text, 'Approvals')) {
    const a = parseApprovers(text, reg);
    problems.push(...a.problems);
    approvers = a.rows.length;
  }
  if (problems.length) return { status: FAIL, details: problems };
  if (!rows.length) return { status: FAIL, details: ['contracts/COMPAT.md has no table row of the form | contract id | version |'] };
  return { status: PASS, details: [`${rows.length} row(s), every listed version exists${approvers ? `; ${approvers} approver row(s)` : ''}`] };
}

// Approvals (story L-09, ADR 0029) -----------------------------------------------------------------------------------------------------------
// Starts with the first tag contracts-v*. A pull request that changes the files of a contract needs: one approval from an owner or consumer of that
// contract (additive change), or from every consumer (a change declared BREAKING in its new changelog entry; D-46 d), never counting the author's own
// review. The table of approvers is read from the BASE copy of COMPAT.md (ADR 0026: a pull request cannot add itself). The reviews come from a JSON
// file written by a separate CI step (`gh api`), so this script never holds a token. An approval counts only when the reviewer is listed, is not the
// author, the latest review state of that person is APPROVED, and no file of the contract folders differs between the reviewed commit and the head.
const REVIEW_STATES = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];
export function loadReviews(input) {
  let data = input;
  if (typeof input === 'string') {
    if (!fs.existsSync(input)) return { error: `the reviews file ${input} does not exist` };
    try {
      data = JSON.parse(fs.readFileSync(input, 'utf8'));
    } catch (e) {
      return { error: `the reviews file ${input} is not valid JSON: ${e.message}` };
    }
  }
  if (!Array.isArray(data)) return { error: 'the reviews are not a JSON array (expected the output of `gh api --paginate --slurp .../pulls/N/reviews`)' };
  const flat = data.flatMap((x) => (Array.isArray(x) ? x : [x]));
  const out = [];
  for (const [i, r] of flat.entries()) {
    if (!r || typeof r !== 'object') return { error: `review ${i + 1} is not an object` };
    if (!REVIEW_STATES.includes(String(r.state ?? '').toUpperCase())) continue; // a comment or a pending review decides nothing and may lack fields
    if (r.user === null) continue; // a deleted account
    if (typeof r.user?.login !== 'string' || typeof r.state !== 'string' || !/^[0-9a-f]{7,40}$/i.test(r.commit_id ?? '')) return { error: `review ${i + 1} lacks user.login, state or a commit_id` };
    out.push({ login: r.user.login.toLowerCase(), state: r.state.toUpperCase(), commit: r.commit_id.toLowerCase(), at: String(r.submitted_at ?? ''), id: Number(r.id) || 0, i });
  }
  return { reviews: out };
}
// The latest meaningful review of each person (a plain comment never replaces an approval, as on GitHub).
function latestReviews(reviews) {
  const by = new Map();
  for (const r of [...reviews].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id || a.i - b.i)) if (REVIEW_STATES.includes(r.state)) by.set(r.login, r);
  return by;
}
// Did a file of these folders change between the reviewed commit and the head (the working tree)? null when it cannot be told.
function changedSince(root, commit, folders) {
  if (spawn('git cat-file', 'git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`], {}, TIMEOUT_MS.git).status !== 0) return null;
  const d = spawn('git diff', 'git', ['-C', root, 'diff', '--quiet', commit, '--', ...folders], {}, TIMEOUT_MS.git);
  if (d.status === 1) return true;
  if (d.status !== 0) return null;
  return git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...folders]).split('\0').some(Boolean);
}
const handles = (rows) => [...new Set(rows.map((r) => r.handle))];
const at = (hs) => hs.map((h) => `@${h}`).join(', ');

export function approvalsCheck({ root, reg, baseReg, base, tag, changed, baseLog, headLog, reviews: reviewsInput, requireReviews = false, prAuthor }) {
  if (!tag) return { status: NA, details: ['the approvals rule starts with the first tag contracts-v* (the tag contracts-v1.0.0); no such tag exists yet'] };
  const compatBase = baseText(root, base.tip ?? base.sha, 'contracts/COMPAT.md');
  if (compatBase === null) return { status: FAIL, details: [`tag exists (${tag.tag}) but the base (${base.ref}) has no contracts/COMPAT.md, so nobody is listed to approve; restore it in the base before changing a contract`] };
  if (reviewsInput === undefined && !requireReviews) return { status: NA, details: ['no reviews file given (a local run); CI passes --reviews and --require-reviews'] };
  const loaded = reviewsInput === undefined ? { error: 'no reviews file given, but the reviews are required (--require-reviews needs --reviews <file>)' } : loadReviews(reviewsInput);
  if (loaded.error) return { status: FAIL, details: [loaded.error] };
  const parsed = parseApprovers(compatBase, baseReg ?? reg);
  if (parsed.problems.length) return { status: FAIL, details: [`the Approvals table of contracts/COMPAT.md in ${base.ref} is not usable:`, ...parsed.problems.map((p) => `  ${p}`)] };

  // which contracts changed, and which of them declare a breaking change
  const ids = [...new Set([...reg.contracts.map((c) => c.id), ...(baseReg?.contracts ?? []).map((c) => c.id)])];
  const work = [];
  for (const id of ids) {
    const c = reg.contracts.find((x) => x.id === id);
    const bc = baseReg?.contracts.find((x) => x.id === id);
    const folders = [...new Set([...(c?.folders ?? []), ...(bc?.folders ?? [])])];
    const under = [...changed.keys()].filter((p) => inFolder(p, folders));
    if (!under.length) continue;
    const fresh = c ? newEntries(changelogSection(baseLog, bc?.changelog ?? c.changelog), changelogSection(headLog, c.changelog)) : [];
    const breaking = !c || fresh.some((e) => e.lines.some(isBreakingMarker));
    work.push({ id, folders, breaking, why: !c ? 'the contract was removed' : breaking ? 'declared BREAKING in its new changelog entry' : 'additive' });
  }
  if (!work.length) return { status: PASS, details: ['no file of any contract changed, so no approval is needed'] };
  if (!prAuthor) return { status: FAIL, details: ['the author of the pull request is unknown (--pr-author <login>), so an own review cannot be left out'] };
  const author = prAuthor.replace(/^@/, '').toLowerCase();
  const latest = latestReviews(loaded.reviews);

  const details = [];
  let failed = false;
  for (const w of work) {
    const rows = parsed.rows.filter((r) => r.contract === w.id);
    if (!rows.length) { failed = true; details.push(`${w.id} (${w.why}): the base COMPAT.md lists no approver for it`); continue; }
    const consumers = handles(rows.filter((r) => r.role === 'consumer')).filter((h) => h !== author);
    const eligible = handles(rows);
    if (!eligible.some((h) => h !== author)) { failed = true; details.push(`${w.id} (${w.why}): no listed person other than the author can approve (the base COMPAT.md lists only @${author} for it)`); continue; }
    const needed = w.breaking && consumers.length ? consumers : null; // null: one approval from any listed person is enough
    const ignored = [];
    const good = new Map();
    const blockers = [];
    for (const [login, r] of latest) {
      if (r.state === 'CHANGES_REQUESTED' && eligible.includes(login) && login !== author) blockers.push(login);
      if (r.state !== 'APPROVED') { if (eligible.includes(login)) ignored.push(`@${login}: latest review is ${r.state}, not an approval`); continue; }
      if (login === author) { ignored.push(`@${login} is the author: an own review never counts`); continue; }
      if (!eligible.includes(login)) { ignored.push(`@${login} is not listed for ${w.id} in the Approvals table of the base COMPAT.md`); continue; }
      const stale = changedSince(root, r.commit, w.folders);
      if (stale === null) { ignored.push(`@${login} approved ${r.commit.slice(0, 7)}, which cannot be compared with the head (not in this clone)`); continue; }
      if (stale) { ignored.push(`@${login} approved ${r.commit.slice(0, 7)}, but the files of ${w.id} changed after it`); continue; }
      good.set(login, r.commit.slice(0, 7));
    }
    if (blockers.length) { failed = true; details.push(`${w.id} (${w.why}): ${at(blockers)} requested changes in the latest review (an approval by someone else does not outweigh it)`); }
    const missing = needed ? needed.filter((h) => !good.has(h)) : good.size ? [] : eligible.filter((h) => h !== author);
    if (missing.length) {
      failed = true;
      details.push(`${w.id} (${w.why}): ${needed ? `needs the approval of every consumer, missing ${at(missing)}` : `needs one approval from ${at(missing)} (owner or consumer, not the author)`}`);
    } else {
      details.push(`${w.id} (${w.why}): approved by ${[...good].map(([h, c]) => `@${h} at ${c}`).join(', ')}`);
    }
    for (const x of ignored) details.push(`  ignored: ${x}`);
  }
  return { status: failed ? FAIL : PASS, details };
}

// Bundle ----------------------------------------------------------------------------------------------------------------------------------
// Proposed command (for Akshay): package.json script `contracts:bundle:check` exits non-zero when contracts/api/bundle/openapi.json is not
// the bundle of the fragments (or is missing).
const bundleScript = (text) => {
  try {
    return JSON.parse(text ?? '{}').scripts?.['contracts:bundle:check'];
  } catch {
    return undefined;
  }
};
function checkBundle(root) {
  const script = bundleScript(headText(root, 'package.json'));
  const bundleFile = 'contracts/api/bundle/openapi.json';
  const exists = fs.existsSync(path.join(root, bundleFile));
  if (!script) {
    return exists
      ? { status: FAIL, details: [`${bundleFile} exists but package.json has no script "contracts:bundle:check" to prove it is current`] }
      : { status: NA, details: [`no bundle command (script "contracts:bundle:check") and no ${bundleFile} yet`] };
  }
  // the command is fixed; pnpm is a .cmd file on Windows, which needs a shell
  const r = spawn('check bundle', 'pnpm', ['run', 'contracts:bundle:check'], { cwd: root, shell: process.platform === 'win32' }, TIMEOUT_MS.bundle);
  if (r.error) return { status: FAIL, details: [`could not run pnpm run contracts:bundle:check: ${r.error.message}`] };
  return r.status === 0
    ? { status: PASS, details: ['contracts:bundle:check passed'] }
    : { status: FAIL, details: [`contracts:bundle:check exited ${r.status}: ${((r.stdout ?? '') + (r.stderr ?? '')).trim().slice(0, 400)}`] };
}

// Run everything --------------------------------------------------------------------------------------------------------------------------
const within = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Trusted mode (D-46 b): the checker and its pins come from the base commit, `root` is the pull request head and is only read as data. The registry
// rules (containers, reserved, generated, mockRoot, noMock, the changelog heading, the existing folders and mocks) are taken from the base tip; the head
// registry only adds entries and paths (and its change is reported by the guard).
export function effectiveRegistry(headReg, authority, root) {
  if (!authority) return headReg;
  return {
    ...headReg,
    containers: authority.containers,
    reserved: authority.reserved,
    generated: authority.generated,
    mockRoot: authority.mockRoot,
    contracts: headReg.contracts.map((c) => {
      const a = authority.contracts.find((x) => x.id === c.id);
      if (!a) return c;
      const folders = [...new Set([...a.folders, ...c.folders])].filter((f) => fs.existsSync(path.join(root, f)));
      return { ...c, folders: folders.length ? folders : c.folders, mocks: [...new Set([...a.mocks, ...c.mocks])], ruleMocks: a.mocks, noMock: a.noMock ?? c.noMock, changelog: a.changelog };
    }),
  };
}

function guardCheck(root, base, changed, baseLog, headLog) {
  const touched = [...changed.keys()].filter(isGuarded);
  const declared = addedLines((baseLog ?? '').split('\n'), (headLog ?? '').split('\n')).filter((l) => REGISTRY_CHANGE_LINE.test(l));
  if (!touched.length) return { status: PASS, details: ['the registry, the checker, the diff scripts, the oasdiff pins and the workflows are unchanged by this pull request'] };
  if (declared.length) return { status: PASS, details: [`notice: this pull request changes the rules engine (${touched.join(', ')}), declared in contracts/CHANGELOG.md: ${declared[0].trim()}`] };
  return { status: FAIL, details: [`this pull request changes files that define or run the contract rules: ${touched.join(', ')}; the rules of the base were applied. Add a new line "- registry change: <reason>" to a new entry of contracts/CHANGELOG.md; a reviewer (CODEOWNERS) must approve it`] };
}

export async function runRules({ root = REPO_ROOT, base: baseArg, env = process.env, oasdiffBin, skip = [], trusted = false, bootstrap = false, tools, checkerRoot = REPO_ROOT, untrustedOnly = false, reviews, requireReviews = false, prAuthor } = {}) {
  const results = [];
  let approvalsInput = null; // set when the comparison with the base worked: what the rule `approvals` needs
  const push = (name, r) => results.push({ name, ...r });
  const notices = [];
  if (trusted) {
    if (bootstrap) {
      notices.push('NOTICE: bootstrap run. The base commit has no trusted-mode checker yet (this pull request introduces it), so the checker of the head ran. This run is NOT protected against a pull request that weakens the rules; review the pull request by hand.');
    } else {
      const bad = [];
      if (within(checkerRoot, root)) bad.push(`the checker runs from ${checkerRoot}, inside the tree it grades (${root}); run the copy from the base commit`);
      if (tools && within(tools, root)) bad.push(`the oasdiff pin file ${tools} is inside the head tree; use the pin file of the base commit`);
      if (bad.length) { push('trusted-base', { status: FAIL, details: bad }); return results; }
    }
  }
  let base;
  try {
    base = resolveBase(root, { base: baseArg, env });
  } catch (e) {
    base = { error: `git could not give the comparison (${e.message}); ${FULL_HISTORY}` };
  }
  const inBase = (p) => (base?.sha ? existsAt(root, base.sha, p) : false);
  const untrustedChecks = () => {
    // `skip` exists for the tests of the other rules (the Python runs are slow); the command line never skips.
    if (!skip.includes('table-owners')) push('table-owners', deletedInput(runPythonCheck('table-owners', 'check_table_owners.py', root), inBase('contracts/db/table-owners.yaml'), 'contracts/db/table-owners.yaml', base?.ref));
    if (!skip.includes('alembic')) push('alembic', deletedInput(runPythonCheck('alembic', 'check_alembic_head.py', root), inBase('apps/api/migrations/versions'), 'apps/api/migrations/versions', base?.ref));
    const bundleInBase = base?.sha ? !!bundleScript(baseText(root, base.sha, 'package.json')) || inBase('contracts/api/bundle/openapi.json') : false;
    push('bundle', deletedInput(checkBundle(root), bundleInBase, 'the bundle command or contracts/api/bundle/openapi.json', base?.ref));
  };

  // Head-code checks only (they run package.json scripts and Python of the head): the separate job `contract-rules-untrusted`.
  if (untrustedOnly) {
    if (base.error) push('base', { status: FAIL, details: [base.error] });
    untrustedChecks();
    return results;
  }

  const { registry: headReg, error } = loadRegistry(root);
  if (error) {
    push('registry', { status: FAIL, details: [error] });
    return results;
  }
  let reg = headReg;
  let authorityNote = null;
  if (trusted && base.tip) {
    const authority = registryAt(root, base.tip);
    if (authority) reg = effectiveRegistry(headReg, authority, root);
    else authorityNote = 'notice: the base commit has no readable contracts/registry.json, so the head registry stands alone (bootstrap of the registry)';
  }
  try {
    push('registry', checkRegistry(root, reg));
    if (base.error) {
      push('base', { status: FAIL, details: [base.error] });
    } else {
      const tag = resolveTag(root);
      if (tag?.error) {
        push('base', { status: FAIL, details: [tag.error] });
        base = { ...base, error: tag.error };
      } else {
        let oasdiff;
        // `oasdiffBin` (a path, or a function that returns one) lets the tests stand in for the verified binary; `tools` is the pin file of the base.
        const getOasdiff = async () => (oasdiff ??= typeof oasdiffBin === 'function' ? await oasdiffBin() : oasdiffBin ?? (await ensureOasdiff(tools ? { config: loadConfig(path.resolve(tools)) } : {})));
        const changed = changedFiles(root, base.sha);
        const detail = [`compared with ${base.ref} (merge base ${base.sha.slice(0, 10)}); ${changed.size} file(s) differ${tag ? `; breaking changes are also compared with ${tag.tag}` : ''}`];
        if (!tag) detail.push(`NOTICE: no tag ${TAG_GLOB} exists, so the comparison with the latest tag did not run (only the pull request base is compared)`);
        if (trusted) detail.push('trusted mode: the registry rules come from the base commit; bundle, Alembic and table-owner checks run in the job contract-rules-untrusted', ...(authorityNote ? [authorityNote] : []));
        detail.push(...notices);
        push('base', { status: PASS, details: detail });
        if (trusted) push('trusted-base', guardCheck(root, base, changed, baseText(root, base.sha, 'contracts/CHANGELOG.md'), headText(root, 'contracts/CHANGELOG.md')));
        results.push(...(await contractChecks({ root, reg, base, tag, changed, getOasdiff })));
        approvalsInput = { root, reg, baseReg: registryAt(root, base.tip ?? base.sha), base, tag, changed, baseLog: baseText(root, base.sha, 'contracts/CHANGELOG.md'), headLog: headText(root, 'contracts/CHANGELOG.md'), reviews, requireReviews, prAuthor };
      }
    }
  } catch (e) {
    push('base', { status: FAIL, details: [`git could not give the comparison (${e.message}); ${FULL_HISTORY}`] });
    base = { error: e.message };
  }

  push('compat', deletedInput(checkCompat(root, reg, headText(root, 'contracts/CHANGELOG.md')), inBase('contracts/COMPAT.md'), 'contracts/COMPAT.md', base?.ref));
  try {
    push('approvals', approvalsInput ? approvalsCheck(approvalsInput) : { status: FAIL, details: ['not evaluated: the comparison with the base failed (see the check "base")'] });
  } catch (e) {
    push('approvals', { status: FAIL, details: [`the approvals rule could not run: ${e.message}`] });
  }
  if (!trusted) untrustedChecks();
  return results;
}
export function formatResults(results) {
  const lines = [];
  for (const r of results) {
    const [first, ...rest] = r.details;
    lines.push(`${r.status.padEnd(15)} ${r.name}: ${first ?? ''}`);
    for (const d of rest) lines.push(`${' '.repeat(16)}${d}`);
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  lines.push('');
  lines.push(`SUMMARY: ${n(PASS)} PASS, ${n(FAIL)} FAIL, ${n(NA)} NOT-APPLICABLE`);
  for (const r of results.filter((x) => x.status === NA)) lines.push(`NOT-APPLICABLE: ${r.name}: ${r.details.join('; ')}`);
  return lines.join('\n');
}

async function main(argv) {
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const root = opt('--root') ? path.resolve(opt('--root')) : REPO_ROOT;
  const tools = opt('--tools') ? path.resolve(opt('--tools')) : undefined;
  // --tools implies trusted mode (D-46 b); --trusted alone is the same with the pins of this checkout
  const trusted = argv.includes('--trusted') || !!tools;
  let results;
  try {
    results = await runRules({ root, base: opt('--base'), trusted, bootstrap: argv.includes('--bootstrap'), tools, untrustedOnly: argv.includes('--untrusted-only'), reviews: opt('--reviews') ? path.resolve(opt('--reviews')) : undefined, requireReviews: argv.includes('--require-reviews'), prAuthor: opt('--pr-author') });
  } catch (e) {
    process.stderr.write(`contract rules could not run: ${e.message}\n`);
    return 2;
  }
  const text = formatResults(results);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Contract rules\n\n\`\`\`\n${text}\n\`\`\`\n`); } catch { /* the summary is a convenience */ }
  }
  return results.some((r) => r.status === FAIL) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
