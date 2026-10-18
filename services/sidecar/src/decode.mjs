// Decoding for the flag matcher (D-73, spike S-9): content-encoding (gzip, deflate, brotli) and the text layers a response can hide a flag
// in (JSON string escapes, HTML entities, percent encoding). All of it works on the scan COPY, never on the bytes the player gets.
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const gunzip = promisify(zlib.gunzip);
const brotli = promisify(zlib.brotliDecompress);

export const SUPPORTED_ENCODINGS = ['identity', 'gzip', 'x-gzip', 'deflate', 'br'];

// Undoes a content-encoding header (a list is undone from the last coding to the first). `maxOut` bounds the decoded size, so a small
// response that expands enormously cannot use the memory of the sidecar. Resolves { ok: true, buf } or { ok: false, reason } with a fixed
// reason word: "unsupported" (an encoding it cannot decode, for example zstd), "too_big" or "decode_error".
export async function decodeBody(buf, contentEncoding, maxOut) {
  const codings = String(contentEncoding ?? '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'identity');
  let cur = buf;
  for (const coding of codings.reverse()) {
    try {
      if (coding === 'gzip' || coding === 'x-gzip') cur = await gunzip(cur, { maxOutputLength: maxOut });
      else if (coding === 'br') cur = await brotli(cur, { maxOutputLength: maxOut });
      else if (coding === 'deflate') {
        try { cur = await inflate(cur, { maxOutputLength: maxOut }); } catch (e) { if (e?.code === 'ERR_BUFFER_TOO_LARGE') throw e; cur = await inflateRaw(cur, { maxOutputLength: maxOut }); }
      } else return { ok: false, reason: 'unsupported' };
    } catch (e) {
      return { ok: false, reason: e?.code === 'ERR_BUFFER_TOO_LARGE' ? 'too_big' : 'decode_error' };
    }
  }
  return { ok: true, buf: cur };
}

const NAMED = {
  lbrace: '{', lcub: '{', rbrace: '}', rcub: '}', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']', lpar: '(', rpar: ')', quot: '"', apos: "'",
  amp: '&', lt: '<', gt: '>', colon: ':', comma: ',', period: '.', sol: '/', bsol: '\\', lowbar: '_', hyphen: '-', dash: '-', num: '#',
  nbsp: ' ', excl: '!', equals: '=', plus: '+', percnt: '%', semi: ';', commat: '@', quest: '?', ast: '*', dollar: '$', hat: '^', grave: '`',
};

export function jsonUnescape(s) {
  return s.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (m, hex, ch) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[ch] ?? ch;
  });
}

export function htmlUnescape(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

// Percent decoding of ASCII bytes only (a flag is ASCII); other bytes are left as they are.
export function percentDecode(s) {
  return s.replace(/%([0-9a-fA-F]{2})/g, (m, h) => { const b = parseInt(h, 16); return b < 0x80 ? String.fromCharCode(b) : m; });
}

const LAYERS = [jsonUnescape, htmlUnescape, percentDecode];

// The text itself and what it becomes after any chain of up to `depth` layers (a flag in a JSON string inside HTML needs two). Only layers
// that change the text produce a new variant; the number of variants is bounded.
export function variants(text, { depth = 3, max = 32 } = {}) {
  const seen = new Set([text]);
  let frontier = [text];
  for (let d = 0; d < depth && frontier.length && seen.size < max; d++) {
    const next = [];
    for (const t of frontier) {
      for (const layer of LAYERS) {
        const v = layer(t);
        if (v !== t && !seen.has(v) && seen.size < max) { seen.add(v); next.push(v); }
      }
    }
    frontier = next;
  }
  return [...seen];
}
