// The skip budget of pytest (scripts/check-pytest-skips.mjs): service skips are counted, other skips are not, and a result over the budget fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseArgs, skipsOf, summarize } from './check-pytest-skips.mjs';

const XML = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="0" skipped="4" tests="7">
<testcase classname="a" name="t1"/>
<testcase classname="a" name="t2"><skipped type="pytest.skip" message="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN">x</skipped></testcase>
<testcase classname="a" name="t3"><skipped type="pytest.skip" message="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN"/></testcase>
<testcase classname="b" name="t4"><skipped type="pytest.skip" message="needs VULNMART_TEST_VALKEY_URL">x</skipped></testcase>
<testcase classname="c" name="t5"><skipped type="pytest.skip" message="node is not installed"/></testcase>
<testcase classname="c" name="t6"/><testcase classname="c" name="t7"/>
</testsuite></testsuites>`;

test('skips are read from the junit file and only the service skips are counted', () => {
  assert.equal(skipsOf(XML).length, 4);
  assert.deepEqual(summarize(XML), { tests: 7, skipped: 4, envSkipped: 3, byService: { VULNMART_TEST_POSTGRES_DSN: 2, VULNMART_TEST_VALKEY_URL: 1 } });
});

test('within the budget passes, over it fails, and a junit file with no tests fails', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skips-')), 'junit.xml');
  fs.writeFileSync(f, XML);
  const quiet = (fn) => { const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {}; try { return fn(); } finally { console.log = log; console.error = err; } };
  assert.equal(quiet(() => main(['--junit', f, '--max-env-skips', '3'])), 0);
  assert.equal(quiet(() => main(['--junit', f, '--max-env-skips', '2'])), 1);
  assert.equal(quiet(() => main(['--junit', f, '--max-env-skips', '0'])), 1, 'the api job allows none');
  fs.writeFileSync(f, '<testsuites><testsuite tests="0"></testsuite></testsuites>');
  assert.equal(quiet(() => main(['--junit', f, '--max-env-skips', '99'])), 1);
});

test('bad arguments are refused', () => {
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(['--junit', 'x']).error);
  assert.ok(parseArgs(['--junit', 'x', '--max-env-skips', '-1']).error);
  assert.ok(parseArgs(['--junit', 'x', '--max-env-skips', '1', '--what']).error);
  assert.equal(main(['--junit', path.join(os.tmpdir(), 'no-such-junit.xml'), '--max-env-skips', '1']), 2);
});
