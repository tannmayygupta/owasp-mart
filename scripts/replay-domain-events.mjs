// Replays the domain event fixtures (IF-3) in order to a local consumer and checks what arrives.
// A tiny Server-Sent Events hub on 127.0.0.1 stands in for the platform hub of story P-22: it keeps a short replay buffer,
// gives every event a stream id (<ms>-<seq>, like a Valkey stream), sends each connection only the events of its audiences,
// honours Last-Event-ID, answers an unknown, too old or reset id with one `resync` event and then ends the connection,
// and sends heartbeat comments. The consumer is a plain HTTP client that parses the frames. No Docker, no dependency beyond Ajv.
// IMPORTANT: this hub reads the audiences from a test header. The real hub takes them from the session, never from the client (ADR 0006).
// A connection with no Last-Event-ID receives only events published after it connects (the snapshot is read from the API, FR-LIV-04);
// the test-only query `?replay=all` replays the whole buffer so the checks can read everything a fixture published.
// Usage: node scripts/replay-domain-events.mjs [--dir <contracts/domain-events folder>] [--help]
// Exit code 0 when every check passes, 1 when any fails, 2 on a usage error.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_DIR, FIXTURE_FILE, SCHEMA_FILE, loadJson, makeAjv } from './validate-domain-events.mjs';

export const HELP = `Replay the domain event fixtures (IF-3) to a local SSE consumer
Usage: node scripts/replay-domain-events.mjs [--dir <contracts/domain-events folder>] [--help]
Exit code 0 when every check passes, 1 when any fails, 2 on a usage error.`;

export const HEARTBEAT_MS = 15000; // FR-LIV-02: a heartbeat comment about every 15 seconds
const AUDIENCE_STRING = /^(?:(user|org):[A-Za-z0-9-]{1,64}|admin)$/;
const ID = /^(\d{1,15})-(\d{1,9})$/;
const cmp = (a, b) => (a.ms - b.ms) || (a.seq - b.seq);
const parseId = (s) => { const m = ID.exec(s || ''); return m ? { ms: Number(m[1]), seq: Number(m[2]) } : null; };
// The Valkey stream of an audience: live:user:<id>, live:org:<id> or live:admin (architecture 04, section 7).
export const streamKey = (audience) => `live:${audience}`;

export function loadRecords(dir = DEFAULT_DIR) {
  return loadJson(path.join(dir, FIXTURE_FILE)).records;
}

const frame = ({ id, event, data }) => `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const nowSeconds = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// The hub. `publish` plays the role of the outbox relay; `reset` plays a Valkey reset.
export function createHub({ buffer = 1000, heartbeatMs = HEARTBEAT_MS } = {}) {
  const kept = []; // { id, key, audiences, event }
  let latest = null;
  let trimmedUpTo = null; // the id of the newest event that fell out of the buffer
  let resetBarrier = null; // ids up to here were lost in a reset
  const live = new Set(); // { res, audiences }

  const nextId = (event) => {
    let ms = Date.parse(event.occurred_at);
    if (Number.isNaN(ms)) throw new Error(`publish: occurred_at "${event.occurred_at}" is not a real UTC time`);
    let seq = 0;
    if (latest) {
      if (ms < latest.ms) ms = latest.ms;
      seq = ms === latest.ms ? latest.seq + 1 : 0;
    }
    return { ms, seq };
  };

  function publish(record) {
    const key = nextId(record.event);
    latest = key;
    const id = `${key.ms}-${key.seq}`;
    kept.push({ id, key, audiences: new Set(record.audiences), event: record.event });
    if (kept.length > buffer) trimmedUpTo = kept.shift().key;
    for (const c of live) {
      if ([...c.audiences].some((a) => record.audiences.includes(a))) c.res.write(frame({ id, event: record.event.type, data: record.event }));
    }
    return id;
  }

  function reset() {
    resetBarrier = latest;
    kept.length = 0;
    trimmedUpTo = null;
  }

  // A control event: no id, never stored. `occurred_at` is the time the hub sends it.
  const resync = (reason) => frame({ event: 'stream.resync', data: { schema_version: 1, type: 'stream.resync', occurred_at: nowSeconds(), data: { reason } } });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/live') { res.writeHead(404).end(); return; }
    const audiences = String(req.headers['x-test-audiences'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!audiences.length || audiences.some((a) => !AUDIENCE_STRING.test(a))) { res.writeHead(400).end('x-test-audiences: user:<id>, org:<id> or admin'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'private, no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    const mine = new Set(audiences);
    const lastHeader = req.headers['last-event-id'];
    let from = null;
    if (lastHeader !== undefined) {
      const last = parseId(String(lastHeader));
      // After a resync the client reloads the snapshot and opens a NEW connection without Last-Event-ID, so the hub ends this one.
      const refuse = (reason) => { res.write(resync(reason)); res.end(); };
      if (!last || !latest || cmp(last, latest) > 0) { refuse('id_unknown'); return; }
      if (resetBarrier && cmp(last, resetBarrier) < 0) { refuse('buffer_reset'); return; } // a client holding the barrier id itself is up to date
      if (trimmedUpTo && cmp(last, trimmedUpTo) < 0) { refuse('id_too_old'); return; }
      from = last;
    }
    const replayAll = url.searchParams.get('replay') === 'all';
    if (from || replayAll) {
      for (const k of kept) {
        if (from && cmp(k.key, from) <= 0) continue;
        if ([...k.audiences].some((a) => mine.has(a))) res.write(frame({ id: k.id, event: k.event.type, data: k.event }));
      }
    }
    if (url.searchParams.get('close') === '1') { res.end(); return; }
    const conn = { res, audiences: mine };
    live.add(conn);
    let timer = null;
    if (heartbeatMs > 0) { timer = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs); timer.unref?.(); }
    const done = () => { live.delete(conn); if (timer) clearInterval(timer); };
    req.on('close', done);
    res.on('close', done);
  });

  return {
    publish,
    reset,
    connections: () => live.size,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => { for (const c of live) c.res.end(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// Waits until the hub holds `n` open connections, so a test publishes only after the consumer is connected (no fixed sleep).
export async function waitForConnections(hub, n = 1, maxMs = 3000) {
  const start = Date.now();
  while (hub.connections() < n) {
    if (Date.now() - start > maxMs) throw new Error(`no connection reached the hub within ${maxMs} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// The consumer: connects, parses SSE frames until the stream ends, `maxEvents` frames arrived or `maxMs` passed.
// A bounded read that times out is an error: a stalled hub must not look like "nothing was sent".
export async function readSse(base, { audiences, lastEventId, close = true, replayAll = true, maxEvents = Infinity, maxMs = 5000 } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, maxMs);
  const headers = { 'x-test-audiences': audiences.join(',') };
  if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
  const params = [];
  if (close) params.push('close=1');
  if (replayAll && lastEventId === undefined) params.push('replay=all');
  const events = [];
  let comments = 0;
  let satisfied = false;
  try {
    const res = await fetch(`${base}/live${params.length ? `?${params.join('&')}` : ''}`, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dec = new TextDecoder();
    let pending = '';
    outer: for await (const chunk of res.body) {
      pending = (pending + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let i;
      while ((i = pending.indexOf('\n\n')) >= 0) {
        const raw = pending.slice(0, i);
        pending = pending.slice(i + 2);
        const f = { id: null, event: 'message', data: [] };
        let comment = false;
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) { comment = true; continue; }
          const j = line.indexOf(':');
          const k = j < 0 ? line : line.slice(0, j);
          const v = j < 0 ? '' : line.slice(j + 1).replace(/^ /, '');
          if (k === 'id') f.id = v; else if (k === 'event') f.event = v; else if (k === 'data') f.data.push(v);
        }
        if (!f.data.length) { if (comment) comments++; continue; }
        events.push({ id: f.id, event: f.event, data: JSON.parse(f.data.join('\n')) });
        if (events.length >= maxEvents) { satisfied = true; ctl.abort(); break outer; }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut && !satisfied && (close || maxEvents !== Infinity)) throw new Error(`readSse timed out after ${maxMs} ms with ${events.length} event(s)`);
  return { events, comments };
}

// ---- the checks ----
export async function run(dir = DEFAULT_DIR, { log = console.log } = {}) {
  const records = loadRecords(dir);
  const validate = makeAjv().compile(loadJson(path.join(dir, SCHEMA_FILE)));
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push([name, true]); log(`PASS  ${name}`); } catch (e) { results.push([name, false]); log(`FAIL  ${name}: ${e.message}`); }
  };
  const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
  const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`);
  const expectedFor = (aud) => records.filter((r) => r.audiences.some((a) => aud.includes(a)));
  const types = (evs) => evs.map((e) => e.event);
  const AUDIENCES = [['learner', ['user:USR-LEARNER-1']], ['candidate', ['user:USR-CANDIDATE-1']], ['recruiter', ['org:ORG-ACME-1']], ['admin', ['admin']]];

  const hub = createHub();
  const ids = records.map((r) => hub.publish(r));
  const base = await hub.listen();
  try {
    await check('ids are increasing and unique', () => {
      for (let i = 1; i < ids.length; i++) ok(cmp(parseId(ids[i]), parseId(ids[i - 1])) > 0, `${ids[i - 1]} then ${ids[i]}`);
    });
    await check('the stream of each audience is live:<audience>', () => {
      same(streamKey('user:USR-LEARNER-1'), 'live:user:USR-LEARNER-1', 'user stream');
      same(streamKey('org:ORG-ACME-1'), 'live:org:ORG-ACME-1', 'org stream');
      same(streamKey('admin'), 'live:admin', 'admin stream');
    });
    for (const [label, aud] of AUDIENCES) {
      await check(`${label} receives exactly its events, in order, valid, with matching ids`, async () => {
        const got = await readSse(base, { audiences: aud });
        const want = expectedFor(aud);
        ok(want.length > 0, 'the fixtures give this audience no event');
        same(types(got.events), want.map((r) => r.event.type), `${label} event types`);
        got.events.forEach((g, i) => {
          same(g.data, want[i].event, `${label} event ${i}`);
          ok(validate(g.data), `event ${i} fails the schema`);
          ok(g.id && ids.includes(g.id), `event ${i} has an unknown id`);
          ok(g.event === g.data.type, `event ${i}: the SSE event name is not the type`);
        });
        same(got.events.map((g) => g.id), got.events.map((g) => g.id).slice().sort((a, b) => cmp(parseId(a), parseId(b))), `${label} ids are in order`);
      });
    }
    await check('privacy wall: the recruiter never receives learner practice, a stranger receives nothing', async () => {
      const rec = await readSse(base, { audiences: ['org:ORG-ACME-1'] });
      ok(rec.events.length > 0 && rec.events.every((e) => e.data.data.mode === 'candidate'), 'a learner event reached an org');
      const none = await readSse(base, { audiences: ['user:USR-OTHER-9'] });
      same(none.events, [], 'a stranger');
      const mixed = await readSse(base, { audiences: ['user:USR-LEARNER-1', 'org:ORG-ACME-1'] });
      ok(mixed.events.length === expectedFor(['user:USR-LEARNER-1', 'org:ORG-ACME-1']).length, 'a session with two audiences gets the union once');
    });
    await check('the candidate does not receive their own milestones, captures or score (OI-15 open)', async () => {
      const got = await readSse(base, { audiences: ['user:USR-CANDIDATE-1'] });
      ok(got.events.length > 0, 'the candidate received nothing');
      for (const e of got.events) ok(!['attempt.milestone_reached', 'attempt.flag_captured', 'attempt.score_updated'].includes(e.event), `${e.event} reached the candidate`);
    });
    await check('Last-Event-ID: a reconnect gets only the events after that id, and only those its audiences may see', async () => {
      for (const [label, aud] of AUDIENCES) {
        const all = await readSse(base, { audiences: aud });
        ok(all.events.length >= 2, `${label} has too few events to cut`);
        const cut = all.events[0].id;
        const rest = await readSse(base, { audiences: aud, lastEventId: cut });
        same(rest.events.map((e) => e.id), all.events.slice(1).map((e) => e.id), `${label}: events after the id`);
        const nothing = await readSse(base, { audiences: aud, lastEventId: all.events.at(-1).id });
        same(nothing.events, [], `${label}: events after the last id`);
      }
    });
    await check('an unknown or malformed Last-Event-ID gives one resync, no events, and the connection ends', async () => {
      for (const bad of ['99999999999999-0', 'abc', '']) {
        const got = await readSse(base, { audiences: ['user:USR-LEARNER-1'], lastEventId: bad, close: false, maxMs: 3000 });
        same(got.events.map((e) => e.event), ['stream.resync'], `answer to "${bad}"`);
        same(got.events[0].data.data.reason, 'id_unknown', 'reason');
        ok(validate(got.events[0].data), 'the resync event fails the schema');
        ok(got.events[0].id === null, 'a resync event has no id');
        ok(!got.events[0].data.occurred_at.startsWith('1970'), 'a resync event carries the time the hub sent it');
      }
      ok(hub.connections() === 0, 'a connection stayed open after resync');
    });
    await check('a fresh connection (no Last-Event-ID) receives only events published after it connects', async () => {
      const h = createHub();
      records.slice(0, 5).forEach((r) => h.publish(r));
      const b = await h.listen();
      try {
        const pending = readSse(b, { audiences: ['user:USR-LEARNER-1'], close: false, replayAll: false, maxEvents: 1, maxMs: 3000 });
        await waitForConnections(h, 1);
        h.publish(records[5]);
        const got = await pending;
        same(got.events.map((e) => e.data.type), [records[5].event.type], 'only the new event');
      } finally { await h.close(); }
    });
  } finally {
    await hub.close();
  }

  await check('an id older than the buffer gives one resync (id_too_old); an id inside the buffer is replayed', async () => {
    const small = createHub({ buffer: 5 });
    const smallIds = records.map((r) => small.publish(r));
    const b = await small.listen();
    try {
      const got = await readSse(b, { audiences: ['user:USR-LEARNER-1'], lastEventId: smallIds[0] });
      same(got.events.map((e) => e.event), ['stream.resync'], 'answer');
      same(got.events[0].data.data.reason, 'id_too_old', 'reason');
      const fresh = await readSse(b, { audiences: ['org:ORG-ACME-1'], lastEventId: smallIds.at(-3) });
      ok(fresh.events.length > 0 && fresh.events.every((e) => e.event !== 'stream.resync'), 'an id inside the buffer was answered with resync or with nothing');
    } finally { await small.close(); }
  });

  await check('a Valkey reset gives one resync (buffer_reset) for every earlier id, and newer events flow again', async () => {
    const h = createHub();
    const hubIds = records.slice(0, 6).map((r) => h.publish(r));
    const b = await h.listen();
    try {
      h.reset();
      const got = await readSse(b, { audiences: ['user:USR-LEARNER-1'], lastEventId: hubIds[2] });
      same(got.events.map((e) => e.event), ['stream.resync'], 'answer');
      same(got.events[0].data.data.reason, 'buffer_reset', 'reason');
      const after = h.publish(records[6]);
      const next = await readSse(b, { audiences: ['user:USR-LEARNER-1'], lastEventId: hubIds[5] });
      ok(next.events.length === 0 || next.events.every((e) => e.id === after), 'an id newer than the reset was answered with resync');
    } finally { await h.close(); }
  });

  await check('live delivery: an event published after the connection arrives, with heartbeats in between', async () => {
    const h = createHub({ heartbeatMs: 20 });
    const b = await h.listen();
    try {
      const pending = readSse(b, { audiences: ['user:USR-LEARNER-1'], close: false, maxEvents: 2, maxMs: 3000 });
      await waitForConnections(h, 1);
      await new Promise((r) => setTimeout(r, 60)); // let a few heartbeats pass
      const mine = records.filter((r) => r.audiences.includes('user:USR-LEARNER-1'));
      const other = records.find((r) => !r.audiences.includes('user:USR-LEARNER-1'));
      ok(other, 'the fixtures have no record for another audience');
      h.publish(other);
      h.publish(mine[0]);
      h.publish(mine[1]);
      const got = await pending;
      same(got.events.map((e) => e.data.type), [mine[0].event.type, mine[1].event.type], 'live events');
      ok(got.comments >= 1, 'no heartbeat comment was received');
    } finally { await h.close(); }
  });

  const failed = results.filter(([, passed]) => !passed).length;
  log(failed ? `FAIL: ${failed} of ${results.length} checks failed` : `OK: ${results.length} checks, ${records.length} fixture records replayed.`);
  return failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), { log = console.log, err = console.error } = {}) {
  let dir = DEFAULT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { log(HELP); return 0; }
    if (argv[i] === '--dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { err('--dir needs a folder.'); return 2; }
      dir = path.resolve(argv[++i]);
      continue;
    }
    err(`Unknown argument "${argv[i]}". Run with --help.`);
    return 2;
  }
  if (!fs.existsSync(path.join(dir, FIXTURE_FILE))) { err(`No ${FIXTURE_FILE} in ${dir}`); return 1; }
  return run(dir, { log });
}

if (import.meta.main) main().then((c) => process.exit(c));
