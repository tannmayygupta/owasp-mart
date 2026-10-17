// Tests of scripts/crs-accuracy.mjs (story 6.5): the real corpus is well formed, bad corpora are refused, the table is written with a fake helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCorpus, summarize, percentile, parseArgs, main, DEFAULT_CORPUS, parseStatus } from './crs-accuracy.mjs';

const corpus = JSON.parse(fs.readFileSync(DEFAULT_CORPUS, 'utf8'));

test('the real corpus is well formed: all 11 challenges, 50 or more benign, no flag-shaped text', () => {
  assert.deepEqual(validateCorpus(corpus), []);
  const ex = corpus.requests.filter((r) => r.kind === 'exploit');
  assert.deepEqual([...new Set(ex.map((r) => r.challenge))].sort(), ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11']);
  assert.ok(corpus.requests.filter((r) => r.kind === 'benign').length >= 50);
  assert.ok(!/[Vv][Mm]\{/.test(JSON.stringify(corpus)), 'no flag shape');
  for (const k of ['C01', 'C02', 'C04', 'C08', 'C09', 'C11']) assert.ok(ex.filter((r) => r.challenge === k).every((r) => r.expected === 'none'), `${k} expects none`);
});

test('a corpus format error is reported for each kind of mistake', () => {
  const ok = corpus.requests;
  assert.ok(validateCorpus({}).length);
  assert.ok(validateCorpus({ requests: ok.slice(0, 10) }).some((e) => /50 benign/.test(e)));
  const bad = (patch) => validateCorpus({ requests: [{ ...ok[0], ...patch }, ...ok.slice(1)] });
  assert.ok(bad({ kind: 'x' }).some((e) => /kind/.test(e)));
  assert.ok(bad({ expected: 'rce?' }).some((e) => /expected/.test(e)));
  assert.ok(bad({ method: 'FETCH' }).some((e) => /method/.test(e)));
  assert.ok(bad({ uri: 'api' }).some((e) => /uri/.test(e)));
  assert.ok(bad({ headers: [] }).some((e) => /headers/.test(e)));
  assert.ok(bad({ challenge: 'C99' }).some((e) => /challenge/.test(e)));
  assert.ok(bad({ id: ok[1].id }).some((e) => /duplicate/.test(e)));
});

test('percentile, status parsing and argument parsing', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(s, 50), 50); assert.equal(percentile(s, 95), 95); assert.equal(percentile(s, 99), 99);
  assert.ok(Number.isNaN(percentile([], 50)));
  assert.deepEqual(parseStatus('VmPeak:\t 9 kB\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\n'), { rssKb: 1024, hwmKb: 2048 });
  assert.equal(parseArgs(['--calls', '10']).calls, 10);
  assert.throws(() => parseArgs(['--calls']), /bad argument/);
  assert.throws(() => parseArgs(['--calls', '0']), /positive/);
});

test('summarize: detected, right family and the false-positive rate come from the answers', () => {
  const c = { requests: [
    { id: 'e1', kind: 'exploit', challenge: 'C03', expected: 'sqli', expect_tags: ['attack_sqli'], method: 'GET', uri: '/', headers: {} },
    { id: 'e2', kind: 'exploit', challenge: 'C01', expected: 'none', expect_tags: [], method: 'GET', uri: '/', headers: {} },
    { id: 'b1', kind: 'benign', expected: 'none', expect_tags: [], method: 'GET', uri: '/', headers: {} },
    { id: 'b2', kind: 'benign', expected: 'none', expect_tags: [], method: 'GET', uri: '/', headers: {} },
  ] };
  const s = summarize(c, [{ rule_ids: ['942100'], tags: ['attack-sqli'], anomaly_score: 5 }, { rule_ids: [], tags: [], anomaly_score: 0 }, { rule_ids: ['920180'], tags: ['attack-protocol'], anomaly_score: 3 }, { rule_ids: [], tags: [], anomaly_score: 0 }]);
  assert.equal(s.rows[0].familyOk, true);
  assert.equal(s.rows[1].detected, false); assert.equal(s.rows[1].familyOk, true);
  assert.equal(s.fp.length, 1); assert.equal(s.fp5.length, 0);
});

test('a run against a fake helper writes the table with the labels, the latency line and no false claim; a corpus error exits 1 and writes nothing', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => {
      const doc = JSON.parse(Buffer.concat(c).toString('utf8'));
      seen.push(doc);
      const hit = /union%20select/i.test(doc.uri);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hit ? { rule_ids: ['942100'], tags: ['attack-sqli', 'language-multi'], anomaly_score: 5 } : { rule_ids: [], tags: [], anomaly_score: 0 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-acc-'));
  const out = path.join(dir, 's6.md');
  const log = console.log; console.log = () => {};
  try {
    const code = await main(['--url', `http://127.0.0.1:${server.address().port}`, '--calls', '40', '--out', out, '--label', 'test label']);
    assert.equal(code, 0);
    const md = fs.readFileSync(out, 'utf8');
    assert.match(md, /Measured: test label\./);
    assert.match(md, /\/inspect latency over 40 calls/);
    assert.match(md, /\| C03A-a \| C03 \| sqli \| yes \| yes \| attack_sqli, language_multi \|/);
    assert.match(md, /\| C01-a \| C01 \| none \| no \| yes \|/);
    assert.match(md, /False positives \(at least one CRS attack rule\): 0, rate 0\.0%/);
    assert.ok(seen.every((d) => !('cookie' in d.headers) && !('authorization' in d.headers)), 'the sidecar document builder was used');
    assert.ok(seen.filter((d) => d.method === 'POST' && d.body).every((d) => d.headers['content-length']), 'content-length added for bodies');
    // a corpus format error: exit 1, nothing written
    const badCorpus = path.join(dir, 'bad.json'); fs.writeFileSync(badCorpus, JSON.stringify({ requests: [{ id: 'x' }] }));
    const out2 = path.join(dir, 'no.md');
    const err = console.error; console.error = () => {};
    try { assert.equal(await main(['--url', 'http://127.0.0.1:1', '--corpus', badCorpus, '--out', out2]), 1); } finally { console.error = err; }
    assert.equal(fs.existsSync(out2), false);
  } finally { console.log = log; server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
