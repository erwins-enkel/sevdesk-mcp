import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { connect, envelopeOf } from './connect.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

const TOKEN = 'test-token-5f0c2a9e7b1d4c3e';
const CHECK = '/Tools/bookkeepingSystemVersion';
const contacts = { objects: [{ id: '1', objectName: 'Contact', name: 'MCP Test GmbH' }] };
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv('SEVDESK_API_TOKEN', TOKEN);
  vi.stubEnv('SEVDESK_PROFILE', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk for this test; `afterEach` closes it. */
async function mock(routes?: MockRoutes) {
  const sevdesk = await startMockSevdesk(routes);
  closers.push(sevdesk.close);
  return sevdesk;
}

/** The requests the code made, without the bookkeeping-system check. */
function snippetCalls(requests: MockRequest[]): string[] {
  return requests
    .filter((request) => request.path !== CHECK)
    .map((request) => `${request.method} ${request.path}`);
}

async function execute(client: Client, code: string) {
  const result = await client.callTool({ name: 'execute', arguments: { code } });
  return {
    isError: result.isError === true,
    envelope: envelopeOf(result),
    text: JSON.stringify(result),
  };
}

/** Runs `code` through `execute` on a fresh connection (a fresh session). */
async function executeOnce(code: string) {
  const client = await connect();
  try {
    return await execute(client, code);
  } finally {
    await client.close();
  }
}

test('a GET of /Contact returns the mock contacts; the token travels only in the request header', async () => {
  const sevdesk = await mock({ 'GET /Contact': () => ({ json: contacts }) });

  const { isError, envelope, text } = await executeOnce(`
    const response = await sevdesk.request('GET', '/Contact', { query: { depth: 1 } });
    const scope = [
      Object.getOwnPropertyNames(globalThis),
      Object.getOwnPropertyNames(sevdesk),
      Object.getOwnPropertyNames(sevdesk.request),
      String(sevdesk.request),
    ];
    console.log(JSON.stringify(scope));
    return { contacts: response.objects, scope };`);

  expect(isError).toBe(false);
  expect(envelope.result).toMatchObject({ contacts: contacts.objects });
  expect(envelope.console).toHaveLength(1);
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Contact']);
  expect(sevdesk.requests.find((r) => r.path === '/Contact')?.query.get('depth')).toBe('1');
  expect(sevdesk.requests.map((r) => r.authorization)).toEqual([TOKEN, TOKEN]);
  expect(text).not.toContain(TOKEN);
});

test('absolute URLs, other hosts, path escapes and malformed calls are rejected before any request', async () => {
  const sevdesk = await mock();
  const paths = [
    'https://evil.example/Contact',
    'http://my.sevdesk.de/api/v1/Contact',
    '//evil.example/Contact',
    'Contact',
    '/../Contact',
    '/Contact/..',
    '/%2e%2e/Contact',
    '/Invoice/1/get%50df',
    '/\\evil.example/Contact',
    '/Contact?depth=1',
    '/Contact#x',
    '/Con\ntact',
    '/Contact/',
    '',
  ];
  const calls = [
    ...paths.map((path) => ['GET', path]),
    [1, '/Contact'],
    ['FETCH', '/Contact'],
    ['GET', '/Contact', 'depth=1'],
    ['GET', '/Contact', { params: { depth: 1 } }],
    ['GET', '/Contact', { body: { name: 'x' } }],
    ['GET', '/Contact', { query: { depth: { a: 1 } } }],
  ];

  const { envelope } = await executeOnce(`
    const kinds = [];
    for (const call of ${JSON.stringify(calls)}) {
      try { await sevdesk.request(...call); kinds.push('sent'); } catch (e) { kinds.push(e.kind); }
    }
    return kinds;`);

  expect(envelope.result).toEqual(calls.map(() => 'invalid_request'));
  expect(snippetCalls(sevdesk.requests)).toEqual([]);
});

test('without a profile the server starts, search works and execute returns a setup hint', async () => {
  vi.stubEnv('SEVDESK_API_TOKEN', undefined);
  const sevdesk = await mock();

  const client = await connect();
  const { tools } = await client.listTools();
  const searched = await client.callTool({
    name: 'search',
    arguments: { code: 'return Object.keys(spec.paths).includes("/Contact")' },
  });
  const executed = await execute(client, 'return 1');
  await client.close();

  expect(tools.map((tool) => tool.name).sort()).toEqual(['execute', 'search']);
  expect(envelopeOf(searched)).toEqual({ result: true });
  expect(executed.isError).toBe(true);
  expect(executed.envelope).toEqual({
    error: {
      kind: 'setup_required',
      message: 'No sevDesk account is set up for this server.',
      hint: expect.stringContaining('SEVDESK_API_TOKEN') as string,
    },
  });
  expect(sevdesk.requests).toEqual([]);
});

test('an invalid SEVDESK_PROFILE fails closed without a request', async () => {
  vi.stubEnv('SEVDESK_PROFILE', '../evil');
  const sevdesk = await mock();

  const { isError, envelope } = await executeOnce('return 1');

  expect(isError).toBe(true);
  expect(envelope.error).toMatchObject({ kind: 'invalid_profile' });
  expect(sevdesk.requests).toEqual([]);
});

test('the bookkeeping system is checked once per session on the first execute, not at startup', async () => {
  const sevdesk = await mock();

  const client = await connect();
  await client.listTools();
  await client.callTool({ name: 'search', arguments: { code: 'return 1' } });
  const atStartup = sevdesk.requests.length;
  const first = await execute(client, 'return 1');
  const second = await execute(client, 'return 2');
  await client.close();
  const nextSession = await executeOnce('return 3');

  expect(atStartup).toBe(0);
  expect([first, second, nextSession].map(({ envelope }) => envelope.result)).toEqual([1, 2, 3]);
  expect(sevdesk.requests.map((request) => request.path)).toEqual([CHECK, CHECK]);
});

test('an account on another bookkeeping system gets a clear error and no further calls', async () => {
  const sevdesk = await mock({
    [`GET ${CHECK}`]: () => ({ json: { objects: { version: '1.0' } } }),
    'GET /Contact': () => ({ json: contacts }),
  });

  const client = await connect();
  const first = await execute(client, "return await sevdesk.request('GET', '/Contact')");
  const second = await execute(client, "return await sevdesk.request('GET', '/Contact')");
  await client.close();

  const error = {
    kind: 'unsupported_account',
    message:
      'The sevDesk account of profile env uses bookkeeping system 1.0; sevdesk-mcp supports only system 2.0.',
  };
  expect(first).toMatchObject({ isError: true, envelope: { error } });
  expect(second).toMatchObject({ isError: true, envelope: { error } });
  expect(sevdesk.requests.map((request) => request.path)).toEqual([CHECK]);
});

test('a failed bookkeeping check returns its error and runs again on the next execute', async () => {
  let checks = 0;
  const sevdesk = await mock({
    [`GET ${CHECK}`]: () =>
      (checks += 1) === 1
        ? { status: 401, json: { objects: null, error: { message: 'Authentication required' } } }
        : { json: { objects: { version: '2.0' } } },
  });

  const client = await connect();
  const first = await execute(client, 'return 1');
  const second = await execute(client, 'return 2');
  await client.close();

  expect(first.isError).toBe(true);
  expect(first.envelope.error).toEqual({
    kind: 'api_error',
    message: `GET ${CHECK} returned HTTP 401.`,
    status: 401,
    method: 'GET',
    path: CHECK,
    sevdeskMessage: 'Authentication required',
    hint: expect.stringContaining('SEVDESK_API_TOKEN') as string,
  });
  expect(second.envelope.result).toBe(2);
  expect(sevdesk.requests.map((request) => request.path)).toEqual([CHECK, CHECK]);
});

test('an API error is catchable in the code; uncaught it returns the agreed error shape', async () => {
  await mock({
    'GET /Contact/404': () => ({
      status: 404,
      json: { objects: null, error: { message: 'Contact not found' } },
    }),
    'GET /Contact': () => ({
      status: 401,
      json: { objects: null, error: { message: 'Authentication required' } },
    }),
    'GET /Invoice': () => ({
      status: 403,
      json: { objects: null, error: { message: 'You may not see invoices' } },
    }),
  });

  const client = await connect();
  const caught = await execute(
    client,
    "try { await sevdesk.request('GET', '/Contact/404') } catch (e) { return { kind: e.kind, status: e.status, sevdeskMessage: e.sevdeskMessage, message: e.message } }",
  );
  const unauthorized = await execute(client, "await sevdesk.request('GET', '/Contact')");
  const forbidden = await execute(
    client,
    "try { await sevdesk.request('GET', '/Invoice') } catch (e) { e.message = 'changed'; throw e }",
  );
  await client.close();

  expect(caught).toMatchObject({
    isError: false,
    envelope: {
      result: {
        kind: 'api_error',
        status: 404,
        sevdeskMessage: 'Contact not found',
        message: 'GET /Contact/404 returned HTTP 404.',
      },
    },
  });
  expect(unauthorized.isError).toBe(true);
  expect(unauthorized.envelope).toEqual({
    error: {
      kind: 'api_error',
      message: 'GET /Contact returned HTTP 401.',
      status: 401,
      method: 'GET',
      path: '/Contact',
      sevdeskMessage: 'Authentication required',
      hint: expect.stringContaining('SEVDESK_API_TOKEN') as string,
    },
  });
  expect(forbidden.isError).toBe(true);
  expect(forbidden.envelope).toEqual({
    error: {
      kind: 'api_error',
      message: 'GET /Invoice returned HTTP 403.',
      status: 403,
      method: 'GET',
      path: '/Invoice',
      sevdeskMessage: 'You may not see invoices',
    },
  });
  expect(unauthorized.text + forbidden.text).not.toContain(TOKEN);
});

test('a run that exceeds the call budget stops with a structured error, even when the code catches', async () => {
  const sevdesk = await mock({ 'GET /Contact': () => ({ json: contacts }) });

  const { isError, envelope } = await executeOnce(`
    let done = 0;
    for (let i = 0; i < 60; i++) {
      try { await sevdesk.request('GET', '/Contact'); done++; } catch { /* keep going */ }
    }
    return done;`);

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'call_budget',
    message:
      'The run reached the limit of 50 sevDesk calls and was stopped; GET /Contact was not sent.',
    hint: expect.any(String) as string,
  });
  expect(snippetCalls(sevdesk.requests)).toHaveLength(50);
});

test('writes and irreversible reads are rejected and never sent', async () => {
  const pdf = { objects: { filename: 'RE-1.pdf', mimeType: 'application/pdf' } };
  const exportJob = { objects: { id: 'job-1' } };
  const sevdesk = await mock({
    'GET /Invoice/1/getPdf': () => ({ json: pdf }),
    'GET /Export/createDatevCsvZipExportJob': () => ({ json: exportJob }),
  });

  const { envelope } = await executeOnce(`
    const calls = [
      ['POST', '/Contact', { body: { name: 'x' } }],
      ['put', '/Contact/1', { body: {} }],
      ['DELETE', '/Contact/1'],
      ['PATCH', '/Contact/1'],
      ['GET', '/Invoice/1/getPdf'],
      ['GET', '/Invoice/1/getPdf', { query: { preventSendBy: false } }],
      ['GET', '/Order/1/GETPDF', { query: { download: true } }],
      ['GET', '/CreditNote/1/sendByWithRender', { query: { sendType: 'PRN' } }],
      ['GET', '/Invoice/1/sendBy'],
      ['GET', '/Export/datevCSV', { query: { enshrine: true } }],
      ['GET', '/Export/createDatevCsvZipExportJob', { query: { enshrineDocuments: 1 } }],
    ];
    const kinds = [];
    for (const call of calls) {
      try { await sevdesk.request(...call); kinds.push('sent'); } catch (e) { kinds.push(e.kind); }
    }
    const allowed = await sevdesk.request('GET', '/Invoice/1/getPdf', { query: { preventSendBy: true } });
    const job = await sevdesk.request('GET', '/Export/createDatevCsvZipExportJob', {
      query: { enshrineDocuments: false, includeEnshrined: true },
    });
    return { kinds, allowed, job };`);

  expect(envelope.result).toEqual({
    kinds: Array(11).fill('not_enabled'),
    allowed: pdf,
    job: exportJob,
  });
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'GET /Invoice/1/getPdf',
    'GET /Export/createDatevCsvZipExportJob',
  ]);
  expect(
    sevdesk.requests.find((r) => r.path === '/Invoice/1/getPdf')?.query.get('preventSendBy'),
  ).toBe('true');
});

test('a non-JSON response is rejected and its content never reaches the result', async () => {
  await mock({
    'GET /Export/datevCSV': () => ({ contentType: 'text/csv', text: 'secret;csv;row' }),
  });

  const { isError, envelope, text } = await executeOnce(
    "return await sevdesk.request('GET', '/Export/datevCSV')",
  );

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'not_enabled',
    message:
      'GET /Export/datevCSV returned text/csv, not JSON; non-JSON responses are not enabled yet.',
    method: 'GET',
    path: '/Export/datevCSV',
  });
  expect(text).not.toContain('secret;csv;row');
});
