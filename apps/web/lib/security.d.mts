// Types of security.mjs (plain JavaScript so the unit tests run in Node without a build step).
export declare const ORIGIN_SECRET_HEADER: 'x-origin-secret';
export declare const NO_STORE: 'private, no-store';
export declare const DROPPED_FROM_BROWSER: string[];
export declare function makeNonce(): string;
export declare function buildCsp(options: { nonce: string; dev?: boolean; https?: boolean }): string;
export declare function fixedHeaders(options?: { https?: boolean }): Record<string, string>;
export declare function upstreamHeaders(incoming: Headers, options?: { secret?: string; host?: string; proto?: string }): Headers;
export declare function upstreamUrl(apiOrigin: string, pathname: string, search?: string): URL;
