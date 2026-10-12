// Typed client of the browser API (IF-1 platform, IF-2 lab). The types in ./api.d.ts are generated from the bundle;
// this file is the small hand-written part: cookies, the CSRF header and the error body.
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { components, paths } from './api.ts';

export type { components, paths } from './api.ts';
export * from './error-codes.ts';

export type ApiClient = Client<paths>;
export type Problem = components['schemas']['Problem'];

export interface ApiClientOptions {
  /** Origin of the API, for example `https://vulnmart.example`. Empty string for same-origin calls. */
  baseUrl?: string;
  /** The CSRF token of the current session (`Session.csrf_token`); sent in `X-CSRF-Token` on every unsafe request. */
  csrfToken?: () => string | undefined;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: typeof fetch;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? '',
    credentials: 'include', // the session lives in the __Host-vm_session cookie
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const csrf: Middleware = {
    onRequest({ request }) {
      const token = options.csrfToken?.();
      if (token && !SAFE_METHODS.has(request.method.toUpperCase())) request.headers.set('X-CSRF-Token', token);
      return request;
    },
  };
  client.use(csrf);
  return client;
}

/** True when a value is an error body of IF-8 (the closed problem body). */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.type === 'string' && typeof v.status === 'number' && typeof v.request_id === 'string';
}
