// Compile-time test of the generated client: `pnpm --filter @vulnmart/ts-client typecheck` must pass.
// A line with @ts-expect-error must fail to compile, otherwise tsc reports it as unused.
import { createApiClient, ERROR_CODES, isProblem, type components, type paths } from '../src/index.ts';

const api = createApiClient({ baseUrl: 'http://localhost:3000', csrfToken: () => 'token' });

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => undefined;

export async function calls(): Promise<void> {
  const health = await api.GET('/api/v1/health');
  if (health.data) assertType<Equal<typeof health.data.status, 'ok' | 'degraded'>>();

  const login = await api.POST('/api/v1/session', { body: { email: 'a@example.org', password: 'correct horse battery' } });
  if (login.data) assertType<Equal<typeof login.data.status, 'authenticated' | 'mfa_required'>>();
  if (login.error) assertType<Equal<typeof login.error, components['schemas']['Problem']>>();

  const challenge = await api.GET('/api/v1/challenges/{challenge_key}', { params: { path: { challenge_key: 'C03' } } });
  if (challenge.data) assertType<Equal<typeof challenge.data.challenge_key, string>>();

  // a path that is not in the bundle
  // @ts-expect-error no such operation
  await api.GET('/api/v1/no-such-path');

  // the body is checked
  // @ts-expect-error password is required
  await api.POST('/api/v1/session', { body: { email: 'a@example.org' } });

  // path parameters are required
  // @ts-expect-error challenge_key is required
  await api.GET('/api/v1/challenges/{challenge_key}');
}

assertType<Equal<keyof paths extends `/api/v1/${string}` ? true : false, true>>();
assertType<Equal<(typeof ERROR_CODES)['AUTH_INVALID_CREDENTIALS'], 'AUTH-INVALID-CREDENTIALS'>>();
assertType<Equal<ReturnType<typeof isProblem>, boolean>>();
