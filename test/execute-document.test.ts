import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { localDirs } from '../src/paths.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// `sevdesk.getDocument` (issue #59), end to end through `execute`: one compact read of an Order,
// Invoice or CreditNote with its contact and positions. 3 calls when sevDesk embeds the referenced
// objects, at most 6 when names have to be fetched; a read, so it runs in read-only mode and never
// holds a call.

const TOKEN = 'test-token-59d0c2';
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
async function mock(routes: MockRoutes) {
  const sevdesk = await startMockSevdesk(routes);
  closers.push(sevdesk.close);
  return sevdesk;
}

/** Runs `code` through `execute` on a fresh connection. */
async function execute(code: string) {
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'execute', arguments: { code } });
    return { isError: result.isError === true, envelope: envelopeOf(result) };
  } finally {
    await client.close();
  }
}

/** The requests the code made, without the bookkeeping-system check, with their queries. */
function calls(requests: MockRequest[]) {
  return requests
    .filter((request) => request.path !== CHECK)
    .map(({ method, path, query }) => ({
      call: `${method} ${path}`,
      query: Object.fromEntries(query),
    }));
}

/** A list answer: `objects` on the first page (offset 0), an empty list after it. */
function list(objects: unknown[]) {
  return (request: MockRequest) => ({
    json: { objects: request.query.get('offset') === '0' ? objects : [] },
  });
}

/** An answer with `objects`. */
function answer(objects: unknown) {
  return () => ({ json: { objects } });
}

const CONTACT = { id: '5', objectName: 'Contact', name: 'Beispiel GmbH', customerNumber: '1042' };
const USER = { id: '11', objectName: 'SevUser', fullname: 'Erika Muster' };
const PIECE = { id: '1', objectName: 'Unity', name: 'Stk' };
const FLAT = { id: '9', objectName: 'Unity', name: 'Pauschal' };

/** The offer AN-1006 with `references` over the embedded contact and contact person. */
function offer(references: Record<string, unknown> = {}) {
  return {
    id: '7',
    objectName: 'Order',
    orderNumber: 'AN-1006',
    orderType: 'AN',
    status: '100',
    orderDate: '2026-11-10T00:00:00+01:00',
    sendDate: null,
    update: '2026-11-10T10:41:00+01:00',
    contact: CONTACT,
    contactPerson: USER,
    address: 'Beispiel GmbH\nTeststraße 1\n10115 Berlin',
    header: 'Angebot AN-1006',
    headText: '<p>Vielen Dank f&uuml;r Ihre Anfrage.</p>',
    footText: '<p>G&uuml;ltig 30&nbsp;Tage.</p>',
    paymentTerms: '14 Tage netto',
    deliveryTerms: null,
    taxRule: { id: '1', objectName: 'TaxRule' },
    taxText: 'zzgl. Umsatzsteuer 19%',
    currency: 'EUR',
    showNet: '1',
    sumNet: '3700',
    sumTax: '703',
    sumGross: '4403',
    ...references,
  };
}

/** The offer's positions, given out of order, with `units` (the embedded ones by default). */
function positions(units: [unknown, unknown] = [FLAT, PIECE]) {
  return [
    {
      id: '71',
      positionNumber: '2',
      name: 'Versand',
      text: null,
      quantity: '1',
      unity: units[0],
      price: '100',
      priceNet: '100',
      priceGross: '119',
      discount: null,
      taxRate: '19',
      sumNet: '100',
      sumGross: '119',
      optional: false,
    },
    {
      id: '70',
      positionNumber: '1',
      name: 'Tisch',
      text: '<p>Eiche, ge&ouml;lt</p>',
      quantity: '3',
      unity: units[1],
      price: '1200',
      priceNet: '1200',
      priceGross: '1428',
      discount: '0',
      taxRate: '19',
      optional: null,
    },
  ];
}

/** The compact offer, with `positionTexts` as the result shows them. */
function compactOffer(positionTexts: [string | null, string | null] = ['Eiche, geölt', null]) {
  return {
    type: 'Order',
    id: '7',
    kind: 'Offer',
    number: 'AN-1006',
    status: '100',
    statusText: 'draft',
    date: '2026-11-10',
    sendDate: null,
    update: '2026-11-10T10:41:00+01:00',
    contact: { id: '5', name: 'Beispiel GmbH', customerNumber: '1042' },
    contactPerson: { id: '11', name: 'Erika Muster' },
    address: 'Beispiel GmbH\nTeststraße 1\n10115 Berlin',
    header: 'Angebot AN-1006',
    headText: 'Vielen Dank für Ihre Anfrage.',
    footText: 'Gültig 30 Tage.',
    taxRule: '1',
    taxText: 'zzgl. Umsatzsteuer 19%',
    currency: 'EUR',
    showNet: true,
    sumNet: 3700,
    sumTax: 703,
    sumGross: 4403,
    paymentTerms: '14 Tage netto',
    deliveryTerms: null,
    positions: [
      {
        number: 1,
        name: 'Tisch',
        text: positionTexts[0],
        quantity: 3,
        unity: { id: '1', name: 'Stk' },
        price: 1200,
        priceNet: 1200,
        priceGross: 1428,
        discount: 0,
        taxRate: 19,
        sumNet: 3600,
        sumGross: 4284,
        sumSource: 'derived',
        optional: null,
      },
      {
        number: 2,
        name: 'Versand',
        text: positionTexts[1],
        quantity: 1,
        unity: { id: '9', name: 'Pauschal' },
        price: 100,
        priceNet: 100,
        priceGross: 119,
        discount: null,
        taxRate: 19,
        sumNet: 100,
        sumGross: 119,
        sumSource: 'sevDesk',
        optional: false,
      },
    ],
  };
}

const DOCUMENT_READ = { call: 'GET /Order/7', query: { embed: 'contact,contactPerson' } };
// Each page starts where the last one ended: after the offer's 2 positions, an empty page.
const POSITION_PAGES = [0, 2].map((offset) => ({
  call: 'GET /Order/7/getPositions',
  query: { embed: 'unity', limit: '1000', offset: String(offset) },
}));

/** The routes of the offer whose contact, contact person and units come back bare. */
function bareOffer(): MockRoutes {
  const bare = (reference: { id: string; objectName: string }) => ({
    id: reference.id,
    objectName: reference.objectName,
  });
  return {
    'GET /Order/7': answer([offer({ contact: bare(CONTACT), contactPerson: bare(USER) })]),
    'GET /Order/7/getPositions': list(positions([bare(FLAT), bare(PIECE)])),
    'GET /Contact/5': answer([CONTACT]),
    'GET /SevUser': answer([{ id: '10', objectName: 'SevUser', fullname: 'Max Andere' }, USER]),
    'GET /Unity': answer([PIECE, FLAT]),
  };
}

const FALLBACK_READS = [
  { call: 'GET /Contact/5', query: {} },
  { call: 'GET /SevUser', query: {} },
  { call: 'GET /Unity', query: {} },
];

test('getDocument reads an offer compactly in 3 calls: embedded names, plain texts, numbers, positions in order', async () => {
  const sevdesk = await mock({
    'GET /Order/7': answer([offer()]),
    'GET /Order/7/getPositions': list(positions()),
  });

  const { isError, envelope } = await execute("return await sevdesk.getDocument('Order', 7)");

  expect(isError).toBe(false);
  expect(envelope).toEqual({ result: compactOffer() });
  expect(calls(sevdesk.requests)).toEqual([DOCUMENT_READ, ...POSITION_PAGES]);
});

test('names sevDesk does not embed are fetched, one call per kind: 6 calls in all', async () => {
  const sevdesk = await mock(bareOffer());

  const { isError, envelope } = await execute("return await sevdesk.getDocument('Order', '7')");

  expect(isError).toBe(false);
  expect(envelope).toEqual({ result: compactOffer() });
  expect(calls(sevdesk.requests)).toEqual([DOCUMENT_READ, ...POSITION_PAGES, ...FALLBACK_READS]);
});

test('a name the fallback read does not hold stays null, never guessed', async () => {
  await mock({
    ...bareOffer(),
    'GET /Contact/5': answer([]),
    'GET /SevUser': answer([{ id: '10', objectName: 'SevUser', fullname: 'Max Andere' }]),
    'GET /Unity': answer([PIECE]),
  });

  const { envelope } = await execute(`
    const d = await sevdesk.getDocument('Order', 7);
    return { contact: d.contact, contactPerson: d.contactPerson, units: d.positions.map((p) => p.unity) };`);

  expect(envelope.result).toEqual({
    contact: { id: '5', name: null, customerNumber: null },
    contactPerson: { id: '11', name: null },
    units: [
      { id: '1', name: 'Stk' },
      { id: '9', name: null },
    ],
  });
});

test('an invoice reads its positions through getPositions and has its own keys', async () => {
  const sevdesk = await mock({
    'GET /Invoice/8': answer([
      {
        id: '8',
        objectName: 'Invoice',
        invoiceNumber: 'RE-1001',
        status: '200',
        invoiceDate: '2026-11-12T00:00:00+01:00',
        deliveryDate: '2026-11-01T00:00:00+01:00',
        deliveryDateUntil: '2026-11-30T00:00:00+01:00',
        timeToPay: '14',
        discount: '2',
        discountTime: '7',
        contact: CONTACT,
        contactPerson: USER,
      },
    ]),
    'GET /Invoice/8/getPositions': list([
      { name: 'Beratung', quantity: '2', priceNet: '90', priceGross: '107.1', unity: PIECE },
    ]),
  });

  const { envelope } = await execute("return await sevdesk.getDocument('Invoice', 8)");

  expect(envelope.result).toMatchObject({
    type: 'Invoice',
    kind: 'Invoice',
    number: 'RE-1001',
    status: '200',
    statusText: 'open',
    date: '2026-11-12',
    deliveryDate: '2026-11-01',
    deliveryDateUntil: '2026-11-30',
    timeToPay: 14,
    discount: 2,
    discountTime: 7,
    positions: [{ name: 'Beratung', sumNet: 180, sumGross: 214.2, sumSource: 'derived' }],
  });
  expect(calls(sevdesk.requests).map(({ call }) => call)).toEqual([
    'GET /Invoice/8',
    'GET /Invoice/8/getPositions',
    'GET /Invoice/8/getPositions',
  ]);
});

test('a credit note reads its positions through CreditNotePos, filtered by the credit note', async () => {
  const sevdesk = await mock({
    'GET /CreditNote/9': answer([
      {
        id: '9',
        objectName: 'CreditNote',
        creditNoteNumber: 'GU-1001',
        creditNoteDate: '2026-11-13T00:00:00+01:00',
        deliveryDate: '2026-11-02T00:00:00+01:00',
        contact: CONTACT,
        contactPerson: USER,
      },
    ]),
    'GET /CreditNotePos': list([{ name: 'Gutschrift Tisch', quantity: '1', unity: PIECE }]),
  });

  const { envelope } = await execute("return await sevdesk.getDocument('CreditNote', 9)");

  expect(envelope.result).toMatchObject({
    kind: 'Credit note',
    number: 'GU-1001',
    date: '2026-11-13',
    deliveryDate: '2026-11-02',
    positions: [{ name: 'Gutschrift Tisch', unity: { id: '1', name: 'Stk' } }],
  });
  const filter = { 'creditNote[id]': '9', 'creditNote[objectName]': 'CreditNote', embed: 'unity' };
  expect(calls(sevdesk.requests)).toEqual([
    { call: 'GET /CreditNote/9', query: { embed: 'contact,contactPerson' } },
    { call: 'GET /CreditNotePos', query: { ...filter, limit: '1000', offset: '0' } },
    { call: 'GET /CreditNotePos', query: { ...filter, limit: '1000', offset: '1' } },
  ]);
});

test('{ html: true } keeps headText, footText and the position texts as sevDesk sent them', async () => {
  await mock({
    'GET /Order/7': answer([offer()]),
    'GET /Order/7/getPositions': list(positions()),
  });

  const { envelope } = await execute(
    "return await sevdesk.getDocument('Order', 7, { html: true })",
  );

  expect(envelope.result).toEqual({
    ...compactOffer(['<p>Eiche, ge&ouml;lt</p>', null]),
    headText: '<p>Vielen Dank f&uuml;r Ihre Anfrage.</p>',
    footText: '<p>G&uuml;ltig 30&nbsp;Tage.</p>',
  });
});

test('in read-only mode getDocument and its fallback reads run: no write, no held call, no audit line', async () => {
  vi.stubEnv('SEVDESK_READONLY', '1');
  const sevdesk = await mock(bareOffer());

  const { isError, envelope } = await execute("return await sevdesk.getDocument('Order', 7)");

  expect(isError).toBe(false);
  expect(envelope).toEqual({ result: compactOffer() });
  expect(calls(sevdesk.requests)).toHaveLength(6);
  expect(existsSync(join(localDirs().state, 'audit'))).toBe(false);
});

test('getDocument counts every call: the one over the budget is not sent and ends the run without a partial document', async () => {
  writeConfig({ limits: { callsPerRun: 2 } });
  const sevdesk = await mock({
    'GET /Order/7': answer([offer()]),
    'GET /Order/7/getPositions': list(positions()),
  });

  const { isError, envelope } = await execute(
    "try { return await sevdesk.getDocument('Order', 7) } catch { return 'caught' }",
  );

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'call_budget',
    message:
      "The run reached the limit of 2 sevDesk calls and was stopped; sevdesk.getDocument('Order', 7) had fetched 2 positions and the document is incomplete, so none of it is returned.",
    hint: 'Read fewer documents per run: each costs 3 to 6 calls.',
  });
  expect(envelope.result).toBeUndefined();
  expect(calls(sevdesk.requests)).toEqual([DOCUMENT_READ, POSITION_PAGES[0]]);
});

test('the fallback reads count too: with 5 calls the unit names are not fetched', async () => {
  writeConfig({ limits: { callsPerRun: 5 } });
  const sevdesk = await mock(bareOffer());

  const { isError, envelope } = await execute("return await sevdesk.getDocument('Order', 7)");

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'call_budget',
    message:
      'The run reached the limit of 5 sevDesk calls and was stopped; GET /Unity was not sent.',
    hint: 'Read fewer documents per run: each costs 3 to 6 calls.',
  });
  expect(calls(sevdesk.requests).map(({ call }) => call)).toEqual([
    'GET /Order/7',
    'GET /Order/7/getPositions',
    'GET /Order/7/getPositions',
    'GET /Contact/5',
    'GET /SevUser',
  ]);
});

test('getDocument rejects a wrong type, id or option before any request', async () => {
  const sevdesk = await mock({});

  const { envelope } = await execute(`
    const calls = [
      ['Voucher', 7], ['Order', 'abc'], ['Order', 0], ['Order', -1],
      ['Order', 7, { html: 'yes' }], ['Order', 7, { foo: 1 }], ['Order', 7, null], ['Order', 7, {}, 1],
    ];
    const results = [];
    for (const args of calls) {
      try { await sevdesk.getDocument(...args); results.push('read'); }
      catch (e) { results.push(e.kind + ': ' + e.message); }
    }
    return results;`);

  const options =
    'invalid_request: options must be { html: true } to keep HTML texts, or left out.';
  expect(envelope.result).toEqual([
    'invalid_request: type must be one of Order, Invoice, CreditNote.',
    'invalid_request: id must be the positive integer id of the document, e.g. 123.',
    'invalid_request: id must be the positive integer id of the document, e.g. 123.',
    'invalid_request: id must be the positive integer id of the document, e.g. 123.',
    options,
    options,
    options,
    'invalid_request: sevdesk.getDocument takes only (type, id, options).',
  ]);
  expect(calls(sevdesk.requests)).toEqual([]);
});

test('an unknown id fails with the catchable API error, and nothing else is read', async () => {
  const sevdesk = await mock({});

  const { envelope } = await execute(`
    try { await sevdesk.getDocument('Order', 404); return 'read'; }
    catch (e) { return { kind: e.kind, status: e.status, path: e.path }; }`);

  expect(envelope.result).toEqual({ kind: 'api_error', status: 404, path: '/Order/404' });
  expect(calls(sevdesk.requests).map(({ call }) => call)).toEqual(['GET /Order/404']);
});

test('an answer without a document fails, before any position is read', async () => {
  const sevdesk = await mock({ 'GET /Order/7': answer([]) });

  const { envelope } = await execute(`
    try { await sevdesk.getDocument('Order', 7); return 'read'; }
    catch (e) { return { kind: e.kind, message: e.message }; }`);

  expect(envelope.result).toEqual({
    kind: 'api_error',
    message: 'GET /Order/7 returned no document.',
  });
  expect(calls(sevdesk.requests).map(({ call }) => call)).toEqual(['GET /Order/7']);
});

test('positions beyond one page are all read, page by page, until an empty page', async () => {
  const many = Array.from({ length: 1001 }, (_, index) => ({
    positionNumber: String(index + 1),
    name: `Position ${String(index + 1)}`,
    unity: PIECE,
  }));
  const sevdesk = await mock({
    'GET /Order/7': answer([offer()]),
    'GET /Order/7/getPositions': (request) => {
      const offset = Number(request.query.get('offset'));
      return { json: { objects: many.slice(offset, offset + 1000) } };
    },
  });

  const { envelope } = await execute(`
    const { positions } = await sevdesk.getDocument('Order', 7);
    return { count: positions.length, last: positions.at(-1).name };`);

  expect(envelope.result).toEqual({ count: 1001, last: 'Position 1001' });
  expect(calls(sevdesk.requests).map(({ query }) => query.offset)).toEqual([
    undefined,
    '0',
    '1000',
    '1001',
  ]);
});
