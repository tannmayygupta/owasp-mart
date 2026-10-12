// Generates the Python and TypeScript error constants (IF-8) from contracts/errors/error-codes.yaml.
//   packages/py-models/src/vulnmart_models/error_codes.py
//   packages/ts-client/src/error-codes.ts
// Usage: node scripts/generate-error-codes.mjs [--check] [--dir <contracts/errors>] [--py <file>] [--ts <file>] [--help]
//   (no flag)  write both files
//   --check    write nothing; exit 1 when a file differs from what the registry produces (used by CI)
// The registry is validated first: nothing is generated from an invalid registry.
// Exit code 0 when done or current, 1 when a file is stale or the registry is invalid, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIR, TYPE_PREFIX, loadRegistry, validateDir } from './validate-errors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PY = path.join(ROOT, 'packages', 'py-models', 'src', 'vulnmart_models', 'error_codes.py');
export const DEFAULT_TS = path.join(ROOT, 'packages', 'ts-client', 'src', 'error-codes.ts');
export const HELP = `Generate the error constants (IF-8)
Usage: node scripts/generate-error-codes.mjs [--check] [--dir <contracts/errors>] [--py <file>] [--ts <file>] [--help]
Exit code 0 when done or current, 1 when a file is stale or the registry is invalid, 2 on a usage error.`;

const q = (s) => JSON.stringify(s); // titles are plain ASCII, so a JSON string is also a valid Python and TypeScript literal
const ident = (code) => code.replace(/-/g, '_');
const none = (v) => (v === null || v === undefined ? 'None' : String(v));
const nul = (v) => (v === null || v === undefined ? 'null' : String(v));

export function renderPython(reg) {
  const lines = [
    '"""GENERATED from contracts/errors/error-codes.yaml. Do not edit: run `node scripts/generate-error-codes.mjs`.',
    '',
    `Error registry (IF-8) version ${reg.registry_version}.`,
    '"""',
    '',
    'from dataclasses import dataclass',
    'from enum import StrEnum',
    '',
    `REGISTRY_VERSION = ${q(reg.registry_version)}`,
    `PROBLEM_TYPE_PREFIX = ${q(TYPE_PREFIX)}`,
    '',
    '',
    'class ErrorCode(StrEnum):',
    ...reg.codes.map((c) => `    ${ident(c.code)} = ${q(c.code)}`),
    '',
    '',
    '@dataclass(frozen=True)',
    'class ErrorInfo:',
    '    code: ErrorCode',
    '    status: int | None  # HTTP status, or None when the code is never sent as an HTTP answer',
    '    title: str  # the fixed, generic text sent to clients',
    '    retryable: bool',
    '    exit_code: int | None = None',
    '',
    '',
    'ERRORS: dict[ErrorCode, ErrorInfo] = {',
    ...reg.codes.map((c) => {
      const id = `ErrorCode.${ident(c.code)}`;
      const exit = c.exit_code === undefined ? '' : `, exit_code=${c.exit_code}`;
      return `    ${id}: ErrorInfo(${id}, ${none(c.status)}, ${q(c.title)}, ${c.retryable ? 'True' : 'False'}${exit}),`;
    }),
    '}',
    '',
    '',
    'def problem_type(code: ErrorCode) -> str:',
    '    """The `type` member of an error body for this code."""',
    '    return PROBLEM_TYPE_PREFIX + code.value',
    '',
  ];
  return lines.join('\n');
}

export function renderTypeScript(reg) {
  const lines = [
    '// GENERATED from contracts/errors/error-codes.yaml. Do not edit: run `node scripts/generate-error-codes.mjs`.',
    `// Error registry (IF-8) version ${reg.registry_version}.`,
    '',
    `export const REGISTRY_VERSION = ${q(reg.registry_version)};`,
    `export const PROBLEM_TYPE_PREFIX = ${q(TYPE_PREFIX)};`,
    '',
    'export const ERROR_CODES = {',
    ...reg.codes.map((c) => `  ${ident(c.code)}: ${q(c.code)},`),
    '} as const;',
    '',
    'export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];',
    '',
    'export interface ErrorInfo {',
    '  /** HTTP status, or null when the code is never sent as an HTTP answer. */',
    '  readonly status: number | null;',
    '  /** The fixed, generic text sent to clients. */',
    '  readonly title: string;',
    '  readonly retryable: boolean;',
    '  readonly exitCode?: number;',
    '}',
    '',
    'export const ERRORS: Readonly<Record<ErrorCode, ErrorInfo>> = {',
    ...reg.codes.map((c) => {
      const exit = c.exit_code === undefined ? '' : `, exitCode: ${c.exit_code}`;
      return `  ${q(c.code)}: { status: ${nul(c.status)}, title: ${q(c.title)}, retryable: ${c.retryable ? 'true' : 'false'}${exit} },`;
    }),
    '};',
    '',
    '/** The `type` member of an error body for this code. */',
    'export function problemType(code: ErrorCode): string {',
    '  return PROBLEM_TYPE_PREFIX + code;',
    '}',
    '',
  ];
  return lines.join('\n');
}

const normalise = (s) => s.replace(/\r\n/g, '\n');

export function run({ check, dir, py, ts }, { log = console.log, err = console.error } = {}) {
  const { problems } = validateDir(dir);
  if (problems.length) {
    err('The registry is not valid, nothing was generated:');
    for (const p of problems) err(`  - ${p}`);
    return 1;
  }
  const reg = loadRegistry(dir);
  const targets = [
    [py, renderPython(reg)],
    [ts, renderTypeScript(reg)],
  ];
  let stale = 0;
  for (const [file, content] of targets) {
    const rel = path.relative(ROOT, file);
    const current = fs.existsSync(file) ? normalise(fs.readFileSync(file, 'utf8')) : null;
    if (check) {
      if (current !== content) { err(`STALE: ${rel} does not match the registry. Run: node scripts/generate-error-codes.mjs`); stale++; }
      continue;
    }
    if (current === content) { log(`unchanged ${rel}`); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    log(`wrote ${rel}`);
  }
  if (check) {
    if (stale) return 1;
    log(`OK: generated files are current (${reg.codes.length} codes).`);
  }
  return 0;
}

export function main(argv = process.argv.slice(2), io = {}) {
  const opts = { check: false, dir: DEFAULT_DIR, py: DEFAULT_PY, ts: DEFAULT_TS };
  const err = io.err || console.error;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { (io.log || console.log)(HELP); return 0; }
    if (a === '--check') { opts.check = true; continue; }
    if (['--dir', '--py', '--ts'].includes(a)) {
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
