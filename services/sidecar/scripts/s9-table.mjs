// Runs the S-9 channel rows (test/s9-channels.mjs) through the real matcher and writes the table of seen and not seen channels.
// Usage: node services/sidecar/scripts/s9-table.mjs [output.md]    (default docs/assets/story-6-2-sidecar/s9-matcher-channels.md)
// Throw-away flags are made at every run; the table holds no flag value. Exit 1 when a row does not behave as expected.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatcher, SCAN_CAP_BYTES } from '../src/matcher.mjs';
import { CHANNELS } from '../test/s9-channels.mjs';
import { freshValues, startDoc, flagOf } from '../test/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = process.argv[2] ?? path.join(ROOT, 'docs', 'assets', 'story-6-2-sidecar', 's9-matcher-channels.md');

const v = freshValues();
const m = createMatcher(startDoc(v).flag_digests);
const flag = flagOf(v, 'C05');
const rows = [];
let bad = 0;
for (const ch of CHANNELS) {
  const r = ch.build(flag);
  const res = await m.scanResponse(Buffer.from(r.body), r.encoding);
  const seen = res.candidates.some((c) => c.kind === 'real' && c.challenge_key === 'C05');
  const how = res.skipped ? `skipped: ${res.skipped}` : (seen ? 'candidate found, class real' : 'no candidate');
  if (seen !== ch.seen) bad += 1;
  rows.push(`| ${ch.label} | ${ch.seen ? 'seen' : 'not seen'} | ${seen ? 'seen' : 'not seen'} | ${how} | ${seen === ch.seen ? 'ok' : 'MISMATCH'} |`);
}

const text = `# Spike S-9: what the sidecar matcher sees (story 6.2, task L-20)

Question: does the matcher see a flag through JSON escaping and gzip, and which channels can it not see?

Method: each row builds one response that carries one real flag (a throw-away value made for this run) in one channel, and runs it through the
matcher the sidecar uses (\`services/sidecar/src/matcher.mjs\`): content-encoding is undone (gzip, deflate, brotli), then JSON string escapes, HTML
entities and percent encoding are undone in every chain of up to three layers, then \`VM{[A-Z2-7]{24}}\` is searched and each distinct hit is hashed
with SHA-256 and looked up in the digest set. The scan copy is bounded at ${SCAN_CAP_BYTES} bytes (1 MiB); a decoded size above 4 MiB is not scanned.
The same rows run end to end through the player port in \`services/sidecar/test/sidecar.test.mjs\` (bytes to the player are compared too).
This table is produced by \`node services/sidecar/scripts/s9-table.mjs\`.

| Channel | Expected | Result | Detail | Verdict |
|---|---|---|---|---|
${rows.join('\n')}

Not seen channels use paste (FR-FLG-06): the player pastes the flag into the shop and the platform checks it. A response over another protocol (for
example a WebSocket after an upgrade) does not pass the matcher at all. Rows are results of a local run on one machine; the unit of the claim is
this matcher code, not a measurement of the real shop's pages (the shop owns where flags appear).
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
console.log(`wrote ${path.relative(ROOT, out)}; ${CHANNELS.length} rows, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
