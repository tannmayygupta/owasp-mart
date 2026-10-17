// evidence.capture (IF-4, FR-DET-04): what the sidecar stores about the request that made a response show a real flag. D-25: this is the
// only event with a body, and only the flag-capturing request has one. The response body is never stored.
import crypto from 'node:crypto';
import { variants } from './decode.mjs';
import { FLAG_SHAPE } from './matcher.mjs';

export const MARKER = '[FLAG-REDACTED]';
export const BODY_CAP_BYTES = 8192; // IF-4 section 6; the schema also limits the text to 8192 characters
export const HEADER_ALLOW = ['user-agent', 'content-type', 'accept', 'referer', 'x-requested-with', 'origin'];
export const HEADER_VALUE_CAP = 512;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// A per-request id of the form r- plus 16 Base32 characters (the "id" shape of the schema).
export function requestRef() {
  return 'r-' + Array.from(crypto.randomBytes(16).subarray(0, 16), (b) => B32[b % 32]).join('');
}

// The words that blank a field in a JSON or form body (any name that holds one of them).
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:password|passwd|token|secret|authorization|cookie|api_?key)[A-Za-z0-9_.-]*';
const JSON_FIELD = new RegExp(`("${SECRET_NAME}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}\\]\\s]+)`, 'gi');
const FORM_FIELD = new RegExp(`((?:^|[&?\\n])${SECRET_NAME}=)[^&\\s]*`, 'gi');

export function blankSecrets(text) {
  return text.replace(JSON_FIELD, '$1""').replace(FORM_FIELD, '$1');
}

// A flag-shaped string in plain, percent or full-width form is replaced by the marker. The match runs to the closing brace, or stops at a
// character that cannot be part of a flag, so a cut-off flag at the end is replaced too.
const FLAGGY_RUN = /[Vv][Mm](?:\{|%7[Bb]|｛)[^\s"'<>&]*?(?:\}|%7[Dd]|｝|(?=[\s"'<>&])|$)/g;
export const redactFlagLike = (text) => text.replace(FLAGGY_RUN, MARKER);

// The last guard before a value goes into an event: no flag-shape in any decoded form, and none of the schema's refused patterns.
const REFUSED = /[Vv][Mm](?:\{|%7[Bb]|｛)/;
function stillFlaggy(text) {
  if (REFUSED.test(text)) return true;
  return variants(text).some((v) => { FLAG_SHAPE.lastIndex = 0; return FLAG_SHAPE.test(v) || REFUSED.test(v); });
}

function cutBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // do not cut inside a character
  return buf.subarray(0, end).toString('utf8');
}

// method, url: the request line. headers: the request headers (Node's lowercase map). bodyBuf: the first bytes of the request body (at most
// BODY_CAP_BYTES are kept by the caller). Returns { body, headers_redacted } that pass the event schema.
export function buildCapture({ method, url, headers, bodyBuf }) {
  const line = redactFlagLike(blankSecrets(`${String(method).slice(0, 16)} ${String(url).slice(0, 1024)}`));
  const reqBody = bodyBuf && bodyBuf.length ? redactFlagLike(blankSecrets(bodyBuf.subarray(0, BODY_CAP_BYTES).toString('utf8'))) : '';
  let body = cutBytes(reqBody ? `${line}\n\n${reqBody}` : line, BODY_CAP_BYTES);
  // A flag hidden in an escape the redaction does not read (for example a JSON \u escape): the body is replaced as a whole, never sent.
  if (stillFlaggy(body)) body = MARKER;
  const headers_redacted = {};
  for (const name of HEADER_ALLOW) {
    const raw = headers?.[name];
    if (raw === undefined) continue;
    let v = redactFlagLike(Array.isArray(raw) ? raw.join(', ') : String(raw)).slice(0, HEADER_VALUE_CAP);
    if (stillFlaggy(v)) v = MARKER;
    headers_redacted[name] = v;
  }
  return { body, headers_redacted };
}
