// Route templates and method classes for the events (IF-4 proxy.request, proxy.flag_seen). A template holds no value: every path segment
// that has a digit in it (all digits, a UUID, an order number) or looks like a flag becomes {id}; the query string is dropped; at most
// 200 characters. This is what makes the aggregate of proxy.request small and keeps player data out of the event.
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// The text rule of the event schema ($defs/text200): a string with this in it is refused by the ingest.
const FLAGGY = /[Vv][Mm](?:\{|%7[Bb]|｛)/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const methodClass = (m) => (METHODS.has(m) ? m : 'other');

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function routeTemplate(rawUrl) {
  let p = String(rawUrl || '/');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) { try { p = new URL(p).pathname; } catch { return '/{other}'; } }
  p = p.split('?')[0].split('#')[0];
  if (p === '*') return '*';
  if (!p.startsWith('/')) return '/{other}';
  const segs = p.split('/').slice(1).map((seg) => {
    if (seg === '') return seg;
    const d = safeDecode(seg);
    if (/\d/.test(d) || UUID.test(d) || FLAGGY.test(seg) || FLAGGY.test(d)) return '{id}';
    return seg.length > 40 ? '{id}' : seg;
  });
  let out = '/' + segs.join('/');
  if (out.length > 200) out = out.slice(0, 200).replace(/\/[^/]*$/, '') || '/';
  return FLAGGY.test(out) ? '/{redacted}' : out;
}
