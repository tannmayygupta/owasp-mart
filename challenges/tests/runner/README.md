# Exploit test runner (TB-4)

The runner executes a challenge **exploit test** against any instance base URL
and reports one of three outcomes:

| Outcome | Meaning | CLI exit |
|---|---|---|
| `passed` | the exploit held — the target is **vulnerable** | 0 |
| `failed` | an assertion threw — the target is **fixed** (not exploitable) | 1 |
| `errored` | the test could not run (network, timeout, bug) | 3 |
| usage error | bad or missing CLI arguments | 2 |

An exploit test is an ES module whose default export is an async function. It
receives `baseUrl`, a `fetch` bound to the run's timeout, and the run's
`AbortController` `signal` (pass it to any I/O the test starts itself):

```js
import assert from 'node:assert/strict';
export default async function exploit({ baseUrl, fetch, signal }) {
  const res = await fetch(`${baseUrl}/orders/999`);
  assert.equal(res.status, 200);        // holds on vulnerable, throws on fixed
}
```

Each real challenge (T-19..T-29) ships its exploit at `challenges/tests/cNN/`.
The CI release gate (T-31) will run them all and block a release when a build
meant to be fixed is still exploitable. Keeping `failed` distinct from `errored`
is what makes that gate trustworthy: a flaky network is not a passing build.

## Run one exploit by hand

```bash
MODE=vulnerable node challenges/tests/_example/stub.mjs 8099 &
node challenges/tests/runner/run-exploit.mjs --url http://127.0.0.1:8099 --test challenges/tests/_example/exploit.mjs
# PASS (vulnerable). Re-run with MODE=fixed to see FAIL (fixed).
```

## Run the self-test

```bash
node --test "challenges/tests/**/*.test.mjs"
```

`challenges/tests/_example/` is the worked demo (a tiny broken-access-control
stub). It is not a real challenge.
