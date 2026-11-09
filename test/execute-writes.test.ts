import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { connect, envelopeOf } from './connect.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// Writes through `execute` (PRD §6, decisions 6, 7 and 11): reversible writes run and enter the
// ledger (`writes`), every irreversible call is refused before it reaches the mock sevDesk.

const TOKEN = 'test-token-3d8b6f';
const CHECK = '/Tools/bookkeepingSystemVersion';
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv('SEVDESK_API_TOKEN', TOKEN);
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
function snippetRequests(requests: MockRequest[]): MockRequest[] {
  return requests.filter((request) => request.path !== CHECK);
}

function snippetCalls(requests: MockRequest[]): string[] {
  return snippetRequests(requests).map((request) => `${request.method} ${request.path}`);
}

/** Runs `code` through `execute` on a fresh connection (a fresh session). */
async function executeOnce(code: string) {
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'execute', arguments: { code } });
    return { isError: result.isError === true, envelope: envelopeOf(result) };
  } finally {
    await client.close();
  }
}

test('execute carries the destructive annotation', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();

  expect(tools.find((tool) => tool.name === 'execute')?.annotations).toMatchObject({
    destructiveHint: true,
  });
});

test('a snippet creates a contact and an offer draft; the ledger lists both writes', async () => {
  const sevdesk = await mock({
    'POST /Contact': () => ({
      status: 201,
      json: {
        objects: {
          id: '7',
          objectName: 'Contact',
          category: { id: '3', objectName: 'Category' },
        },
      },
    }),
    'POST /Order/Factory/saveOrder': () => ({
      status: 201,
      json: {
        objects: {
          order: { id: '42', objectName: 'Order' },
          orderPos: [{ id: '43', objectName: 'OrderPos' }],
        },
      },
    }),
  });
  const contact = { name: 'MCP Test GmbH', category: { id: 3, objectName: 'Category' } };
  const order = { objectName: 'Order', mapAll: true, orderType: 'AN', status: 100, version: 0 };
  const positions = [{ objectName: 'OrderPos', mapAll: true, quantity: 3, price: 1200 }];

  const { isError, envelope } = await executeOnce(`
    const contact = await sevdesk.request('POST', '/Contact', { body: ${JSON.stringify(contact)} });
    const order = { ...${JSON.stringify(order)}, contact: { id: contact.objects.id, objectName: 'Contact' } };
    const saved = await sevdesk.request('POST', '/Order/Factory/saveOrder', {
      body: { order, orderPosSave: ${JSON.stringify(positions)} },
    });
    return { contactId: contact.objects.id, offerId: saved.objects.order.id };`);

  expect(isError).toBe(false);
  expect(envelope).toEqual({
    result: { contactId: '7', offerId: '42' },
    writes: [
      { method: 'POST', path: '/Contact', status: 201, objectId: '7' },
      { method: 'POST', path: '/Order/Factory/saveOrder', status: 201, objectId: '42' },
    ],
  });
  const sent = snippetRequests(sevdesk.requests);
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'POST /Contact',
    'POST /Order/Factory/saveOrder',
  ]);
  expect(sent.map((request) => request.contentType)).toEqual([
    'application/json',
    'application/json',
  ]);
  expect(sent.map((request) => JSON.parse(request.body) as unknown)).toEqual([
    contact,
    {
      order: { ...order, contact: { id: '7', objectName: 'Contact' } },
      orderPosSave: positions,
    },
  ]);
});

test('when the code throws after a write, the error result still carries the ledger', async () => {
  await mock({
    'PUT /Contact/7': () => ({ json: { objects: { id: '7', objectName: 'Contact' } } }),
  });

  const { isError, envelope } = await executeOnce(`
    await sevdesk.request('PUT', '/Contact/7', { body: { name: 'Neu GmbH' } });
    throw new Error('a later step failed');`);

  expect(isError).toBe(true);
  expect(envelope).toEqual({
    error: { kind: 'snippet_error', message: 'Error: a later step failed' },
    writes: [{ method: 'PUT', path: '/Contact/7', status: 200, objectId: '7' }],
  });
});

test('a rejected write is in the ledger with its status; one answered 5xx is sent once and flagged', async () => {
  const sevdesk = await mock({
    'POST /Contact': () => ({
      status: 422,
      json: { objects: null, error: { message: 'name is required' } },
    }),
    'PUT /Contact/7': () => ({ status: 500, json: { objects: null } }),
  });

  const { isError, envelope } = await executeOnce(`
    const statuses = [];
    for (const call of [['POST', '/Contact', { body: {} }], ['PUT', '/Contact/7', { body: { name: 'x' } }]]) {
      try { await sevdesk.request(...call); statuses.push('ok'); } catch (e) { statuses.push(e.status); }
    }
    return statuses;`);

  expect(isError).toBe(false);
  expect(envelope).toEqual({
    result: [422, 500],
    writes: [
      { method: 'POST', path: '/Contact', status: 422 },
      { method: 'PUT', path: '/Contact/7', status: 500 },
    ],
    notes: [expect.stringContaining('may still have been applied') as string],
  });
  expect(snippetCalls(sevdesk.requests)).toEqual(['POST /Contact', 'PUT /Contact/7']);
});

test('a malformed write is rejected before any request', async () => {
  const sevdesk = await mock();
  const calls = [
    ['POST', '/Contact', { body: 'name=x' }],
    ['POST', '/Contact', { body: [{ name: 'x' }] }],
    ['POST', '/Contact', { data: { name: 'x' } }],
    ['HEAD', '/Contact'],
  ];

  const { envelope } = await executeOnce(`
    const kinds = [];
    for (const call of ${JSON.stringify(calls)}) {
      try { await sevdesk.request(...call); kinds.push('sent'); } catch (e) { kinds.push(e.kind); }
    }
    return kinds;`);

  expect(envelope).toEqual({ result: calls.map(() => 'invalid_request') });
  expect(snippetCalls(sevdesk.requests)).toEqual([]);
});

/** Each class of irreversible calls in PRD §6, with calls of it: `[method, path, options?]`. */
const irreversible: { name: string; calls: [string, string, object?][] }[] = [
  {
    name: 'DELETE',
    calls: [
      ['DELETE', '/Contact/1'],
      ['DELETE', '/Order/1'],
    ],
  },
  {
    name: 'sending',
    calls: [
      ['POST', '/Order/1/sendViaEmail', { body: { toEmail: 'max@example.com', subject: 'AN-1' } }],
      ['PUT', '/Invoice/1/sendBy', { body: { sendType: 'VPDF', sendDraft: false } }],
      ['GET', '/CreditNote/1/sendByWithRender', { query: { sendType: 'PRN' } }],
      ['GET', '/Invoice/1/sendBy'],
    ],
  },
  {
    name: 'enshrining and booking',
    calls: [
      ['PUT', '/Invoice/1/enshrine'],
      ['PUT', '/Voucher/1/bookAmount', { body: { amount: 119, date: '09.11.2026', type: 'N' } }],
      ['GET', '/Export/datevCSV', { query: { enshrine: true } }],
      ['GET', '/Export/createDatevCsvZipExportJob', { query: { enshrineDocuments: 1 } }],
    ],
  },
  { name: 'cancelling', calls: [['POST', '/Invoice/1/cancelInvoice']] },
  {
    name: 'resetting',
    calls: [
      ['PUT', '/Invoice/1/resetToOpen'],
      ['PUT', '/CreditNote/1/resetToDraft'],
    ],
  },
  {
    name: 'a status change in the body',
    calls: [
      ['PUT', '/Order/1', { body: { status: 200 } }],
      ['POST', '/Order/Factory/saveOrder', { body: { order: { status: 200 } } }],
      ['POST', '/Invoice/Factory/saveInvoice', { body: { invoice: { id: 5, status: 100 } } }],
    ],
  },
  {
    name: 'getPdf without preventSendBy=true',
    calls: [
      ['GET', '/Invoice/1/getPdf'],
      ['GET', '/Order/1/getPdf', { query: { preventSendBy: false } }],
      ['GET', '/Order/1/GETPDF', { query: { download: true } }],
    ],
  },
  {
    name: 'an unknown write path',
    calls: [
      ['POST', '/Foo', { body: {} }],
      ['PATCH', '/Contact/1', { body: { name: 'x' } }],
      ['PUT', '/Contact/abc', { body: { name: 'x' } }],
      ['put', '/contact/1', { body: { name: 'x' } }],
    ],
  },
];

test.each(irreversible)('$name is refused without reaching sevDesk', async ({ calls }) => {
  const sevdesk = await mock();

  const { isError, envelope } = await executeOnce(`
    const errors = [];
    for (const call of ${JSON.stringify(calls)}) {
      try { await sevdesk.request(...call); errors.push('sent'); }
      catch (e) {
        errors.push({ kind: e.kind, method: e.method, path: e.path, nothingSent: e.message.endsWith('Nothing was sent.') });
      }
    }
    return errors;`);

  expect(isError).toBe(false);
  expect(envelope).toEqual({
    result: calls.map(([method, path]) => ({
      kind: 'needs_confirmation',
      method: method.toUpperCase(),
      path,
      nothingSent: true,
    })),
  });
  expect(snippetCalls(sevdesk.requests)).toEqual([]);
});

test('getPdf with preventSendBy=true and an export that does not enshrine run as reads', async () => {
  const pdf = { objects: { filename: 'RE-1.pdf', mimeType: 'application/pdf' } };
  const job = { objects: { id: 'job-1' } };
  const sevdesk = await mock({
    'GET /Invoice/1/getPdf': () => ({ json: pdf }),
    'GET /Export/createDatevCsvZipExportJob': () => ({ json: job }),
  });

  const { envelope } = await executeOnce(`
    const file = await sevdesk.request('GET', '/Invoice/1/getPdf', { query: { preventSendBy: true } });
    const exported = await sevdesk.request('GET', '/Export/createDatevCsvZipExportJob', {
      query: { enshrineDocuments: false, includeEnshrined: true },
    });
    return { file, exported };`);

  expect(envelope).toEqual({ result: { file: pdf, exported: job } });
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'GET /Invoice/1/getPdf',
    'GET /Export/createDatevCsvZipExportJob',
  ]);
  expect(
    sevdesk.requests.find((r) => r.path === '/Invoice/1/getPdf')?.query.get('preventSendBy'),
  ).toBe('true');
});
