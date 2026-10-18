// Spike S-9 channels: each row builds a response (body bytes plus content-encoding) that carries one flag in one channel, and says whether
// the matcher is expected to see it. The matcher test asserts every row; scripts/s9-table.mjs runs the same rows and writes the table.
import crypto from 'node:crypto';
import { gzip, deflate, brotli, LB, RB } from './helpers.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');
const hex = (s) => Buffer.from(s).toString('hex');
const entity = (s) => [...s].map((ch) => `&#${ch.charCodeAt(0)};`).join('');
const jsonU = (s) => [...s].map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const pct = (s) => [...s].map((ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');

// f: the flag. Returns { body: Buffer|string, encoding?: string, chunks?: number[] (split points of the copy) }.
export const CHANNELS = [
  { id: 'plain', label: 'plain text', seen: true, build: (f) => ({ body: `<p>${f}</p>` }) },
  { id: 'json-plain', label: 'JSON string, plain', seen: true, build: (f) => ({ body: JSON.stringify({ note: f }) }) },
  { id: 'json-braces-escaped', label: 'JSON with braces as unicode escapes', seen: true, build: (f) => ({ body: `{"note":"VM\\u007b${f.slice(3, -1)}\\u007d"}` }) },
  { id: 'json-all-escaped', label: 'JSON, every character as a unicode escape', seen: true, build: (f) => ({ body: `{"note":"${jsonU(f)}"}` }) },
  { id: 'json-slash', label: 'JSON with escaped slashes around it', seen: true, build: (f) => ({ body: `{"u":"http:\\/\\/shop\\/x\\/${f}\\/y"}` }) },
  { id: 'gzip', label: 'gzip', seen: true, build: (f) => ({ body: gzip(`<p>${f}</p>`), encoding: 'gzip' }) },
  { id: 'deflate', label: 'deflate (zlib)', seen: true, build: (f) => ({ body: deflate(`<p>${f}</p>`), encoding: 'deflate' }) },
  { id: 'brotli', label: 'brotli', seen: true, build: (f) => ({ body: brotli(`<p>${f}</p>`), encoding: 'br' }) },
  { id: 'gzip-json-escaped', label: 'gzip around JSON escapes', seen: true, build: (f) => ({ body: gzip(`{"note":"${jsonU(f)}"}`), encoding: 'gzip' }) },
  { id: 'html-entities-braces', label: 'HTML numeric entities for the braces', seen: true, build: (f) => ({ body: `<p>VM&#123;${f.slice(3, -1)}&#125;</p>` }) },
  { id: 'html-entities-named', label: 'HTML named entities for the braces', seen: true, build: (f) => ({ body: `<p>VM&lbrace;${f.slice(3, -1)}&rbrace;</p>` }) },
  { id: 'html-entities-all', label: 'HTML hex and decimal entities for every character', seen: true, build: (f) => ({ body: `<p>${entity(f)}</p>` }) },
  { id: 'percent-braces', label: 'percent-encoded braces', seen: true, build: (f) => ({ body: `<a href="/x?next=VM%7B${f.slice(3, -1)}%7D">x</a>` }) },
  { id: 'percent-all', label: 'every character percent-encoded', seen: true, build: (f) => ({ body: `/x?q=${pct(f)}` }) },
  { id: 'json-in-html', label: 'inside a JSON string inside HTML (script tag)', seen: true, build: (f) => ({ body: `<script>window.__S__={"k":"${jsonU(f)}"}</script>` }) },
  { id: 'html-in-json', label: 'HTML entities inside a JSON string', seen: true, build: (f) => ({ body: JSON.stringify({ html: `<b>${entity(f)}</b>` }) }) },
  { id: 'split-chunks', label: 'cut at a chunk border (joined before the scan)', seen: true, build: (f) => ({ body: `<p>${f}</p>`, chunks: [5, 20] }) },
  { id: 'base64', label: 'base64 of the flag', seen: false, build: (f) => ({ body: `<p>${b64(f)}</p>` }) },
  { id: 'hex', label: 'hex of the flag', seen: false, build: (f) => ({ body: `<p>${hex(f)}</p>` }) },
  { id: 'reversed', label: 'reversed string', seen: false, build: (f) => ({ body: `<p>${[...f].reverse().join('')}</p>` }) },
  { id: 'split-string', label: 'split by markup inside the flag', seen: false, build: (f) => ({ body: `<p>${f.slice(0, 10)}<i></i>${f.slice(10)}</p>` }) },
  { id: 'cut-by-caller', label: 'flag cut off by the caller (a prefix only)', seen: false, build: (f) => ({ body: `<p>${f.slice(0, 15)}</p>` }) },
  { id: 'lowercase', label: 'lower-case copy of the flag', seen: false, build: (f) => ({ body: `<p>${f.toLowerCase()}</p>` }) },
  { id: 'utf16', label: 'body in UTF-16', seen: false, build: (f) => ({ body: Buffer.from(`<p>${f}</p>`, 'utf16le') }) },
  { id: 'unsupported-encoding', label: 'content-encoding the sidecar cannot decode (zstd)', seen: false, build: (f) => ({ body: Buffer.from(`<p>${f}</p>`), encoding: 'zstd' }) },
  { id: 'above-cap', label: 'response above the 1 MiB scan cap', seen: false, build: (f) => ({ body: Buffer.concat([Buffer.alloc(1024 * 1024 + 16, 0x20), Buffer.from(f)]) }) },
  { id: 'random-bytes', label: 'unrelated binary with no flag (control row)', seen: false, build: () => ({ body: crypto.randomBytes(2048) }) },
];

export { LB, RB };
