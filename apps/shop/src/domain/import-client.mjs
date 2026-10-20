// The shop's client of the isolated import service (T-12, C06 / story L-30). The shop NEVER merges a seller's product data itself: it builds the job and sends it over
// the unix socket (VM_IMPORT_SOCKET) to the import service, which runs each job in a fresh process with no network and no database, and shows what comes back.
import net from 'node:net';
import { ValidationError } from './shop-service.mjs';

export const MAX_OPTIONS_CHARS = 4000;

/** The product of the job from the form fields. `options` is optional JSON text for the "advanced options" box; it is parsed, never merged here (a spread copies even an own
 *  `__proto__` key as a plain property, which is what the service must receive). */
export function buildJob(body = {}) {
  const title = String(body.title ?? '').slice(0, 120);
  const description = String(body.description ?? '').slice(0, 2000);
  const price = body.price_cents === undefined || body.price_cents === '' ? 0 : Number(body.price_cents);
  if (!title) throw new ValidationError('a product needs a title');
  if (!Number.isInteger(price) || price < 0 || price > 100_000_000) throw new ValidationError('price_cents must be a whole number of cents');
  let options = {};
  const raw = String(body.options ?? '').trim();
  if (raw) {
    if (raw.length > MAX_OPTIONS_CHARS) throw new ValidationError(`the advanced options are limited to ${MAX_OPTIONS_CHARS} characters`);
    try { options = JSON.parse(raw); } catch { throw new ValidationError('the advanced options are not valid JSON'); }
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new ValidationError('the advanced options must be a JSON object');
  }
  return { product: { title, description, price_cents: price, ...options } };
}

/** Send one job and read the one answer. Resolves { ok, preview, auditToken } or { ok: false, error } when the service is away, busy or silent. Never rejects. */
export function sendJob(job, { socketPath = process.env.VM_IMPORT_SOCKET, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!socketPath) return resolve({ ok: false, error: 'the import service is not available' });
    const chunks = [];
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.destroy(); } catch { /* closed */ } resolve(v); };
    const conn = net.connect(socketPath, () => { conn.end(JSON.stringify(job)); });
    const timer = setTimeout(() => done({ ok: false, error: 'the import service did not answer in time' }), timeoutMs);
    conn.on('data', (c) => chunks.push(c));
    conn.on('error', () => done({ ok: false, error: 'the import service is not available' }));
    conn.on('close', () => {
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done({ ok: false, error: 'the import service gave no valid answer' }); }
    });
  });
}

/** The preview page's answer: what the service computed, the audit token when it came back, and nothing of the worker's internals. */
export async function importPreview(body, opts) {
  const result = await sendJob(buildJob(body), opts);
  if (!result.ok) return { ok: false, error: result.error === 'busy' ? 'the import service is busy, try again' : 'the import preview failed' };
  return { ok: true, preview: result.preview, auditToken: result.auditToken ?? null };
}