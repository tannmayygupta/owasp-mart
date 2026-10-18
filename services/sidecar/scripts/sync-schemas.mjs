// Copies the four contract schemas the sidecar needs into services/sidecar/schemas, because the image build context is services/sidecar
// only (infra/images.json). The contracts stay the source of truth: test/schemas.test.mjs fails when a copy differs by one byte.
// Usage: node services/sidecar/scripts/sync-schemas.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
export const SCHEMA_FILES = [
  ['contracts/events/instance-events.schema.json', 'instance-events.schema.json'],
  ['contracts/events/instance-events.posted.schema.json', 'instance-events.posted.schema.json'],
  ['contracts/instance/sidecar-start.schema.json', 'sidecar-start.schema.json'],
];

if (import.meta.main) {
  const out = path.join(HERE, '..', 'schemas');
  fs.mkdirSync(out, { recursive: true });
  for (const [from, to] of SCHEMA_FILES) fs.copyFileSync(path.join(ROOT, from), path.join(out, to));
  console.log(`copied ${SCHEMA_FILES.length} schemas to services/sidecar/schemas`);
}
