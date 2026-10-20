// Story 1.9 (deferred items A2, B3 of the platform): apps/web keeps its own pnpm-lock.yaml (its container installs from it alone) and the root lockfile holds the same
// app as the importer `apps/web`. Both must resolve the same versions, or the container and CI build different dashboards.
//   node --test scripts/web-lockfile-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// pnpm may write more than one document (its own environment first, which has importers too): the lockfile proper is the last one.
const read = (file) => yaml.loadAll(fs.readFileSync(path.join(ROOT, file), 'utf8')).findLast((d) => d && d.importers);

test('the web lockfile and the root lockfile resolve the same direct dependencies of apps/web', () => {
  const web = read('apps/web/pnpm-lock.yaml').importers['.'];
  const root = read('pnpm-lock.yaml').importers['apps/web'];
  assert.ok(web && root, 'both lockfiles have the apps/web importer');
  assert.deepEqual(web, root);
});

test('every package the web lockfile resolves is resolved at the same version in the root lockfile', () => {
  const web = Object.keys(read('apps/web/pnpm-lock.yaml').packages ?? {});
  const root = new Set(Object.keys(read('pnpm-lock.yaml').packages ?? {}));
  assert.ok(web.length > 0);
  assert.deepEqual(web.filter((p) => !root.has(p)), [], 'packages only in apps/web/pnpm-lock.yaml (the lockfiles drifted apart)');
});
