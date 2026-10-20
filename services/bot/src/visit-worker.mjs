// One browser visit, run in its own child process (C03 part B, FR-SHP-11). The parent (browser.mjs) sends one job and kills this process when the time is up, so a player
// script that never returns (`while(1){}`) cannot hang the controller, and the heap of one visit is capped.
//
// What runs here is jsdom: a page with scripts, a cookie jar, events and a DOM, not a full browser (decision: ADR 0058). The "network layer" of challenge-specs 3.7 is the
// function netFetch below: every request of the page (fetch, XMLHttpRequest, images, scripts, beacons) goes through it, it refuses any origin that is not in the job's list,
// adds the visit tag (the collector reads it as `bot_tagged`) and the bot's cookie for the shop's own origin, and caps sizes and counts.
//
// The page cannot see an outer-realm object: the only bridge into this process is one function with no prototype, held in the closure of the shim (SHIM), and everything that
// crosses it is a string. The page's console, fetch, XHR, WebSocket and window.open are replaced or removed, so none of them leads to this process by `.constructor`.
import jsdom from 'jsdom'; // CommonJS: named imports are not available

const { CookieJar, JSDOM, VirtualConsole, requestInterceptor } = jsdom;

// jsdom's own functions (setTimeout, createElement, addEventListener ...) belong to this process, so a page can climb from one of them to this process's Function with
// setTimeout.constructor('return process')(). The climb is closed here, before any page runs: no function prototype answers .constructor, and the stack-trace hook that
// would hand a page its caller's this cannot be set. This is defence in depth, not a security boundary (ADR 0058): the boundary is the container, which holds no secret.
export function lockIntrinsics() {
  const closed = { get() { return undefined; }, set() {}, configurable: false };
  for (const proto of [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) Object.defineProperty(proto, 'constructor', closed);
  Object.defineProperty(Error, 'prepareStackTrace', closed);
}

const MAX_REQUESTS = 60;
const MAX_REQUEST_BODY = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 4000;
const USER_AGENT = 'Mozilla/5.0 (VulnMart support agent console)';

// Runs in the page's own realm, once, before any page script. `bridge(kind, jsonString, callback)` answers by calling `callback(jsonString)`.
const SHIM = `(function (bridge) {
  'use strict';
  var W = window;
  function call(kind, payload, cb) {
    try { bridge(kind, JSON.stringify(payload), function (s) { try { cb(JSON.parse(s)); } catch (e) { /* the page's callback failed: its own problem */ } }); }
    catch (e) { cb({ error: true }); }
  }
  function absolute(u) { return new URL(String(u), W.location.href).href; }
  function headerObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v); }); return out; }
    if (Array.isArray(h)) { h.forEach(function (p) { out[String(p[0]).toLowerCase()] = String(p[1]); }); return out; }
    Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = String(h[k]); });
    return out;
  }
  function makeResponse(r, url) {
    var headers = r.headers || {};
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, statusText: '', url: url, redirected: false, type: 'basic',
      headers: { get: function (n) { var v = headers[String(n).toLowerCase()]; return v === undefined ? null : v; }, has: function (n) { return String(n).toLowerCase() in headers; } },
      text: function () { return Promise.resolve(r.body); },
      json: function () { return new Promise(function (res, rej) { try { res(JSON.parse(r.body)); } catch (e) { rej(new SyntaxError('Unexpected token in JSON')); } }); },
      clone: function () { return makeResponse(r, url); }
    };
  }
  function doFetch(input, init) {
    return new Promise(function (resolve, reject) {
      var url, method = 'GET', headers = {}, body = null;
      try {
        init = init || {};
        url = absolute(input && typeof input === 'object' && input.url ? input.url : input);
        method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        headers = headerObject(init.headers || (input && input.headers));
        body = init.body === undefined || init.body === null ? null : String(init.body);
      } catch (e) { reject(new TypeError('Failed to fetch')); return; }
      call('fetch', { url: url, method: method, headers: headers, body: body }, function (r) { if (r.error) reject(new TypeError('Failed to fetch')); else resolve(makeResponse(r, url)); });
    });
  }
  Object.defineProperty(W, 'fetch', { value: doFetch, writable: true, configurable: true });

  function XHR() { this.readyState = 0; this.status = 0; this.responseText = ''; this.response = ''; this.responseType = ''; this._h = {}; this._l = {}; this._rh = {}; }
  XHR.prototype.open = function (m, u) { this._m = String(m).toUpperCase(); try { this._u = absolute(u); } catch (e) { this._u = null; } this.readyState = 1; };
  XHR.prototype.setRequestHeader = function (k, v) { this._h[String(k).toLowerCase()] = String(v); };
  XHR.prototype.getResponseHeader = function (n) { var v = this._rh[String(n).toLowerCase()]; return v === undefined ? null : v; };
  XHR.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
  XHR.prototype.removeEventListener = function (t, f) { this._l[t] = (this._l[t] || []).filter(function (x) { return x !== f; }); };
  XHR.prototype.abort = function () { this._aborted = true; };
  XHR.prototype._fire = function (t) {
    var ev = { type: t, target: this };
    var h = this['on' + t]; if (typeof h === 'function') { try { h.call(this, ev); } catch (e) { /* the page's handler failed */ } }
    (this._l[t] || []).forEach(function (f) { try { f.call(this, ev); } catch (e) { /* same */ } }, this);
  };
  XHR.prototype.send = function (body) {
    var self = this;
    if (!self._u) { self._fire('error'); return; }
    call('fetch', { url: self._u, method: self._m || 'GET', headers: self._h, body: body === undefined || body === null ? null : String(body) }, function (r) {
      if (self._aborted) return;
      if (r.error) { self.readyState = 4; self._fire('readystatechange'); self._fire('error'); self._fire('loadend'); return; }
      self.status = r.status; self._rh = r.headers || {}; self.responseText = r.body; self.response = r.body; self.readyState = 4;
      self._fire('readystatechange'); self._fire('load'); self._fire('loadend');
    });
  };
  Object.defineProperty(W, 'XMLHttpRequest', { value: XHR, writable: true, configurable: true });

  // An image whose address is set by a script is requested; the page hears load or error. (Images written in the page's HTML are handled by the visit after load.)
  function loadImage(el, u) {
    var url; try { url = absolute(u); } catch (e) { return; }
    call('img', { url: url }, function (r) { try { el.dispatchEvent(new W.Event(r.error ? 'error' : 'load')); } catch (e) { /* the element is gone */ } });
  }
  var srcDesc = Object.getOwnPropertyDescriptor(W.HTMLImageElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(W.HTMLImageElement.prototype, 'src', { configurable: true, enumerable: true, get: srcDesc.get, set: function (v) { srcDesc.set.call(this, v); loadImage(this, v); } });
  }
  var setAttr = W.Element.prototype.setAttribute;
  W.Element.prototype.setAttribute = function (n, v) {
    setAttr.call(this, n, v);
    if (this.tagName === 'IMG' && String(n).toLowerCase() === 'src') loadImage(this, v);
  };
  try { Object.defineProperty(W.navigator, 'sendBeacon', { value: function (u, d) { call('fetch', { url: absolute(u), method: 'POST', headers: {}, body: d === undefined || d === null ? null : String(d) }, function () {}); return true; }, configurable: true }); } catch (e) { /* no navigator */ }

  Object.defineProperty(W, 'open', { value: function () { return null; }, writable: true, configurable: true });
  Object.defineProperty(W, 'alert', { value: function () {}, writable: true, configurable: true });
  Object.defineProperty(W, 'confirm', { value: function () { return false; }, writable: true, configurable: true });
  Object.defineProperty(W, 'prompt', { value: function () { return null; }, writable: true, configurable: true });
  var quiet = function () {};
  Object.defineProperty(W, 'console', { value: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet, dir: quiet, trace: quiet, table: quiet, group: quiet, groupEnd: quiet, time: quiet, timeEnd: quiet, assert: quiet, clear: quiet, count: quiet }, writable: true, configurable: true });
  Object.defineProperty(W, 'WebSocket', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(W, 'EventSource', { value: undefined, writable: true, configurable: true });
})`;

const IMAGE_TYPE = /^image\//i;
const LOADERS = ['svg', 'body', 'iframe', 'video', 'audio', 'object', 'embed', 'input', 'link', 'frameset'];
const POINTER_EVENTS = ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'focus', 'focusin', 'blur', 'pointerover', 'pointerdown', 'pointerup', 'toggle'];

/** The visit. `job`: { href, cookie: {name, value} | null, visitId, origins: [..], dwellMs }. Returns { ok, status, requests }. Never throws. */
export async function run(job, { fetchImpl = globalThis.fetch } = {}) {
  lockIntrinsics();
  const origins = new Set(job.origins);
  const pageOrigin = new URL(job.href).origin;
  const jar = new CookieJar();
  if (job.cookie) jar.setCookieSync(`${job.cookie.name}=${job.cookie.value}; Path=/; HttpOnly`, `${pageOrigin}/`);
  let requests = 0;

  /** The one door to the network: allow-listed origins only, tagged, capped. Resolves to { status, type, headers, body: Buffer } or null when refused. */
  async function netFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(u.protocol) || !origins.has(u.origin) || requests >= MAX_REQUESTS) return null;
    if (body !== null && Buffer.byteLength(body) > MAX_REQUEST_BODY) return null;
    requests += 1;
    const h = { 'user-agent': USER_AGENT, accept: '*/*' };
    for (const [k, v] of Object.entries(headers)) if (!/^(host|cookie|content-length|connection)$/i.test(k)) h[k.toLowerCase()] = String(v);
    h['x-vm-visit'] = job.visitId; // the tag the collector reads as `bot_tagged`; set last so a page cannot replace it
    if (u.origin === pageOrigin) { const c = jar.getCookieStringSync(u.href); if (c) h.cookie = c; }
    try {
      const init = { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
      if (body !== null && !/^(GET|HEAD)$/.test(method)) init.body = body;
      const res = await fetchImpl(u.href, init);
      for (const sc of res.headers.getSetCookie?.() ?? []) { try { jar.setCookieSync(sc, u.href); } catch { /* a bad cookie line */ } }
      const chunks = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) { try { await reader.cancel(); } catch { /* done */ } break; }
          chunks.push(Buffer.from(value));
        }
      }
      return { status: res.status, type: res.headers.get('content-type') || '', headers: Object.fromEntries(res.headers.entries()), body: Buffer.concat(chunks) };
    } catch { return null; }
  }

  const page = await netFetch(job.href);
  if (!page) return { ok: false, status: 0, requests };
  if (page.status !== 200 || !/html/i.test(page.type)) return { ok: true, status: page.status, requests };

  // the bridge: strings in, strings out, an in-realm callback to answer; it never throws and has no prototype for the page to climb
  const bridge = (kind, payload, cb) => {
    (async () => {
      let out = { error: true };
      try {
        const p = JSON.parse(payload);
        if (kind === 'fetch') {
          const r = await netFetch(p.url, { method: String(p.method || 'GET'), headers: p.headers && typeof p.headers === 'object' ? p.headers : {}, body: typeof p.body === 'string' ? p.body : null });
          if (r) out = { status: r.status, headers: r.headers, body: r.body.toString('utf8') };
        } else if (kind === 'img') {
          const r = await netFetch(p.url);
          out = r && r.status === 200 && IMAGE_TYPE.test(r.type) ? { status: 200 } : { error: true };
        }
      } catch { out = { error: true }; }
      try { cb(JSON.stringify(out)); } catch { /* the page is gone */ }
    })();
  };
  Object.setPrototypeOf(bridge, null);

  // everything jsdom itself requests (scripts, frames, styles) is answered here, so nothing of it reaches the network except through netFetch
  const resources = {
    userAgent: USER_AGENT,
    interceptors: [requestInterceptor(async (request) => {
      const r = await netFetch(request.url, { method: request.method });
      if (!r) return new Response('blocked', { status: 403 });
      return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: { 'content-type': r.type || 'application/octet-stream' } });
    })],
  };

  let dom;
  try {
    dom = new JSDOM(page.body.toString('utf8'), {
      url: job.href,
      runScripts: 'dangerously',
      resources,
      pretendToBeVisual: true,
      cookieJar: jar,
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.__vm_bridge = bridge;
        window.eval(`${SHIM}(window.__vm_bridge); delete window.__vm_bridge;`);
      },
    });
  } catch { return { ok: false, status: page.status, requests }; }
  const { window } = dom;

  const loaded = new Promise((resolve) => { window.addEventListener('load', resolve); setTimeout(resolve, 3000).unref?.(); });
  await loaded;
  await emulateAgent(window, netFetch, job.href);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(job.dwellMs ?? 8000, 20000))));
  window.close();
  return { ok: true, status: page.status, requests };
}

// What a support agent's browser does that jsdom does not do alone: images in the page's HTML are fetched (a missing image fires `error`), media and frames fire `load`,
// an autofocus field takes the focus, and the agent moves over and clicks what a ticket message made interactive. Bounded: at most 40 elements.
export async function emulateAgent(window, netFetch, href) {
  const { document } = window;
  const fire = (el, type) => { try { el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); } catch { /* the page's handler threw */ } };
  for (const img of [...document.querySelectorAll('img[src]')].slice(0, 20)) {
    let ok = false;
    try { const r = await netFetch(new URL(img.getAttribute('src'), href).href); ok = !!r && r.status === 200 && IMAGE_TYPE.test(r.type); } catch { ok = false; }
    fire(img, ok ? 'load' : 'error');
  }
  for (const el of [...document.querySelectorAll(LOADERS.join(','))].slice(0, 20)) if (el.hasAttribute('onload')) fire(el, 'load');
  for (const el of [...document.querySelectorAll('details[open]')].slice(0, 10)) fire(el, 'toggle');
  for (const el of [...document.querySelectorAll('[autofocus]')].slice(0, 5)) { try { el.focus(); } catch { /* not focusable */ } }
  const interactive = [...document.querySelectorAll('*')].filter((el) => el.getAttributeNames().some((n) => /^on(mouse|pointer|click|dblclick|focus|blur|contextmenu|toggle)/i.test(n)) || /^javascript:/i.test(el.getAttribute('href') || '')).slice(0, 40);
  for (const el of interactive) for (const type of POINTER_EVENTS) fire(el, type);
}

if (process.send) {
  process.once('message', async (job) => {
    let out;
    try { out = await run(job); } catch { out = { ok: false, status: 0, requests: 0 }; }
    process.send(out, () => process.exit(0));
  });
}
