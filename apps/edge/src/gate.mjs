// The gate: one decision per request (contracts/edge/gate-ticket.md section 6). No sockets here; the caller proxies on "forward".
// createGate({ keys, zone, now, store }) returns { decide(req), store }.
//   req = { method, url (path and query), headers (lower-case names, as Node gives them) }
//   decide returns { type: 'respond', status, headers, body } or { type: 'forward', upstream, cookie } (cookie: the Cookie header to send on, or undefined).
// Order: host rule, state lookup, /_vm/ paths, cookie check, allow. Anything unexpected is refused (fail closed).
import { COOKIE_NAME, JTI_RE, checkKeys, cookieHeader, safeEqual, signCookie, verifyCookie, verifyTicket } from './tickets.mjs';
import { checkZone, createStore, instanceLabelFromHost } from './state.mjs';

export const MAX_USED_TICKETS = 10000;
const MAX_TICKET_CHARS = 1024;
const MAX_URL_CHARS = 8192;

const page = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>${title}</h1><p>${text}</p></body></html>\n`;
const PAGES = {
  ended: page('This lab has ended', 'This lab instance is no longer available.'),
  paused: page('This lab is paused', 'This lab instance is paused. Try again from the platform.'),
  denied: page('This link is not valid', 'Open the lab again from the platform.'),
  notfound: page('Not found', 'There is nothing here.'),
};
const STATUS = { ended: 410, paused: 423, denied: 403, notfound: 404 };
const respond = (kind) => ({
  type: 'respond',
  status: STATUS[kind],
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  body: PAGES[kind],
});

// The path as the edge and the shop could read it: percent-decoded, backslashes as slashes, dot segments resolved, slashes collapsed.
function normalisePath(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const out = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}
const isReserved = (norm) => norm.toLowerCase() === '/_vm' || norm.toLowerCase().startsWith('/_vm/');

/** The value of the gate cookie in a Cookie header; { value } or { value: null } (absent) or { ambiguous: true } (the name twice). */
function gateCookie(header) {
  if (typeof header !== 'string') return { value: null };
  let value = null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      if (value !== null) return { ambiguous: true };
      value = part.slice(i + 1).trim();
    }
  }
  return { value };
}

/** The Cookie header without the gate cookie (other cookies stay in their order); undefined when nothing is left. */
export function stripGateCookie(header) {
  if (typeof header !== 'string') return undefined;
  const kept = header.split(';').filter((part) => {
    const i = part.indexOf('=');
    return !(i >= 0 && part.slice(0, i).trim() === COOKIE_NAME);
  }).map((s) => s.trim()).filter(Boolean);
  return kept.length ? kept.join('; ') : undefined;
}

export const upstreamName = (rec) => `vm-${rec.instance_id.toLowerCase()}-e${rec.epoch}-sidecar:8080`;

export function createGate({ keys, zone, now = () => Date.now(), store } = {}) {
  checkKeys(keys);
  checkZone(zone);
  const state = store ?? createStore({ zone });
  const used = new Map(); // jti -> exp (seconds); kept until exp
  const nowS = () => Math.floor(now() / 1000);

  function purge(t) {
    for (const [jti, exp] of used) if (exp <= t) used.delete(jti);
  }

  // The same claims check for ticket and cookie against the record; every comparison is constant time.
  const bound = (claims, rec) => {
    const a = safeEqual(claims.inst, rec.instance_id);
    const b = safeEqual(claims.own, rec.owner);
    const c = safeEqual(String(claims.ae), String(rec.access_epoch));
    return a && b && c;
  };

  function enter(query, rec) {
    const params = new URLSearchParams(query);
    const all = params.getAll('t');
    if (all.length !== 1 || all[0].length === 0) return respond('notfound');
    const token = all[0];
    if (token.length > MAX_TICKET_CHARS) return respond('denied');
    const t = nowS();
    const v = verifyTicket(keys, token, t);
    if (!v.ok || !bound(v.claims, rec) || !JTI_RE.test(v.claims.jti)) return respond('denied');
    purge(t);
    if (used.has(v.claims.jti)) return respond('denied');
    if (used.size >= MAX_USED_TICKETS) return respond('denied'); // full: refuse rather than forget an id (fail closed)
    used.set(v.claims.jti, v.claims.exp);
    return {
      type: 'respond',
      status: 302,
      headers: {
        location: '/',
        'set-cookie': cookieHeader(signCookie(keys, { inst: rec.instance_id, own: rec.owner, ae: rec.access_epoch })),
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      },
      body: '',
    };
  }

  function decideUnsafe(req) {
    const headers = req?.headers ?? {};
    // 1. host rule: only the Host header counts (never X-Forwarded-Host); anything else looks like an unknown instance
    const label = instanceLabelFromHost(headers.host, zone);
    if (label === null) return respond('ended');
    // 2. state: unknown and closed are the same answer; frozen never reaches the shop
    const rec = state.get(label);
    if (!rec || rec.access === 'closed') return respond('ended');
    if (rec.access === 'frozen') return respond('paused');
    // 3. /_vm/ is reserved for the gate: only GET /_vm/enter?t=... exists
    const url = req.url;
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS || !url.startsWith('/')) return respond('notfound');
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
    const query = q < 0 ? '' : url.slice(q + 1);
    const norm = normalisePath(pathname);
    if (norm === null) return respond('notfound');
    if (isReserved(norm)) {
      if (req.method === 'GET' && pathname === '/_vm/enter') return enter(query, rec);
      return respond('notfound');
    }
    // 4. cookie
    const c = gateCookie(headers.cookie);
    if (c.ambiguous || c.value === null) return respond('denied');
    const v = verifyCookie(keys, c.value);
    if (!v.ok || !bound(v.claims, rec)) return respond('denied');
    // 5. allow: the upstream name comes only from validated fields; the gate cookie never reaches the shop
    return { type: 'forward', upstream: upstreamName(rec), cookie: stripGateCookie(headers.cookie) };
  }

  return {
    store: state,
    usedTickets: () => used.size,
    decide(req) {
      try {
        return decideUnsafe(req);
      } catch {
        return respond('denied');
      }
    },
  };
}
