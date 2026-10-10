// Contract rules for pull requests (story L-07, architecture 07 section 5 and rules 3, 4, 8, 9). One rule set, read from contracts/registry.json.
// Usage: node scripts/check-contract-rules.mjs [--base <ref>] [--root <dir>]
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
import { ensureOasdiff, runOasdiff, OasdiffError } from './oasdiff.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const NA = 'NOT-APPLICABLE';
const TAG_GLOB = 'contracts-v*';
const WAIVER = /\bno mock change:\s*\S/;
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
  return { ref, sha: mb.trim() };
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
async function compareFiles({ root, sha, c, bc, getOasdiff }) {
  const schemas = [...new Set([...c.schemas, ...(bc?.schemas ?? [])])];
  const openapi = [...new Set([...c.openapi, ...(bc?.openapi ?? [])])];
  const breaking = [];
  const notes = [];
  const errors = [];
  for (const [f, kind] of [...schemas.map((x) => [x, 'schema']), ...openapi.map((x) => [x, 'openapi'])]) {
    const bt = baseText(root, sha, f);
    const ht = headText(root, f);
    if (bt === ht) continue;
    if (bt === null) { notes.push(`${f}: new file, not compared (a new file is not a breaking change)`); continue; }
    if (ht === null) { breaking.push(`${f}: file removed`); continue; }
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

// Per contract checks ---------------------------------------------------------------------------------------------------------------------
async function contractChecks({ root, reg, base, tag, changed, getOasdiff }) {
  const results = [];
  const baseReg = registryAt(root, base.sha);
  const baseLog = baseText(root, base.sha, 'contracts/CHANGELOG.md');
  const headLog = headText(root, 'contracts/CHANGELOG.md');
  const tagReg = tag?.sha ? registryAt(root, tag.sha) : null;

  // a registry entry of the base that is gone in the head
  for (const bc of baseReg?.contracts ?? []) {
    if (reg.contracts.some((c) => c.id === bc.id)) continue;
    const left = bc.folders.filter((f) => fs.existsSync(path.join(root, f)));
    results.push(left.length
      ? { name: `registry-entry[${bc.id}]`, status: FAIL, details: [`the registry entry ${bc.id} of the base was dropped, but its folder(s) ${left.join(', ')} still exist; a dropped entry would switch its checks off`] }
      : { name: `registry-entry[${bc.id}]`, status: PASS, details: [`notice: contract ${bc.id} was removed together with its folders`] });
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
    const machine = [...c.schemas, ...c.openapi].filter((p) => changed.has(p));
    if (!machine.length) results.push({ name: `mock[${c.id}]`, status: PASS, details: ['no schema or OpenAPI file changed, so no mock change is needed'] });
    else if (!c.mocks.length) results.push({ name: `mock[${c.id}]`, status: PASS, details: [c.noMock] });
    else if (mockChanged(root, base, changed, c.mocks)) results.push({ name: `mock[${c.id}]`, status: PASS, details: ['a mock file changed with the contract'] });
    else if (entryLines.some((l) => WAIVER.test(l))) results.push({ name: `mock[${c.id}]`, status: PASS, details: [`waived: ${entryLines.find((l) => WAIVER.test(l)).trim()}`] });
    else results.push({ name: `mock[${c.id}]`, status: FAIL, details: [`${machine.join(', ')} changed but no code file under the mock path(s) ${c.mocks.join(', ')} changed (Markdown, test files and whitespace-only edits do not count); update the mock or add a line "no mock change: <reason>" to the new changelog entry`] });

    // rule 3: breaking changes against the pull request base
    const cmp = await compareFiles({ root, sha: base.sha, c, bc, getOasdiff });
    if (cmp.errors.length) {
      results.push({ name: `breaking[${c.id}]`, status: FAIL, details: cmp.errors });
    } else if (!cmp.breaking.length) {
      results.push({ name: `breaking[${c.id}]`, status: PASS, details: cmp.notes.length ? cmp.notes : ['no breaking change in the schema or OpenAPI files'] });
    } else {
      const baseMax = maxVersion(sectionVersions(baseSec));
      const headMax = maxVersion(fresh.map((e) => parseVersion(e.heading.match(/^### (\d+\.\d+\.\d+)/)[1])));
      const marked = entryLines.some((l) => /\bBREAKING\b/.test(l));
      const ok = raised(baseMax, headMax);
      if (marked && ok) {
        results.push({ name: `breaking[${c.id}]`, status: PASS, details: [`BREAKING declared in the new entry with a raised version (${headMax.join('.')}):`, ...cmp.breaking.map((b) => `  notice: ${b}`), ...cmp.notes] });
      } else {
        const missing = [!marked && 'a line marked BREAKING in the new entry', !ok && `a new entry whose version is above ${baseMax?.join('.')} ${raiseText(baseMax)} (the newest new entry is ${headMax?.join('.') ?? 'missing'})`].filter(Boolean);
        results.push({ name: `breaking[${c.id}]`, status: FAIL, details: [...cmp.breaking, `needs ${missing.join(' and ')} in the section "${c.changelog}"`] });
      }
    }

    // the same comparison against the latest contracts-v tag
    if (tag?.sha) {
      const since = await compareFiles({ root, sha: tag.sha, c, bc: tagReg?.contracts.find((x) => x.id === c.id), getOasdiff });
      const headMax = maxVersion(sectionVersions(headSec));
      if (since.errors.length) results.push({ name: `breaking-since-tag[${c.id}]`, status: FAIL, details: since.errors });
      else if (!since.breaking.length) results.push({ name: `breaking-since-tag[${c.id}]`, status: PASS, details: [`no breaking change since ${tag.tag}`] });
      else if (raised(tag.version, headMax)) results.push({ name: `breaking-since-tag[${c.id}]`, status: PASS, details: [`breaking since ${tag.tag}, and the changelog version ${headMax.join('.')} is raised ${raiseText(tag.version)}`, ...since.breaking.map((b) => `  notice: ${b}`)] });
      else results.push({ name: `breaking-since-tag[${c.id}]`, status: FAIL, details: [...since.breaking, `breaking since ${tag.tag}: the changelog version must be raised ${raiseText(tag.version)} above ${tag.version.join('.')} (newest entry: ${headMax?.join('.') ?? 'none'})`] });
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
const stripMd = (s) => s.replace(/[*_`]/g, '').trim();
function checkCompat(root, reg, headLog) {
  const text = headText(root, 'contracts/COMPAT.md');
  if (text === null) return { status: NA, details: ['contracts/COMPAT.md does not exist yet'] };
  const tags = new Set(git(root, ['tag', '--list', TAG_GLOB]).split('\n').map((t) => t.trim()).filter(Boolean));
  const problems = [];
  let rows = 0;
  let seenHeader = false;
  text.split('\n').forEach((line, i) => {
    if (!line.trim().startsWith('|')) return;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(stripMd);
    if (!seenHeader) { seenHeader = true; return; }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c) || c === '')) return;
    rows++;
    const c = reg.contracts.find((x) => x.id === cells[0]);
    if (!c) { problems.push(`line ${i + 1}: contract "${cells[0]}" is not in contracts/registry.json`); return; }
    const v = parseVersion((cells[1] ?? '').replace(/^contracts-/, ''));
    if (v.length !== 3) { problems.push(`line ${i + 1}: ${c.id} lists the version "${cells[1] ?? ''}", which is not X.Y.Z`); return; }
    const inLog = sectionVersions(changelogSection(headLog, c.changelog)).some((x) => cmpVersion(x, v) === 0);
    if (!inLog && !tags.has(`contracts-v${v.join('.')}`)) problems.push(`line ${i + 1}: ${c.id} lists version ${v.join('.')}, which is neither a changelog entry nor a tag contracts-v${v.join('.')}`);
  });
  if (problems.length) return { status: FAIL, details: problems };
  return rows ? { status: PASS, details: [`${rows} row(s), every listed version exists`] } : { status: FAIL, details: ['contracts/COMPAT.md has no table row of the form | contract id | version |'] };
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
export async function runRules({ root = REPO_ROOT, base: baseArg, env = process.env, oasdiffBin, skip = [] } = {}) {
  const results = [];
  const push = (name, r) => results.push({ name, ...r });
  const { registry: reg, error } = loadRegistry(root);
  if (error) {
    push('registry', { status: FAIL, details: [error] });
    return results;
  }
  let base;
  try {
    push('registry', checkRegistry(root, reg));
    base = resolveBase(root, { base: baseArg, env });
    if (base.error) {
      push('base', { status: FAIL, details: [base.error] });
    } else {
      const tag = resolveTag(root);
      if (tag?.error) {
        push('base', { status: FAIL, details: [tag.error] });
        base = { ...base, error: tag.error };
      } else {
        let oasdiff;
        // `oasdiffBin` (a path, or a function that returns one) lets the tests stand in for the verified binary.
        const getOasdiff = async () => (oasdiff ??= typeof oasdiffBin === 'function' ? await oasdiffBin() : oasdiffBin ?? (await ensureOasdiff()));
        const changed = changedFiles(root, base.sha);
        push('base', { status: PASS, details: [`compared with ${base.ref} (merge base ${base.sha.slice(0, 10)}); ${changed.size} file(s) differ${tag ? `; breaking changes are also compared with ${tag.tag}` : ''}`] });
        results.push(...(await contractChecks({ root, reg, base, tag, changed, getOasdiff })));
      }
    }
  } catch (e) {
    push('base', { status: FAIL, details: [`git could not give the comparison (${e.message}); ${FULL_HISTORY}`] });
    base = { error: e.message };
  }

  const inBase = (p) => (base?.sha ? existsAt(root, base.sha, p) : false);
  // `skip` exists for the tests of the other rules (the Python runs are slow); the command line never skips.
  if (!skip.includes('table-owners')) push('table-owners', deletedInput(runPythonCheck('table-owners', 'check_table_owners.py', root), inBase('contracts/db/table-owners.yaml'), 'contracts/db/table-owners.yaml', base?.ref));
  if (!skip.includes('alembic')) push('alembic', deletedInput(runPythonCheck('alembic', 'check_alembic_head.py', root), inBase('apps/api/migrations/versions'), 'apps/api/migrations/versions', base?.ref));
  push('compat', deletedInput(checkCompat(root, reg, headText(root, 'contracts/CHANGELOG.md')), inBase('contracts/COMPAT.md'), 'contracts/COMPAT.md', base?.ref));
  const bundleInBase = base?.sha ? !!bundleScript(baseText(root, base.sha, 'package.json')) || inBase('contracts/api/bundle/openapi.json') : false;
  push('bundle', deletedInput(checkBundle(root), bundleInBase, 'the bundle command or contracts/api/bundle/openapi.json', base?.ref));
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
  let results;
  try {
    results = await runRules({ root, base: opt('--base') });
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
