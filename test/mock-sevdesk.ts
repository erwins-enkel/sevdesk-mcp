import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { DEFAULT_BASE_URL } from '../src/sevdesk.ts';

/** What a mock route answers: `json` by default, or `text` with its own content type. */
export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  /** Further response headers, e.g. `retry-after`. */
  headers?: Record<string, string>;
}

/** A request the mock received; `path` is relative to the API base. */
export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
}

/** Route handlers keyed by `METHOD /path` relative to the API base, e.g. `GET /Contact`. */
export type MockRoutes = Record<string, (request: MockRequest) => MockResponse>;

const base = new URL(DEFAULT_BASE_URL);

const defaultRoutes: MockRoutes = {
  'GET /Tools/bookkeepingSystemVersion': () => ({ json: { objects: { version: '2.0' } } }),
};

/**
 * Starts a mock sevDesk on a free port with `routes` over the defaults (a system 2.0 account;
 * anything else answers 404) and points the global `fetch` at it: calls to the real API base go
 * to the mock, any other URL throws, so a test never reaches sevDesk. The HTTPS base URL stays as
 * it is in the code under test. Undo with `vi.unstubAllGlobals()` and `close()`.
 */
export async function startMockSevdesk(routes: MockRoutes = {}) {
  const requests: MockRequest[] = [];
  const handlers = { ...defaultRoutes, ...routes };
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://mock');
    const request: MockRequest = {
      method: incoming.method ?? '',
      path: url.pathname.slice(base.pathname.length),
      query: url.searchParams,
      authorization: incoming.headers.authorization,
    };
    requests.push(request);
    const handler = handlers[`${request.method} ${request.path}`];
    const answer = handler
      ? handler(request)
      : { status: 404, json: { objects: null, error: { message: 'Not found' } } };
    response.writeHead(answer.status ?? 200, {
      'content-type': answer.contentType ?? 'application/json',
      ...answer.headers,
    });
    response.end(answer.text ?? JSON.stringify(answer.json));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (!url.startsWith(`${DEFAULT_BASE_URL}/`)) {
      throw new Error(`The test fetch reaches only the mock sevDesk, not ${url}`);
    }
    return realFetch(`http://127.0.0.1:${String(port)}${url.slice(base.origin.length)}`, init);
  });

  return {
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
