import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { HostError, type SnippetError } from '../src/sandbox.ts';
import { createClient, DEFAULT_BASE_URL, send } from '../src/sevdesk.ts';
import { type MockResponse, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

const TOKEN = 'test-token-5f0c2a9e7b1d4c3e';
// Short waits so the retry tests stay fast: 20 ms, then 40 ms.
const FAST = { retries: 2, baseDelayMs: 20, maxDelayMs: 2_000 };
const contacts = { objects: [{ id: '1', objectName: 'Contact', name: 'MCP Test GmbH' }] };
const tooMany = { status: 429, json: { objects: null, error: { message: 'Too many requests' } } };
const unavailable = { status: 503, json: { objects: null, error: { message: 'Unavailable' } } };
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk for this test; `afterEach` closes it. */
async function mock(routes: MockRoutes) {
  const sevdesk = await startMockSevdesk(routes);
  closers.push(sevdesk.close);
  return sevdesk;
}

/** A route that answers `responses` in turn and then keeps answering the last one. */
function answers(...responses: MockResponse[]): () => MockResponse {
  let next = 0;
  return () => responses[Math.min(next++, responses.length - 1)] ?? {};
}

/** Sends `method path` to the mock sevDesk through the client's `send`; resolves to the JSON. */
function sendTo(
  method: string,
  path: string,
  retry: typeof FAST | false = FAST,
  signal = new AbortController().signal,
): Promise<unknown> {
  return send(
    { method, path, url: new URL(DEFAULT_BASE_URL + path) },
    { token: TOKEN, signal, retry },
  ).then((response) => response.json());
}

/** The client options of these tests, with a download directory in the temporary home. */
function clientOptions(baseUrl = DEFAULT_BASE_URL) {
  return { baseUrl, token: TOKEN, maxCalls: 1, downloadDir: join(homedir(), 'Downloads') };
}

/** The structured error a call rejects with; fails the test if it resolves. */
async function errorOf(call: Promise<unknown>): Promise<SnippetError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HostError) return error.error;
    throw error;
  }
  throw new Error('Expected the call to fail.');
}

/** The requests the mock received, as `METHOD /path`. */
function calls(requests: { method: string; path: string }[]): string[] {
  return requests.map(({ method, path }) => `${method} ${path}`);
}

test('a non-HTTPS base URL is rejected before any request is sent', () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);

  let thrown: unknown;
  try {
    createClient(clientOptions('http://my.sevdesk.de/api/v1'));
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
  const { request } = createClient(clientOptions());

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

test('a write that gets no answer stays in the ledger without a status', async () => {
  const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed', { cause })));
  const { request, writes } = createClient(clientOptions());

  const failed = request(
    ['POST', '/Contact', { body: { name: 'x' } }],
    new AbortController().signal,
  );

  await expect(failed).rejects.toMatchObject({ error: { kind: 'network_error' } });
  expect(writes).toEqual([{ method: 'POST', path: '/Contact' }]);
});

test('a 429 is retried for any method and the call succeeds on a later attempt', async () => {
  const methods = ['GET', 'POST', 'PUT', 'DELETE'];
  const sevdesk = await mock(
    Object.fromEntries(
      methods.map((method) => [`${method} /Contact`, answers(tooMany, { json: contacts })]),
    ),
  );

  const results: unknown[] = [];
  for (const method of methods) results.push(await sendTo(method, '/Contact'));

  expect(results).toEqual(methods.map(() => contacts));
  expect(calls(sevdesk.requests)).toEqual(
    methods.flatMap((method) => [`${method} /Contact`, `${method} /Contact`]),
  );
});

test('POST, PUT, PATCH and DELETE are never retried on 5xx, and no method on another 4xx', async () => {
  const writes = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const sevdesk = await mock({
    ...Object.fromEntries(writes.map((method) => [`${method} /Contact`, () => unavailable])),
    'POST /Invoice': () => ({ status: 500, json: { objects: null } }),
  });
  const sent = [...writes.map((method) => [method, '/Contact']), ['POST', '/Invoice']];

  const statuses: (number | undefined)[] = [];
  for (const [method = '', path = ''] of sent) {
    statuses.push((await errorOf(sendTo(method, path))).status);
  }
  const missing = await errorOf(sendTo('GET', '/Missing'));

  expect(statuses).toEqual([503, 503, 503, 503, 500]);
  expect(missing).toMatchObject({ kind: 'api_error', status: 404 });
  expect(calls(sevdesk.requests)).toEqual([
    ...sent.map(([method, path]) => `${String(method)} ${String(path)}`),
    'GET /Missing',
  ]);
});

test('a GET is retried on 5xx until it succeeds, at most `retries` times with doubling waits', async () => {
  const sevdesk = await mock({
    'GET /Contact': answers({ status: 500 }, { status: 502 }, { json: contacts }),
    'GET /Invoice': () => unavailable,
  });

  const recovered = await sendTo('GET', '/Contact');
  const started = performance.now();
  const exhausted = await errorOf(sendTo('GET', '/Invoice'));
  const elapsed = performance.now() - started;

  expect(recovered).toEqual(contacts);
  expect(exhausted).toEqual({
    kind: 'api_error',
    message: 'GET /Invoice returned HTTP 503.',
    status: 503,
    method: 'GET',
    path: '/Invoice',
    sevdeskMessage: 'Unavailable',
  });
  expect(calls(sevdesk.requests)).toEqual([
    ...Array<string>(3).fill('GET /Contact'),
    ...Array<string>(FAST.retries + 1).fill('GET /Invoice'),
  ]);
  // The waits before the two retries: 20 ms, then 40 ms (a little slack for timer rounding).
  expect(elapsed).toBeGreaterThanOrEqual(55);
});

test('Retry-After sets the wait; a wait longer than the policy allows is not retried', async () => {
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toUTCString();
  const sevdesk = await mock({
    'GET /Contact': answers({ ...tooMany, headers: { 'retry-after': '1' } }, { json: contacts }),
    'GET /Invoice': () => ({ ...tooMany, headers: { 'retry-after': '30' } }),
    'GET /Order': () => ({ ...tooMany, headers: { 'retry-after': at(60_000) } }),
    'GET /Voucher': answers(
      { ...unavailable, headers: { 'retry-after': at(-60_000) } },
      { json: contacts },
    ),
  });

  const started = performance.now();
  const waited = await sendTo('GET', '/Contact');
  const elapsed = performance.now() - started;
  const tooLong = [
    await errorOf(sendTo('GET', '/Invoice')),
    await errorOf(sendTo('GET', '/Order')),
  ];
  const pastDate = await sendTo('GET', '/Voucher');

  expect(waited).toEqual(contacts);
  expect(elapsed).toBeGreaterThanOrEqual(990);
  expect(tooLong.map((error) => error.status)).toEqual([429, 429]);
  expect(pastDate).toEqual(contacts);
  expect(calls(sevdesk.requests)).toEqual([
    'GET /Contact',
    'GET /Contact',
    'GET /Invoice',
    'GET /Order',
    'GET /Voucher',
    'GET /Voucher',
  ]);
});

test('retry: false sends a call exactly once, whatever the status', async () => {
  const sevdesk = await mock({ 'GET /Contact': () => tooMany, 'GET /Invoice': () => unavailable });

  const statuses = [
    (await errorOf(sendTo('GET', '/Contact', false))).status,
    (await errorOf(sendTo('GET', '/Invoice', false))).status,
  ];

  expect(statuses).toEqual([429, 503]);
  expect(calls(sevdesk.requests)).toEqual(['GET /Contact', 'GET /Invoice']);
});

test('an abort while waiting to retry fails the call at once with the last response error', async () => {
  const sevdesk = await mock({ 'GET /Invoice': () => unavailable });
  const controller = new AbortController();
  const slow = { retries: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 };

  const failed = errorOf(sendTo('GET', '/Invoice', slow, controller.signal));
  await vi.waitFor(() => {
    expect(sevdesk.requests).toHaveLength(1);
  });
  // The local response and its small body are read long before this; the call is in its wait.
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();

  expect(await failed).toEqual({
    kind: 'api_error',
    message: 'GET /Invoice returned HTTP 503.',
    status: 503,
    method: 'GET',
    path: '/Invoice',
    sevdeskMessage: 'Unavailable',
  });
  expect(sevdesk.requests).toHaveLength(1);
});
