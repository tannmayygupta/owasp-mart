// Rules that JSON Schema cannot express, shared by scripts/validate-contracts.mjs (the contract check) and the stub instance (inject.mjs,
// sidecar.mjs), so the stub can never accept a document the contract calls bad. Pure functions, no dependency. Each returns [{ path, message }].
export function dupes(arr, key, base, label, out) {
  const seen = new Set();
  arr.forEach((x, i) => {
    const v = key(x);
    if (seen.has(v)) out.push({ path: `${base}/${i}${label}`, message: `duplicate ${v}` });
    seen.add(v);
  });
}

export function semanticInjection(d) {
  const out = [];
  dupes(d.flags, (f) => f.challenge_key, '/flags', '/challenge_key', out);
  const flagValues = new Set(d.flags.map((f) => f.flag));
  d.decoys.forEach((x, i) => {
    if (flagValues.has(x.value)) out.push({ path: `/decoys/${i}/value`, message: 'a decoy must not equal a real flag' });
  });
  dupes(d.decoys, (x) => `${x.challenge_key}#${x.index}`, '/decoys', '/index', out);
  dupes(d.flags, (f) => f.flag, '/flags', '/flag', out);
  dupes(d.decoys, (x) => x.value, '/decoys', '/value', out);
  const keys = new Set(d.flags.map((f) => f.challenge_key));
  d.decoys.forEach((x, i) => {
    if (!keys.has(x.challenge_key)) out.push({ path: `/decoys/${i}/challenge_key`, message: 'a decoy needs a flag for the same challenge key' });
  });
  return out;
}

export function semanticSidecarStart(d) {
  const out = [];
  dupes(d.flag_digests, (x) => x.sha256, '/flag_digests', '/sha256', out);
  const realKeys = new Set();
  d.flag_digests.forEach((x, i) => {
    if (x.kind !== 'real') return;
    if (realKeys.has(x.challenge_key)) out.push({ path: `/flag_digests/${i}/challenge_key`, message: `duplicate real digest for ${x.challenge_key}` });
    realKeys.add(x.challenge_key);
  });
  return out;
}
