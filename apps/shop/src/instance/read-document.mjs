// The one document on standard input of the injector (IF-6 section 5). Kept identical to `readDocument` of contracts/mocks/stub-instance/common.mjs: the shop image
// cannot import from contracts/, and apps/shop/test/instance/inject.test.mjs runs the same inputs through both so they cannot drift apart.
function parse(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { return { ok: false, reason: 'not-utf8' }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, reason: 'not-json' }; }
}

// Reads the one document on standard input. Resolves { ok: true, value } or { ok: false, reason } where reason is a fixed word
// (never a part of the document): "too-large", "not-utf8", "empty", "not-json", "not-object", "trailing-data", "timeout".
// The document must be one JSON object. It ends at the end of the input OR as soon as the object is complete (a container made by
// Compose has no "stdin once" flag, so Docker does not close its input). Anything but white space after the object is a bad document
// (data that arrives within graceMs of the end of the object is seen; later data cannot be). Input that never completes is a bad
// document after deadlineMs.
export function readDocument(stream = process.stdin, maxBytes = 65536, { deadlineMs = 10000, graceMs = 100 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    // scanner state: first byte seen, brace depth, inside a string, after a backslash, index just past the object
    let started = false; let depth = 0; let inStr = false; let esc = false; let end = -1; let pos = 0;
    let grace = null;
    const deadline = setTimeout(() => finish({ ok: false, reason: 'timeout' }), deadlineMs);
    deadline.unref?.();
    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(deadline); clearTimeout(grace);
      stream.removeAllListeners('data');
      stream.resume?.();
      resolve(r);
    }
    const whole = () => Buffer.concat(chunks);
    const complete = () => {
      const buf = whole();
      if (buf.subarray(end).some((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)) return finish({ ok: false, reason: 'trailing-data' });
      return finish(parse(buf.subarray(0, end)));
    };
    stream.on('data', (chunk) => {
      if (done) return;
      const c = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += c.length;
      if (size > maxBytes) return finish({ ok: false, reason: 'too-large' });
      chunks.push(c);
      if (end >= 0) { if (c.some((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)) finish({ ok: false, reason: 'trailing-data' }); return; }
      for (let i = 0; i < c.length; i++, pos++) {
        const b = c[i];
        if (!started) {
          if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) continue;
          if (b !== 0x7b) return finish({ ok: false, reason: 'not-object' }); // an array, a number, a string, a byte-order mark, text
          started = true; depth = 1; continue;
        }
        if (inStr) { if (esc) esc = false; else if (b === 0x5c) esc = true; else if (b === 0x22) inStr = false; continue; }
        if (b === 0x22) inStr = true;
        else if (b === 0x7b || b === 0x5b) depth++;
        else if (b === 0x7d || b === 0x5d) { depth--; if (depth === 0) { end = pos + 1; break; } }
      }
      if (end >= 0) {
        const buf = whole();
        if (buf.length > end) return complete(); // the rest arrived with the object
        grace = setTimeout(complete, graceMs); // wait briefly for more data or the end of the input
        grace.unref?.();
      }
    });
    stream.on('error', () => finish({ ok: false, reason: 'empty' }));
    stream.on('end', () => {
      if (done) return;
      if (end >= 0) return complete();
      finish(chunks.length ? { ok: false, reason: started ? 'not-json' : 'empty' } : { ok: false, reason: 'empty' });
    });
  });
}
