#!/usr/bin/env node
// Builds release.json, the release manifest (story L-12): one digest reference per image and the commit.
// Usage: node scripts/images-release.mjs --digests <dir> --commit <sha> --repo <owner/name> --out <file>
// <dir> holds one file per image named <image>.digest whose content is the digest of the merged image index (sha256:<64 hex>).
// Exit 1 when an image of infra/images.json has no valid digest.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImages, validateImages } from './images-matrix.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `digests` maps image name to digest. Throws when one is missing or malformed. Image names are lower-cased owner/repo as GHCR needs. */
export function buildRelease(data, digests, { commit, repo }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('commit must be a 40-character hex sha');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('repo must be owner/name');
  const images = {};
  const healthchecks = {};
  for (const img of data.images) {
    const d = digests[img.name];
    if (!DIGEST.test(d ?? '')) throw new Error(`no valid digest for image "${img.name}"`);
    images[img.name] = `${data.registry}/${repo.toLowerCase()}/${img.name}@${d}`;
    // The orchestrator consumes a per-role healthcheck argv for images without a
    // shell (distroless); it is optional, so only images that declare one appear.
    if (img.healthcheck) healthchecks[img.name] = img.healthcheck;
  }
  const release = { commit, repo: repo.toLowerCase(), images }; // the repository is recorded so that deploy can check the image path against it
  if (Object.keys(healthchecks).length) release.healthchecks = healthchecks;
  return release;
}

export const USAGE = 'usage: node scripts/images-release.mjs --digests <dir> --commit <sha> --repo <owner/name> --out <file>';

export function main(argv, err = console.error, log = console.log) {
  const get = (n) => {
    const i = argv.indexOf(`--${n}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v === undefined || v.startsWith('--') ? undefined : v;
  };
  const missing = ['digests', 'commit', 'repo', 'out'].filter((n) => !get(n));
  if (missing.length) {
    err(`error: missing ${missing.map((n) => `--${n}`).join(', ')}`);
    err(USAGE);
    return 2;
  }
  try {
    const data = loadImages();
    const problems = validateImages(data);
    if (problems.length) throw new Error(problems.join('; '));
    const dir = get('digests');
    const digests = {};
    for (const img of data.images) {
      const f = path.join(dir, `${img.name}.digest`);
      if (existsSync(f)) digests[img.name] = readFileSync(f, 'utf8').trim();
    }
    const release = buildRelease(data, digests, { commit: get('commit'), repo: get('repo') });
    writeFileSync(get('out'), `${JSON.stringify(release, null, 2)}\n`);
    log(`release manifest written for ${Object.keys(release.images).length} image(s)`);
    return 0;
  } catch (e) {
    err(`FAIL ${e.message}`);
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
