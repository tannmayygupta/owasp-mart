import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { STREAMS, buildPage, main, parseSprintHeading, parseTasks, startServer } from './progress-page.mjs';

const FILES = { dev1: 'dev1-tanmay.md', dev2: 'dev2-akshay.md', dev3: 'dev3-sahil.md' };
const PREFIX = { dev1: 'L', dev2: 'P', dev3: 'T' };

function taskFile(prefix, { tick1 = true, title2 = 'Second task' } = {}) {
  return `# Developer file

## Sprint overview

| Sprint | Dates |
|---|---|
| 1 | 8 Oct to 14 Oct 2026 |

## Sprint 1 (8 Oct to 14 Oct 2026)

Goal: first.

- [${tick1 ? 'x' : ' '}] **${prefix}-01. First task**
  - Build: Build the first thing.
  - Waits on: Nothing.

- [ ] **${prefix}-02. ${title2}**
  - Build: Build the second thing.
  - Waits on: ${prefix}-01.

## Sprint 2 (15 Oct to 21 Oct 2026)

- [ ] **${prefix}-03. Third task**
  - Build: Later.
`;
}

function makeRoot(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'progress-page-'));
  mkdirSync(path.join(root, 'docs', 'dev'), { recursive: true });
  for (const s of STREAMS) {
    writeFileSync(path.join(root, s.file), taskFile(PREFIX[s.key], options[s.key] || {}));
  }
  return root;
}

function run(args) {
  let out = '';
  let err = '';
  return main(args, { out: (s) => { out += s; }, err: (s) => { err += s; } }).then((code) => ({ code, out, err }));
}

function statusOf(page, id) {
  const m = new RegExp(`<span class="tid">${id}</span>.*?<span class="status">([^<]+)</span>`).exec(page);
  return m && m[1];
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('sprint heading is parsed into ISO dates', () => {
  assert.deepEqual(parseSprintHeading('## Sprint 4 (29 Oct to 4 Nov 2026)'), { number: 4, start: '2026-10-29', end: '2026-11-04' });
  assert.equal(parseSprintHeading('## Sprint overview'), null);
});

test('normal: every task appears once with the right status', () => {
  const root = makeRoot();
  try {
    const page = buildPage({ root, today: '2026-10-11' });
    for (const p of ['L', 'P', 'T']) {
      for (const n of ['01', '02', '03']) {
        const count = page.split(`<span class="tid">${p}-${n}</span>`).length - 1;
        assert.equal(count, 1, `${p}-${n} must appear once`);
      }
      assert.equal(statusOf(page, `${p}-01`), 'Done');
      assert.equal(statusOf(page, `${p}-02`), 'Being implemented');
      assert.equal(statusOf(page, `${p}-03`), 'Next');
    }
    for (const word of ['Lab', 'Platform', 'Target']) assert.ok(page.includes(`${word} stream`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('normal: main writes the page and exits 0', async () => {
  const root = makeRoot();
  try {
    const out = path.join(root, 'out', 'index.html');
    const r = await run(['--root', root, '--today', '2026-10-11', '--out', out]);
    assert.equal(r.code, 0);
    assert.ok(readFileSync(out, 'utf8').startsWith('<!doctype html>'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('today after a sprint: unticked tasks are "Being implemented (late)"', () => {
  const root = makeRoot();
  try {
    const page = buildPage({ root, today: '2026-10-16' });
    assert.equal(statusOf(page, 'L-02'), 'Being implemented (late)');
    assert.equal(statusOf(page, 'L-03'), 'Being implemented');
    assert.equal(statusOf(page, 'L-01'), 'Done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('today before every sprint: unticked tasks are Next', () => {
  const root = makeRoot();
  try {
    const page = buildPage({ root, today: '2026-10-01' });
    assert.equal(statusOf(page, 'L-02'), 'Next');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('branch ref: Sahil ticks come from the git ref', async () => {
  const root = makeRoot();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'sprint-1-sahil');
    writeFileSync(path.join(root, STREAMS[2].file), taskFile('T', { tick1: true }).replace('- [ ] **T-02.', '- [x] **T-02.'));
    git(root, 'commit', '-q', '-am', 'tick T-02');
    git(root, 'checkout', '-q', 'main');
    assert.equal(statusOf(buildPage({ root, today: '2026-10-11' }), 'T-02'), 'Being implemented');
    const page = buildPage({ root, today: '2026-10-11', dev3: 'sprint-1-sahil' });
    assert.equal(statusOf(page, 'T-02'), 'Done');
    assert.ok(page.includes('on git ref sprint-1-sahil'));
    assert.equal(statusOf(page, 'L-02'), 'Being implemented');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ref missing: exit 2 names the stream and the ref, no page written', async () => {
  const root = makeRoot();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    const out = path.join(root, 'page.html');
    const r = await run(['--root', root, '--today', '2026-10-11', '--out', out, '--dev3', 'origin/no-such-branch']);
    assert.equal(r.code, 2);
    assert.match(r.err, /Target \(dev3\)/);
    assert.match(r.err, /origin\/no-such-branch/);
    assert.equal(existsSync(out), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ref that looks like an option is refused', async () => {
  const root = makeRoot();
  try {
    const r = await run(['--root', root, '--dev1', '--output=x']);
    assert.equal(r.code, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing default file: exit 2 and no page', async () => {
  const root = makeRoot();
  try {
    rmSync(path.join(root, STREAMS[1].file));
    const out = path.join(root, 'page.html');
    const r = await run(['--root', root, '--out', out]);
    assert.equal(r.code, 2);
    assert.match(r.err, /Platform/);
    assert.equal(existsSync(out), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed task file: exit 1 naming the stream, no page', async () => {
  const root = makeRoot();
  try {
    writeFileSync(path.join(root, STREAMS[0].file), '# nothing here\n\nNo tasks.\n');
    const out = path.join(root, 'page.html');
    const r = await run(['--root', root, '--out', out]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Lab/);
    assert.equal(existsSync(out), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('escaping: a hostile title is shown as text', () => {
  const root = makeRoot({ dev1: { title2: '<script>alert("x")</script> & \'q\'' } });
  try {
    const page = buildPage({ root, today: '2026-10-11' });
    assert.ok(!page.includes('<script>'));
    assert.ok(page.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same input twice gives identical output', () => {
  const root = makeRoot();
  try {
    assert.equal(buildPage({ root, today: '2026-10-11' }), buildPage({ root, today: '2026-10-11' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('page is offline: no external reference and no script', () => {
  const root = makeRoot();
  try {
    const page = buildPage({ root, today: '2026-10-11' });
    assert.ok(!/<script/i.test(page));
    assert.ok(!/(src|href)="https?:/i.test(page));
    assert.ok(!/@import|url\(/i.test(page));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bad arguments exit 2', async () => {
  assert.equal((await run(['--nope'])).code, 2);
  assert.equal((await run(['--today', '2026-13-40'])).code, 2);
  assert.equal((await run(['--port', 'abc'])).code, 2);
  assert.equal((await run(['--help'])).code, 0);
});

function get(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serve: "/" answers 200 with the page, other paths 404, other methods 405, bound to 127.0.0.1', async () => {
  const root = makeRoot();
  const server = await startServer({ getPage: () => buildPage({ root, today: '2026-10-11' }), port: 0 });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const port = server.address().port;
    const ok = await get(port, '/');
    assert.equal(ok.status, 200);
    assert.ok(ok.body.includes('Lab stream'));
    assert.equal((await get(port, '/etc/passwd')).status, 404);
    assert.equal((await get(port, '/index.html')).status, 404);
    assert.equal((await get(port, '/', 'POST')).status, 405);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

test('serve: port in use exits 2 with a message', async () => {
  const root = makeRoot();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  try {
    const port = blocker.address().port;
    const r = await run(['--root', root, '--serve', '--port', String(port)]);
    assert.equal(r.code, 2);
    assert.match(r.err, /already in use/);
  } finally {
    await new Promise((r) => blocker.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseTasks reads ticks, sprint, build and waits', () => {
  const parsed = parseTasks(taskFile('L'));
  assert.equal(parsed.tasks.length, 3);
  assert.deepEqual(parsed.tasks.map((t) => t.done), [true, false, false]);
  assert.equal(parsed.tasks[1].waits, 'L-01.');
  assert.equal(parsed.tasks[2].sprint, 2);
});
