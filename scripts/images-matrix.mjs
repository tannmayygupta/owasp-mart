#!/usr/bin/env node
// The image build matrix (story L-12, ADR 0011 and 0032). One data file, infra/images.json, lists the images; adding an image is one entry.
// Usage: node scripts/images-matrix.mjs [--arm64]     prints {"include":[...]} as one JSON line (the CI matrix); BUILD_ARM64=true does the same as --arm64.
// Exit 1 on an invalid file or entry. Node built-ins only.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IMAGES_FILE = path.join(ROOT, 'infra', 'images.json');
export const PLATFORMS = { 'linux/amd64': { runner: 'ubuntu-24.04', suffix: 'amd64' }, 'linux/arm64': { runner: 'ubuntu-24.04-arm', suffix: 'arm64' } };
const KEYS = ['name', 'context', 'dockerfile', 'platforms', 'public'];
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REGISTRY = /^[a-z0-9.-]+$/;

const badPath = (p) => typeof p !== 'string' || p === '' || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '');

/** Returns a list of problems (empty when valid). `exists(relPath)` is optional: when given, context and dockerfile must exist. */
export function validateImages(data, exists) {
  const errs = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['the file must be an object'];
  for (const k of Object.keys(data)) if (!['registry', 'images'].includes(k)) errs.push(`unknown key "${k}"`);
  if (typeof data.registry !== 'string' || !REGISTRY.test(data.registry)) errs.push('registry must be a host name such as ghcr.io');
  if (!Array.isArray(data.images) || data.images.length === 0) return [...errs, 'images must be a non-empty list'];
  const seen = new Set();
  data.images.forEach((img, i) => {
    const at = `images[${i}]`;
    if (!img || typeof img !== 'object' || Array.isArray(img)) return errs.push(`${at} must be an object`);
    for (const k of Object.keys(img)) if (!KEYS.includes(k)) errs.push(`${at}: unknown key "${k}"`);
    for (const k of KEYS) if (!(k in img)) errs.push(`${at}: missing "${k}"`);
    if ('name' in img) {
      if (typeof img.name !== 'string' || !NAME.test(img.name)) errs.push(`${at}: name must be lower-case letters, digits and dashes`);
      else if (seen.has(img.name)) errs.push(`${at}: duplicate name "${img.name}"`);
      else seen.add(img.name);
    }
    for (const k of ['context', 'dockerfile']) {
      if (!(k in img)) continue;
      if (badPath(img[k])) errs.push(`${at}: ${k} must be a relative path inside the repository (no "..", no backslash)`);
      else if (exists && !exists(img[k])) errs.push(`${at}: ${k} "${img[k]}" does not exist`);
    }
    if ('platforms' in img) {
      if (!Array.isArray(img.platforms) || img.platforms.length === 0 || img.platforms.some((p) => !PLATFORMS[p]) || new Set(img.platforms).size !== img.platforms.length) errs.push(`${at}: platforms must be a non-empty list without repeats from ${Object.keys(PLATFORMS).join(', ')}`);
    }
    if ('public' in img && typeof img.public !== 'boolean') errs.push(`${at}: public must be true or false`);
  });
  return errs;
}

/** One matrix row per image and platform; arm64 rows only when `arm64` is true (repository variable BUILD_ARM64, default off). */
export function buildMatrix(data, { arm64 = false } = {}) {
  const include = [];
  for (const img of data.images) {
    for (const platform of img.platforms) {
      if (platform === 'linux/arm64' && !arm64) continue;
      const p = PLATFORMS[platform];
      include.push({ name: img.name, context: img.context, dockerfile: img.dockerfile, platform, arch: p.suffix, runner: p.runner, public: img.public });
    }
  }
  return { include };
}

export function loadImages(file = IMAGES_FILE) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function main(argv, env, out = console.log, err = console.error) {
  let data;
  try {
    data = loadImages();
  } catch (e) {
    err(`FAIL cannot read infra/images.json: ${e.message}`);
    return 1;
  }
  const problems = validateImages(data, (p) => existsSync(path.join(ROOT, p)));
  if (problems.length) {
    for (const p of problems) err(`FAIL ${p}`);
    return 1;
  }
  out(JSON.stringify(buildMatrix(data, { arm64: argv.includes('--arm64') || env.BUILD_ARM64 === 'true' })));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env);
