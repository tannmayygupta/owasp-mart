// The build id and the catalogue version that GET /version reports (deferred work of the first shop review: nothing stamped a real build id, so /version was always "dev").
//
// Neither name is on the instance contract's environment allowlist (section 2), so the image does not carry them as environment variables. The Dockerfile writes them into plain
// files at build time (`--build-arg VM_BUILD_ID=<git sha or release label>`, `--build-arg VM_CATALOG_VERSION=<catalogue version>`) and the shop reads the files. An environment
// value, when one is set (tests, a local run), wins; with neither the answer is "dev". A value is used only when it is a plain token: 1 to 64 of letters, digits, `.`, `_`, `-`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // /app in the image, apps/shop in the repository
const TOKEN = /^[A-Za-z0-9._-]{1,64}$/;

function fromFile(file, readFile) {
  try {
    const text = String(readFile(file, 'utf8')).trim();
    return TOKEN.test(text) ? text : null;
  } catch {
    return null;
  }
}

export function resolveStamp(envName, fileName, { env = process.env, readFile = fs.readFileSync, root = ROOT } = {}) {
  const fromEnv = env[envName];
  if (typeof fromEnv === 'string' && TOKEN.test(fromEnv)) return fromEnv;
  return fromFile(path.join(root, fileName), readFile) ?? 'dev';
}

export const buildId = (opts) => resolveStamp('VM_BUILD_ID', 'BUILD_ID', opts);
export const catalogueVersion = (opts) => resolveStamp('VM_CATALOG_VERSION', 'CATALOG_VERSION', opts);