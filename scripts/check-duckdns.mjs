// Spike S-16: does a random label under a DuckDNS name resolve like the name itself (wildcard A or AAAA record)? Run from the developer's PC (no credentials, a few DNS lookups).
// Prints "match" or "no match" and never the address. Exit 0 on match, 1 on no match, 2 on bad usage.
// Usage: node scripts/check-duckdns.mjs <labs-name>.duckdns.org [--label <label>]
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = 'usage: node scripts/check-duckdns.mjs <name>.duckdns.org [--label <label>]';
// The same shape as the host script (infra/hosts/vulnmart-certs.sh): one lowercase label before .duckdns.org.
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.duckdns\.org$/;
const LABEL_RE = /^[a-z0-9-]{1,63}$/;
export const validName = (n) => typeof n === 'string' && n.length <= 253 && NAME_RE.test(n);
export const validLabel = (l) => typeof l === 'string' && LABEL_RE.test(l);

/** Default resolver with a time limit: family 4 asks A records, family 6 asks AAAA records. */
export function makeResolver(timeoutMs = 4000) {
  const r = new Resolver({ timeout: timeoutMs, tries: 1 });
  return (host, family) => (family === 6 ? r.resolve6(host) : r.resolve4(host));
}

/** @param {{name: string, resolve?: (host: string, family: 4 | 6) => Promise<string[]>, label?: string}} o */
export async function checkWildcard({ name, resolve = makeResolver(), label = `s16-${randomBytes(4).toString('hex')}` }) {
  if (!validName(name)) return { ok: false, code: 2, message: `refused name: ${name} (expected <x>.duckdns.org)\n${USAGE}` };
  if (!validLabel(label)) return { ok: false, code: 2, message: `refused label: ${label} (1 to 63 of a-z, 0-9, -)\n${USAGE}` };
  const settle = async (host, family) => {
    try {
      const a = await resolve(host, family);
      return Array.isArray(a) ? a.slice().sort() : [];
    } catch (e) {
      return { error: e?.code ?? e?.name ?? 'error' };
    }
  };
  const seen = { base: false, probe: false };
  const errors = [];
  for (const family of [4, 6]) {
    const base = await settle(name, family);
    const probe = await settle(`${label}.${name}`, family);
    if (Array.isArray(base) && base.length) seen.base = true;
    else if (base.error) errors.push(base.error);
    if (Array.isArray(probe) && probe.length) seen.probe = true;
    else if (probe.error) errors.push(probe.error);
    if (Array.isArray(base) && Array.isArray(probe) && base.length && base.length === probe.length && base.every((a, i) => a === probe[i])) {
      return { ok: true, code: 0, message: `match: a random label resolves to the same ${family === 6 ? 'AAAA' : 'A'} record as the name` };
    }
  }
  if (!seen.base) return { ok: false, code: 1, message: `no match: the name itself does not resolve (${errors[0] ?? 'no answer'})` };
  if (!seen.probe) return { ok: false, code: 1, message: `no match: a random label does not resolve (${errors.find(Boolean) ?? 'no answer'})` };
  return { ok: false, code: 1, message: 'no match: a random label resolves to a different address than the name' };
}

/** Command line: the name is the first argument that is not an option or an option value; --label is read by flag only. */
export function parseCli(args) {
  let label;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) return { error: '--label needs a value' };
      label = args[++i];
    } else if (args[i].startsWith('--')) return { error: `unknown option: ${args[i]}` };
    else rest.push(args[i]);
  }
  if (rest.length !== 1) return { error: rest.length ? 'only one name is accepted' : 'a name is required' };
  return { name: rest[0], ...(label === undefined ? {} : { label }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.error) {
    console.error(`${cli.error}\n${USAGE}`);
    process.exit(2);
  }
  const r = await checkWildcard(cli);
  console.log(r.message);
  process.exit(r.code);
}
