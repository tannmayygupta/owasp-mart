// Cross-challenge independence (T-31, FR-CHL-16): solving one challenge must not
// capture another's flag. Each challenge keys its flag to its own source — a
// distinct sentinel key, or a field only its own path reads — and the per-challenge
// self-tests already prove each exploit reads only its own marker and that a fixed
// build is not exploitable. This file adds the structural guarantee: no challenge
// module reads another challenge's sentinel flag, the sentinel keys are distinct,
// and the release gate covers all eleven challenges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { challengeTests } from '../../scripts/release-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CH_DIR = path.resolve(HERE, '..', '..', 'apps', 'shop', 'src', 'challenges');

test('no challenge module reads another challenge\'s sentinel flag', () => {
  const files = readdirSync(CH_DIR).filter((f) => /^c\d\d.*\.mjs$/.test(f));
  const used = [];
  for (const f of files) {
    const num = f.slice(0, 3); // c01, c03a -> c03, etc.
    const src = readFileSync(path.join(CH_DIR, f), 'utf8');
    const keys = [...src.matchAll(/sentinel\s+WHERE\s+key\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    for (const k of keys) {
      assert.equal(k, num, `${f} reads sentinel '${k}' but may only read its own '${num}'`);
      used.push(k);
    }
  }
  assert.equal(new Set(used).size, used.length, `sentinel keys must be distinct per challenge (saw ${used.join(', ')})`);
});

test('the release gate covers all eleven challenges (C01–C11)', () => {
  const keys = challengeTests().map((t) => t.key);
  for (const n of ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11']) {
    assert.ok(keys.includes(n), `release gate is missing a self-test for ${n}`);
  }
});
