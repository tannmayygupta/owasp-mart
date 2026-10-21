#!/usr/bin/env node
// Fails when too many pytest tests were skipped because a service was missing (the wiring audit of 2026-10-21: the `scripts` CI job skipped the 15 *_postgres modules
// silently, and no CI job had Valkey). Reads the junit file that pytest writes (`--junitxml`) and counts the skips whose reason names a test service variable
// (`needs VULNMART_TEST_POSTGRES_DSN ...`, `needs VULNMART_TEST_VALKEY_URL`); other skips (no node, Windows) are not counted.
//   node scripts/check-pytest-skips.mjs --junit <file> --max-env-skips <n> [--label <text>]
// `api` job (Postgres and Valkey are running): --max-env-skips 0, so a database test can never be skipped there.
// `scripts` job (no service): the number of skips that is normal today, so a new *_postgres module that is skipped is still fine but a jump (a service variable broken, a
// whole folder skipped) is caught; raise the number only together with the tests it counts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_SKIP = /VULNMART_TEST_[A-Z_]+/;

/** Every `<skipped>` element of a junit file: { message }. The XML pytest writes is flat, so a regular expression is enough. */
export function skipsOf(xml) {
  const out = [];
  for (const m of xml.matchAll(/<skipped\b([^>]*?)(?:\/>|>)/g)) {
    const msg = /\bmessage="([^"]*)"/.exec(m[1]);
    out.push({ message: msg ? msg[1] : '' });
  }
  return out;
}

export function summarize(xml) {
  const skips = skipsOf(xml);
  const env = skips.filter((s) => ENV_SKIP.test(s.message));
  const tests = Number(/\btests="(\d+)"/.exec(xml)?.[1] ?? 0);
  const byService = {};
  for (const s of env) { const v = ENV_SKIP.exec(s.message)[0]; byService[v] = (byService[v] ?? 0) + 1; }
  return { tests, skipped: skips.length, envSkipped: env.length, byService };
}

export function parseArgs(argv) {
  const o = { junit: null, max: null, label: 'pytest' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--junit') o.junit = argv[++i];
    else if (a === '--max-env-skips') o.max = Number(argv[++i]);
    else if (a === '--label') o.label = argv[++i];
    else return { error: `unknown argument ${a}` };
  }
  if (!o.junit) return { error: '--junit <file> is required' };
  if (!Number.isInteger(o.max) || o.max < 0) return { error: '--max-env-skips is a whole number, 0 or more' };
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  if (o.error) { console.error(o.error); return 2; }
  let xml;
  try { xml = fs.readFileSync(o.junit, 'utf8'); } catch { console.error(`cannot read ${o.junit}`); return 2; }
  const s = summarize(xml);
  if (s.tests === 0) { console.error(`${o.label}: the junit file has no tests (did pytest run?)`); return 1; }
  const detail = Object.entries(s.byService).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none';
  console.log(`${o.label}: ${s.tests} tests, ${s.skipped} skipped, ${s.envSkipped} skipped for a missing service (${detail}); allowed ${o.max}`);
  if (s.envSkipped > o.max) {
    console.error(`FAIL ${o.label}: ${s.envSkipped} tests were skipped for a missing service, more than the ${o.max} allowed`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
