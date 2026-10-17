// Pure tests of scripts/load-check.mjs (story 8.3): arguments, statistics, verdict and report text. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, machineText, memoryStats, parseArgs, percentile, summarize, verdict } from './load-check.mjs';

test('arguments: defaults, --n, --target-s, and refusals', () => {
  assert.deepEqual(parseArgs([]), { n: 6, targetS: 60 });
  assert.deepEqual(parseArgs(['--n', '10', '--target-s', '90']), { n: 10, targetS: 90 });
  for (const bad of [['--n'], ['--n', '0'], ['--n', 'x'], ['--n', '51'], ['--bogus']]) assert.ok(parseArgs(bad).error, bad.join(' '));
});

test('percentile is nearest-rank; empty gives null', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
});

test('summary and verdict: PASS only when all are ready within the target', () => {
  const s = summarize([10, 20, 30, null]);
  assert.deepEqual([s.count, s.ready, s.failed, s.p50, s.max, s.min], [4, 3, 1, 20, 30, 10]);
  assert.equal(verdict([10, 20, 59.9], 60), 'PASS');
  assert.equal(verdict([10, 20, 60.1], 60), 'FAIL');
  assert.equal(verdict([10, null], 60), 'FAIL');
  assert.equal(verdict([], 60), 'FAIL');
});

test('memory statistics ignore missing readings', () => {
  assert.deepEqual(memoryStats([]), { count: 0, total: null, avg: null, max: null });
  const m = memoryStats([10, 30, null]);
  assert.deepEqual([m.count, m.total, m.avg, m.max], [2, 40, 20, 30]);
});

test('report: machine stated, laptop label, numbers, result word, nothing secret', () => {
  const machine = machineText({ cpus: { count: 8, model: 'Test CPU' }, ramGiB: 16, dockerCpus: 8, dockerRamGiB: 7.7 });
  const text = formatReport({ date: '2026-10-17', n: 3, targetS: 60, times: [11.2, 12.5, 14], mem: memoryStats([20, 22]), machine, leftover: 'containers 0, networks 0, volumes 0' });
  assert.match(text, /LAPTOP numbers/);
  assert.match(text, /8 logical CPUs \(Test CPU\), 16\.0 GiB RAM/);
  assert.match(text, /p50: 12\.5 s {3}max: 14\.0 s/);
  assert.match(text, /Result: PASS/);
  assert.match(formatReport({ date: 'd', n: 1, targetS: 60, times: [null], mem: memoryStats([]), machine, leftover: 'x' }), /NOT READY[\s\S]*Result: FAIL/);
});
