import { afterEach, expect, test, vi } from 'vitest';
import { HostError } from '../src/sandbox.ts';
import { createClient, DEFAULT_BASE_URL } from '../src/sevdesk.ts';

const TOKEN = 'test-token-5f0c2a9e7b1d4c3e';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a non-HTTPS base URL is rejected before any request is sent', () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);

  let thrown: unknown;
  try {
    createClient({ baseUrl: 'http://my.sevdesk.de/api/v1', token: TOKEN, maxCalls: 1 });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(HostError);
  expect(thrown).toMatchObject({ error: { kind: 'invalid_base_url' } });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a network failure reports only the error code, never the error text', async () => {
  const cause = Object.assign(new Error(`invalid header value ${TOKEN}`), { code: 'ECONNREFUSED' });
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed', { cause })));
  const request = createClient({ baseUrl: DEFAULT_BASE_URL, token: TOKEN, maxCalls: 1 });

  const failed = request(['GET', '/Contact'], new AbortController().signal);

  await expect(failed).rejects.toMatchObject({
    error: {
      kind: 'network_error',
      message: 'GET /Contact could not reach sevDesk (ECONNREFUSED).',
      method: 'GET',
      path: '/Contact',
    },
  });
});
