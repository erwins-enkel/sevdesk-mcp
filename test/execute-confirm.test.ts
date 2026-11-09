import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// Held irreversible calls and their confirmation (PRD §6, decisions 5, 9 and 10): a run holds them
// and returns a preview and a token; `execute({ confirm })` sends exactly those calls once, without
// running any code. Hold and confirm share one connection, as the token lives in its server.

const TOKEN = 'token-mcp-test-7a1c';
const CHECK = '/Tools/bookkeepingSystemVersion';
const SEND = '/Order/42/sendViaEmail';
const TEN_MINUTES = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const closers: (() => Promise<void>)[] = [];

const MAIL = {
  toEmail: 'max@example.com',
  subject: 'Angebot AN-1042',
  text: '<p>Guten Tag, anbei unser Angebot.</p>',
};

const OFFER = {
  id: '42',
  objectName: 'Order',
  orderType: 'AN',
  orderNumber: 'AN-1042',
  orderDate: '2026-11-09T00:00:00+01:00',
  status: '100',
  address: 'MCP Test GmbH\nMusterstraße 1\n10115 Berlin',
  currency: 'EUR',
  sumNet: '3600',
  sumGross: '4284',
};

// Creates an offer draft and sends it by sevDesk mail.
const DRAFT_AND_SEND = `
  const saved = await sevdesk.request('POST', '/Order/Factory/saveOrder', {
    body: { order: { objectName: 'Order', mapAll: true, orderType: 'AN', status: 100, version: 0 }, orderPosSave: [] },
  });
  const id = saved.objects.order.id;
  const send = await sevdesk.request('POST', '/Order/' + id + '/sendViaEmail', { body: ${JSON.stringify(MAIL)} });
  return { saved: id, send };`;

const routes: MockRoutes = {
  'POST /Order/Factory/saveOrder': () => ({
    status: 201,
    json: { objects: { order: { id: '42', objectName: 'Order' }, orderPos: [] } },
  }),
  'GET /Order/42': () => ({ json: { objects: [OFFER] } }),
  [`POST ${SEND}`]: () => ({ status: 201, json: { objects: { id: '9', objectName: 'Email' } } }),
};

beforeEach(() => {
  writeConfig({ profiles: { 'mcp-test': { company: 'MCP Test GmbH' } } });
  fakeKeychain.tokens.set('mcp-test', TOKEN);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk for this test; `afterEach` closes it. */
async function mock(overrides: MockRoutes = {}) {
  const sevdesk = await startMockSevdesk({ ...routes, ...overrides });
  closers.push(sevdesk.close);
  return sevdesk;
}

/** Connects a client to a fresh server for this test; `afterEach` closes it. */
async function open(): Promise<Client> {
  const client = await connect();
  closers.push(() => client.close());
  return client;
}

/** The requests the code and the confirmation made, without the bookkeeping-system check. */
function snippetRequests(requests: MockRequest[]): MockRequest[] {
  return requests.filter((request) => request.path !== CHECK);
}

function snippetCalls(requests: MockRequest[]): string[] {
  return snippetRequests(requests).map((request) => `${request.method} ${request.path}`);
}

function sends(requests: MockRequest[], path = SEND): MockRequest[] {
  return requests.filter((request) => request.path === path);
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'execute', arguments: args });
  return { isError: result.isError === true, envelope: envelopeOf(result) };
}

interface Confirmation {
  token: string;
  expiresAt: string;
  held: unknown[];
}

/** Runs `code` and returns the confirmation of its held calls. */
async function hold(client: Client, code = DRAFT_AND_SEND): Promise<Confirmation> {
  const { isError, envelope } = await call(client, { code });
  expect(isError).toBe(false);
  return envelope.confirmation as Confirmation;
}

test('a run creates the draft, holds the send and returns its preview and a token; nothing is sent', async () => {
  const sevdesk = await mock();
  const client = await open();
  const before = Date.now();

  const { isError, envelope } = await call(client, { code: DRAFT_AND_SEND });

  expect(isError).toBe(false);
  expect(envelope).toEqual({
    result: { saved: '42', send: { held: true } },
    writes: [{ method: 'POST', path: '/Order/Factory/saveOrder', status: 201, objectId: '42' }],
    confirmation: {
      token: expect.stringMatching(UUID) as string,
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as string,
      profile: 'mcp-test',
      company: 'MCP Test GmbH',
      held: [
        {
          method: 'POST',
          path: SEND,
          body: MAIL,
          document: 'Offer',
          number: 'AN-1042',
          date: '2026-11-09',
          amount: { net: 3600, gross: 4284, currency: 'EUR' },
          recipient: 'max@example.com',
          subject: 'Angebot AN-1042',
        },
      ],
    },
    notes: [
      '1 irreversible call was held, not sent. Show the user confirmation.held; only after their yes call execute with confirm set to confirmation.token and no code. The token works once, for 10 minutes.',
    ],
  });
  const expiresAt = Date.parse((envelope.confirmation as Confirmation).expiresAt);
  expect(expiresAt).toBeGreaterThanOrEqual(before + TEN_MINUTES);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + TEN_MINUTES);
  // The preview read the offer after the run; the send never reached sevDesk.
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'POST /Order/Factory/saveOrder',
    'GET /Order/42',
  ]);
});

test('confirm sends the held call once, exactly as held, without running the code again', async () => {
  const sevdesk = await mock();
  const client = await open();
  const { token } = await hold(client);

  const { isError, envelope } = await call(client, { confirm: token });

  expect(isError).toBe(false);
  expect(envelope).toEqual({
    confirmed: [{ method: 'POST', path: SEND, outcome: 'sent', status: 201, objectId: '9' }],
  });
  const [sent, ...others] = sends(sevdesk.requests);
  expect(others).toEqual([]);
  expect(sent).toMatchObject({
    method: 'POST',
    authorization: TOKEN,
    contentType: 'application/json',
    body: JSON.stringify(MAIL),
  });
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'POST /Order/Factory/saveOrder',
    'GET /Order/42',
    `POST ${SEND}`,
  ]);
});

test('a used or unknown token is rejected and sends nothing', async () => {
  const sevdesk = await mock();
  const client = await open();
  const { token } = await hold(client);
  await call(client, { confirm: token });

  for (const confirm of [token, 'b1c2d3e4-0000-4000-8000-000000000000']) {
    const { isError, envelope } = await call(client, { confirm });

    expect(isError).toBe(true);
    expect(envelope).toEqual({
      error: {
        kind: 'invalid_confirmation',
        message: 'The confirmation token is unknown, already used or expired. Nothing was sent.',
        hint: expect.stringContaining('not the code that created drafts') as string,
      },
    });
  }
  expect(sends(sevdesk.requests)).toHaveLength(1);
});

test('a token is valid for 10 minutes: one more millisecond and it is rejected', async () => {
  const sevdesk = await mock();
  const client = await open();
  const early = await hold(client);
  const late = await hold(client);
  vi.useFakeTimers({ toFake: ['Date'] });

  vi.setSystemTime(Date.parse(early.expiresAt) - 1);
  expect((await call(client, { confirm: early.token })).isError).toBe(false);
  vi.setSystemTime(Date.parse(late.expiresAt));
  const expired = await call(client, { confirm: late.token });

  expect(expired.isError).toBe(true);
  expect(expired.envelope.error).toMatchObject({ kind: 'invalid_confirmation' });
  expect(sends(sevdesk.requests)).toHaveLength(1);
});

test('a token of another profile is rejected and stays valid for its own profile', async () => {
  writeConfig({ profiles: { a: { company: 'Company A' }, b: { company: 'Company B' } } });
  fakeKeychain.tokens.set('a', 'token-a-3c9f');
  fakeKeychain.tokens.set('b', 'token-b-81d2');
  const sevdesk = await mock();
  const client = await open();
  const { isError, envelope } = await call(client, { code: DRAFT_AND_SEND, account: 'a' });
  expect(isError).toBe(false);
  const { token, ...confirmation } = envelope.confirmation as Confirmation & { company: string };
  expect(confirmation).toMatchObject({ profile: 'a', company: 'Company A' });

  const other = await call(client, { confirm: token, account: 'b' });

  expect(other).toEqual({
    isError: true,
    envelope: {
      error: {
        kind: 'invalid_confirmation',
        message: 'The confirmation token belongs to profile a, not b. Nothing was sent.',
        hint: 'Confirm with account a.',
      },
    },
  });
  expect(sends(sevdesk.requests)).toEqual([]);
  expect((await call(client, { confirm: token, account: 'a' })).isError).toBe(false);
  expect(sends(sevdesk.requests).map((request) => request.authorization)).toEqual(['token-a-3c9f']);
});

test('when the first held call fails on confirm, the second is not sent and the report says so', async () => {
  const second = '/Order/43/sendViaEmail';
  const sevdesk = await mock({
    'GET /Order/43': () => ({
      json: { objects: [{ ...OFFER, id: '43', orderNumber: 'AN-1043' }] },
    }),
    [`POST ${SEND}`]: () => ({ status: 500, json: { objects: null } }),
  });
  const client = await open();
  const { token } = await hold(
    client,
    `for (const id of [42, 43]) await sevdesk.request('POST', '/Order/' + id + '/sendViaEmail', { body: ${JSON.stringify(MAIL)} });
     return 'held';`,
  );

  const { isError, envelope } = await call(client, { confirm: token });

  expect(isError).toBe(true);
  expect(envelope).toEqual({
    confirmed: [
      { method: 'POST', path: SEND, outcome: 'failed', status: 500 },
      { method: 'POST', path: second, outcome: 'not_sent' },
    ],
    error: {
      kind: 'api_error',
      message: `POST ${SEND} returned HTTP 500.`,
      status: 500,
      method: 'POST',
      path: SEND,
    },
    notes: [expect.stringContaining('may still have been applied') as string],
  });
  expect(sends(sevdesk.requests)).toHaveLength(1);
  expect(sends(sevdesk.requests, second)).toEqual([]);
});

test('a confirmed call answered 2xx is sent even when its answer cannot be read; the next one follows', async () => {
  const second = '/Order/43/sendViaEmail';
  const sevdesk = await mock({
    'GET /Order/43': () => ({
      json: { objects: [{ ...OFFER, id: '43', orderNumber: 'AN-1043' }] },
    }),
    [`POST ${SEND}`]: () => ({ text: 'not json' }),
    [`POST ${second}`]: () => ({
      status: 201,
      json: { objects: { id: '10', objectName: 'Email' } },
    }),
  });
  const client = await open();
  const { token } = await hold(
    client,
    `for (const id of [42, 43]) await sevdesk.request('POST', '/Order/' + id + '/sendViaEmail', { body: ${JSON.stringify(MAIL)} });
     return 'held';`,
  );

  const { isError, envelope } = await call(client, { confirm: token });

  expect(isError).toBe(false);
  expect(envelope).toEqual({
    confirmed: [
      {
        method: 'POST',
        path: SEND,
        outcome: 'sent',
        status: 200,
        answerError: {
          kind: 'api_error',
          message: `POST ${SEND} returned invalid JSON.`,
          status: 200,
          method: 'POST',
          path: SEND,
        },
      },
      { method: 'POST', path: second, outcome: 'sent', status: 201, objectId: '10' },
    ],
    notes: [expect.stringContaining('was applied') as string],
  });
  expect(sends(sevdesk.requests)).toHaveLength(1);
  expect(sends(sevdesk.requests, second)).toHaveLength(1);
});

test.each<{ status: number; headers: Record<string, string> }>([
  { status: 429, headers: { 'retry-after': '0' } },
  { status: 503, headers: {} },
])('a confirmed call answered $status is not retried', async ({ status, headers }) => {
  const sevdesk = await mock({
    [`POST ${SEND}`]: () => ({ status, headers, json: { objects: null } }),
  });
  const client = await open();
  const { token } = await hold(client);

  const { isError, envelope } = await call(client, { confirm: token });

  expect(isError).toBe(true);
  expect(envelope.confirmed).toEqual([{ method: 'POST', path: SEND, outcome: 'failed', status }]);
  expect(sends(sevdesk.requests)).toHaveLength(1);
});

test('a run that fails after holding drops the held call: no token, nothing sent', async () => {
  const sevdesk = await mock();
  const client = await open();

  const { isError, envelope } = await call(client, {
    code: `${DRAFT_AND_SEND.replace(/return[^;]*;\s*$/, '')} throw new Error('a later step failed');`,
  });

  expect(isError).toBe(true);
  expect(envelope).toEqual({
    error: { kind: 'snippet_error', message: 'Error: a later step failed' },
    writes: [{ method: 'POST', path: '/Order/Factory/saveOrder', status: 201, objectId: '42' }],
    notes: [
      `The run failed, so its held calls were dropped unsent and no confirmation token was issued: POST ${SEND}. Do not repeat the writes in writes.`,
    ],
  });
  expect(snippetCalls(sevdesk.requests)).toEqual(['POST /Order/Factory/saveOrder']);
});

test('a preview read that fails issues no token and sends nothing', async () => {
  const sevdesk = await mock({
    'GET /Order/42': () => ({
      status: 404,
      json: { objects: null, error: { message: 'Not found' } },
    }),
  });
  const client = await open();

  const { isError, envelope } = await call(client, { code: DRAFT_AND_SEND });

  expect(isError).toBe(true);
  expect(envelope).toMatchObject({
    error: { kind: 'api_error', status: 404, method: 'GET', path: '/Order/42' },
    notes: [expect.stringContaining('dropped unsent') as string],
  });
  expect(envelope).not.toHaveProperty('confirmation');
  expect(sends(sevdesk.requests)).toEqual([]);
});

test('a held call on no document is previewed as the call itself, without a read', async () => {
  const sevdesk = await mock();
  const client = await open();

  const { envelope } = await call(client, {
    code: "return sevdesk.request('DELETE', '/Contact/5', { query: { force: true } })",
  });

  expect((envelope.confirmation as Confirmation).held).toEqual([
    { method: 'DELETE', path: '/Contact/5', query: { force: 'true' } },
  ]);
  expect(snippetCalls(sevdesk.requests)).toEqual([]);
});

test.each([{}, { code: 'return 1', confirm: 'b1c2d3e4-0000-4000-8000-000000000000' }])(
  'execute with %j is rejected before anything is sent',
  async (args) => {
    const sevdesk = await mock();
    const client = await open();

    expect(await call(client, args)).toEqual({
      isError: true,
      envelope: {
        error: {
          kind: 'invalid_request',
          message:
            'Pass either code (JavaScript to run) or confirm (a confirmation token), not both.',
        },
      },
    });
    expect(sevdesk.requests).toEqual([]);
  },
);

test('a held call takes a call of the budget; the call over it is not held and ends the run', async () => {
  writeConfig({
    limits: { callsPerRun: 2 },
    profiles: { 'mcp-test': { company: 'MCP Test GmbH' } },
  });
  const sevdesk = await mock();
  const client = await open();

  const { isError, envelope } = await call(client, {
    code: "for (const id of [1, 2, 3]) await sevdesk.request('DELETE', '/Contact/' + id);",
  });

  expect(isError).toBe(true);
  expect(envelope).toMatchObject({
    error: {
      kind: 'call_budget',
      message:
        'The run reached the limit of 2 sevDesk calls and was stopped; DELETE /Contact/3 was not held.',
    },
    notes: [expect.stringContaining('DELETE /Contact/1, DELETE /Contact/2') as string],
  });
  expect(snippetCalls(sevdesk.requests)).toEqual([]);
});
