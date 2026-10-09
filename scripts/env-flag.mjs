// One rule for the environment switches of the tests: a switch is on only when its value is exactly `true` or `1`
// (any case, spaces around are ignored). `false`, `0`, an empty value and an unset variable are all off.
// Used for CI (a missing openssl is a failure only on CI) and VULNMART_E2E_SKIP_NESTED_PYTEST. The Python twin is `flag_on` in apps/api/tests/support.py.
export const flagOn = (value) => ['true', '1'].includes(String(value ?? '').trim().toLowerCase());
