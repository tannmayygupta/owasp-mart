// Text hygiene: no tracked text file may hold a control character (other than tab, LF and CR), a byte order mark, or
// mojibake (UTF-8 text that was read as a legacy code page and saved again).
// Usage: node scripts/check-text-files.mjs   (exit 1 with file and line of each hit)
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = /(^|\/)(pnpm-lock\.yaml|uv\.lock|\.terraform\.lock\.hcl|package-lock\.json)$|(^|\/)\.terraform\/|\.(xlsx|png|jpg|jpeg|gif|ico|pdf|woff2?|zip|gz|tfstate)$/i;
// C0 controls except tab (09), LF (0A), CR (0D); DEL; C1 controls.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// Typical mojibake of a UTF-8 dash, quote or arrow read as Windows-1252 (built from code points so this file stays clean).
const MOJIBAKE = new RegExp(`${String.fromCharCode(0xe2)}(?:${String.fromCharCode(0x20ac)}|${String.fromCharCode(0x201e)})|${String.fromCharCode(0xc3)}[${String.fromCharCode(0x2018)}-${String.fromCharCode(0x2122)}${String.fromCharCode(0xa0)}-${String.fromCharCode(0xbf)}]`);

/** @param {string} file @param {Buffer|string} content @returns {{file:string,line:number,kind:string}[]} */
export function scanTextHygiene(file, content) {
  const hits = [];
  const text = typeof content === 'string' ? content : content.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) hits.push({ file, line: 1, kind: 'byte order mark' });
  text.split('\n').forEach((line, i) => {
    if (CONTROL.test(line)) hits.push({ file, line: i + 1, kind: 'control character' });
    if (MOJIBAKE.test(line)) hits.push({ file, line: i + 1, kind: 'mojibake' });
    if (line.includes(String.fromCharCode(0xfffd))) hits.push({ file, line: i + 1, kind: 'replacement character (broken encoding)' });
  });
  return hits;
}

export function scanTextFiles(files, read = (f) => readFileSync(path.join(ROOT, f)), size = (f) => statSync(path.join(ROOT, f)).size) {
  const hits = [];
  for (const f of files) {
    if (SKIP.test(f)) continue;
    try {
      if (size(f) > 4_000_000) continue;
      hits.push(...scanTextHygiene(f, read(f)));
    } catch {
      // deleted or unreadable file: nothing to scan
    }
  }
  return hits;
}

export function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = scanTextFiles(trackedTextFiles());
  if (hits.length) {
    for (const h of hits) console.error(`FAIL ${h.file}:${h.line} ${h.kind}`);
    process.exit(1);
  }
  console.log('PASS no control character, BOM or mojibake in the tracked text files');
}
