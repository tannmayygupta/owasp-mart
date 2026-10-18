// C10 — Server-Side Request Forgery (OWASP 2021 A10 / 2025 A01), CWE-918.
//
// The product editor's "Import image from URL": the shop fetches a seller-supplied
// URL and shows a preview. This module owns the one place the URL is screened.
//
//   FIXED (default): resolve the host to an IP and refuse any private, loopback or
//     link-local address — so a request that resolves inside the instance network
//     (the metadata service) is blocked however it is written.
//   VULNERABLE (VM_CHALLENGE_C10=vulnerable): a STRING blocklist of a few literal
//     names/addresses. A variant representation (e.g. the decimal form of an IP)
//     is not in the list, so it passes even though it resolves to the metadata
//     service — whose startup data holds the flag, leaked in the "Not an image"
//     error (first 200 characters).
//
// http/https only (so `file://`/`gopher://` cannot read local files); a timeout
// and body cap apply. Fix: an allow-list of image hosts, resolve-then-check the
// final IP (and after redirects), deny internal ranges at the network layer,
// token-based metadata, generic errors, do not return bodies.
import { lookup } from 'node:dns/promises';
import { ValidationError } from '../domain/shop-service.mjs';
import { isVulnerable } from './mode.mjs';

const BLOCKED_STRINGS = ['localhost', '127.0.0.1', '169.254.169.254', 'metadata.vulnmart.internal'];

function privateClass(ip) {
  if (ip.startsWith('127.') || ip === '::1') return 'loopback';
  if (ip.startsWith('169.254.')) return 'link_local';
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return 'private';
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 'private';
  return null;
}

async function resolveIp(host) {
  try { return (await lookup(host.replace(/^\[|\]$/g, ''))).address; } catch { return null; }
}

async function classify(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'public'; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_STRINGS.includes(host)) return host === 'metadata.vulnmart.internal' ? 'internal_name' : 'loopback';
  const ip = await resolveIp(host);
  return (ip && privateClass(ip)) || 'public';
}

// Import an image by URL. Returns { ok, preview | error }. Throws ValidationError
// (-> 400) when the URL is refused.
export async function importImageFromUrl(url, { challenges = {}, emit = () => {}, fetchImpl = fetch } = {}) {
  const raw = String(url ?? '');
  if (!/^https?:\/\//i.test(raw)) {
    emit('importer.fetch_attempt', { url_class: 'bad_scheme', blocked: true, status: 0 });
    throw new ValidationError('only http and https URLs can be imported');
  }
  const url_class = await classify(raw);

  let blocked = false;
  if (isVulnerable('C10', challenges)) {
    // VULNERABLE: a string blocklist — a variant form of a blocked address passes.
    const lower = raw.toLowerCase();
    blocked = BLOCKED_STRINGS.some((s) => lower.includes(s));
  } else {
    // FIXED: resolve the host and block private/loopback/link-local IPs.
    const host = (() => { try { return new URL(raw).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } })();
    const ip = await resolveIp(host);
    blocked = Boolean(ip && privateClass(ip));
  }

  emit('importer.fetch_attempt', { url_class, blocked, status: 0 });
  if (blocked) throw new ValidationError('that address is not allowed');

  // Fetch with a timeout; a 1 MB cap in a real deployment. If the response is not
  // an image, the first 200 characters are shown (this is what leaks the flag).
  let res;
  try { res = await fetchImpl(raw, { signal: AbortSignal.timeout(3000) }); }
  catch (e) { throw new ValidationError(`could not fetch the image (${e?.cause?.code || 'error'})`); }
  const ct = res.headers.get('content-type') || '';
  const body = (await res.text()).slice(0, 200);
  if (ct.startsWith('image/')) return { ok: true, preview: '[image accepted]', content_type: ct };
  return { ok: false, error: `Not an image: ${body}` };
}
