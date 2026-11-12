import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, test, vi } from 'vitest';
import { GUIDES } from '../src/guides.ts';
import { localDirs } from '../src/paths.ts';
import { envelopeOf } from './connect.ts';
import { fill, template } from './guide-template.ts';
import {
  type MockRequest,
  type MockRoutes,
  type SpecSchema,
  specOperation,
  startMockSevdesk,
} from './mock-sevdesk.ts';
import { ANSWERS, CONTACT, ORDER } from './sevdesk-answers.ts';

// PRD §4 Priority A end to end (issue #18): an MCP client drives a spawned server over stdio, as a
// model would, against the mock sevDesk, which follows the embedded spec. Every body it writes is a
// JSON template of the guides, cut from the text `search` returns, with only its placeholders
// filled. After every test: no send and no delete reached the mock outside a confirmation the
// server accepted (PRD §10), and every body the mock received carried the fields the spec requires.

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TOKEN = 'token-priority-a-5c2e81';
const PROFILE = 'mcp-test';
const COMPANY = 'MCP Test GmbH';
const MAIL_TO = 'max.mustermann@example.com';
const ADDRESS = { street: 'Musterstraße 1', zip: '10115', city: 'Berlin' };
const SEND = '/Order/42/sendViaEmail';
const SEND_BY = '/Order/42/sendBy';
const UNKNOWN_TOKEN = '00000000-0000-4000-8000-000000000000';
// A PDF with bytes that do not survive a text round trip.
const PDF = Buffer.from('%PDF-1.4\n%\xff\xfe\x00 priority A\n%%EOF\n', 'latin1');
// Spawning a server is slow on the Windows and macOS runners.
const TIMEOUT = 30_000;

type Row = Record<string, unknown>;

/** A tool call of a conversation with the requests the mock received while it ran. */
interface Step {
  /** A `confirm` the server accepted, i.e. one with a valid token. */
  accepted: boolean;
  requests: MockRequest[];
}

const closers: (() => Promise<void>)[] = [];
const checks: (() => void)[] = [];

afterEach(async () => {
  try {
    for (const check of checks.splice(0)) check();
  } finally {
    vi.unstubAllGlobals();
    await Promise.all(closers.splice(0).map((close) => close()));
  }
});

/**
 * A sevDesk account in memory, served by routes that are all spec operations, with the answers of
 * test/sevdesk-answers.ts where sevDesk's real shape is recorded. `existing` starts it with the
 * company (id 7) and its contact person (id 8); new objects get the next ids. The offer is order
 * 42, `order` as sevDesk would answer it: `ORDER` with what the draft sets.
 */
function account(existing: boolean) {
  const contacts: Row[] = existing
    ? [CONTACT, { id: '8', objectName: 'Contact', surename: 'Max', familyname: 'Mustermann' }]
    : [];
  let nextId = 7 + contacts.length;
  const order: Row = {};
  const create = (objectName: string, body: string): Row => ({
    ...(JSON.parse(body) as Row),
    id: String(nextId++),
    objectName,
  });
  const created = (objects: unknown) => ({ status: 201, json: { objects } });
  const list = (objects: Row[]) => () => ({ json: { objects } });

  const routes: MockRoutes = {
    'GET /Contact': ({ query }) => ({
      json: ANSWERS['GET /Contact'](
        contacts.filter((contact) =>
          [contact.name, contact.surename, contact.familyname].includes(query.get('name')),
        ),
      ),
    }),
    'POST /Contact': ({ body }) => {
      const contact = create('Contact', body);
      contacts.push(contact);
      return created(contact);
    },
    'GET /StaticCountry': list([{ id: '1', objectName: 'StaticCountry', name: 'Deutschland' }]),
    'GET /Category': list([{ id: '47', objectName: 'Category', name: 'Rechnungsadresse' }]),
    'POST /ContactAddress': ({ body }) => created(create('ContactAddress', body)),
    'GET /CommunicationWayKey': list([
      { id: '1', objectName: 'CommunicationWayKey', name: 'Privat' },
      { id: '2', objectName: 'CommunicationWayKey', name: 'Arbeit' },
    ]),
    'POST /CommunicationWay': ({ body }) => created(create('CommunicationWay', body)),
    'GET /SevUser': list([{ id: '3', objectName: 'SevUser', username: 'kai' }]),
    'GET /SevSequence/Factory/getByType': () => ({
      json: ANSWERS['GET /SevSequence/Factory/getByType'](),
    }),
    'GET /Unity': list([
      { id: '1', objectName: 'Unity', name: 'Stk' },
      { id: '4', objectName: 'Unity', name: 'Tag' },
    ]),
    'POST /Order/Factory/saveOrder': ({ body }) => {
      const saved = JSON.parse(body) as {
        order: Row;
        orderPosSave: { quantity: number; price: number; taxRate: number }[];
      };
      const positions = saved.orderPosSave.map((position, index) => ({
        ...position,
        id: String(100 + index),
        objectName: 'OrderPos',
      }));
      const net = positions.reduce((sum, { quantity, price }) => sum + quantity * price, 0);
      const tax = positions.reduce(
        (sum, { quantity, price, taxRate }) => sum + (quantity * price * taxRate) / 100,
        0,
      );
      const [day, month, year] = String(saved.order.orderDate).split('.');
      Object.assign(order, ORDER, saved.order, {
        id: '42',
        objectName: 'Order',
        status: '100',
        orderDate: `${String(year)}-${String(month)}-${String(day)}T00:00:00+01:00`,
        sumNet: String(net),
        sumGross: String(net + tax),
      });
      return { status: 201, json: ANSWERS['POST /Order/Factory/saveOrder'](order, positions) };
    },
    'GET /Order/42': () => ({ json: ANSWERS['GET /Order/{orderId}'](order) }),
    'POST /Order/42/render': () => ({
      status: 201,
      json: ANSWERS['POST /Order/{orderId}/render'](PDF),
    }),
    'GET /Order/42/getPdf': () => ({ json: ANSWERS['GET /Order/{orderId}/getPdf'](PDF) }),
    [`POST ${SEND}`]: () => {
      order.status = '200';
      return created([{ id: '5', objectName: 'Email', subject: 'Angebot AN-1042' }]);
    },
    // sevDesk answers sendBy with the order itself, not wrapped in objects.
    [`PUT ${SEND_BY}`]: () => {
      order.status = '200';
      return { json: order };
    },
  };
  return { routes, contacts, order };
}

/**
 * Whether a request sends a document, deletes, or may mark a document as sent (getPdf without
 * preventSendBy=true).
 */
function sendsOrDeletes({ method, path, query }: MockRequest): boolean {
  const segments = path.split('/');
  return (
    method === 'DELETE' ||
    segments.some((segment) => /^send/i.test(segment)) ||
    (segments.at(-1) === 'getPdf' && query.get('preventSendBy') !== 'true')
  );
}

/**
 * The fields `value` lacks that `schema` requires, as dotted paths; nested objects and array items
 * are checked where the value has them.
 */
function missingFields(schema: SpecSchema | undefined, value: unknown, at = ''): string[] {
  if (schema === undefined || typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      missingFields(schema.items, item, `${at}${String(index)}.`),
    );
  }
  const record = value as Row;
  const missing = (schema.required ?? [])
    .filter((key) => record[key] === undefined)
    .map((key) => `${at}${key}`);
  const nested = Object.entries(record).flatMap(([key, field]) =>
    missingFields(schema.properties?.[key], field, `${at}${key}.`),
  );
  return [...missing, ...nested];
}

/**
 * The checks after every test (PRD §10): each request the mock received came during a tool call,
 * none that sends or deletes came outside an accepted confirmation, and every body has what the
 * spec's request schema of its operation requires.
 */
function expectSafeAndSpecConform(steps: Step[], requests: MockRequest[]): void {
  expect(steps.flatMap((step) => step.requests)).toEqual(requests);
  const unconfirmed = steps.filter((step) => !step.accepted).flatMap((step) => step.requests);
  expect(unconfirmed.filter(sendsOrDeletes)).toEqual([]);
  for (const { method, path, body } of requests.filter((request) => request.body !== '')) {
    const schema = specOperation(method, path)?.requestBody?.content?.['application/json']?.schema;
    expect(schema, `${method} ${path} has a request schema`).toBeDefined();
    expect(missingFields(schema, JSON.parse(body)), `${method} ${path}`).toEqual([]);
  }
}

/**
 * Starts the mock with `routes` and a server spawned over stdio that sends its sevDesk calls there.
 * `call` runs a tool and records the step for the checks after the test.
 */
async function open(routes: MockRoutes) {
  const sevdesk = await startMockSevdesk(routes);
  closers.push(sevdesk.close);
  const client = new Client({ name: 'priority-a', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', sevdesk.serverImport, cli],
      // A token from the environment: a spawned server must never read the real keychain.
      env: { ...getDefaultEnvironment(), SEVDESK_API_TOKEN: TOKEN, SEVDESK_PROFILE: PROFILE },
    }),
  );
  closers.push(() => client.close());
  const steps: Step[] = [];
  checks.push(() => {
    expectSafeAndSpecConform(steps, sevdesk.requests);
  });

  async function call(name: 'search' | 'execute', args: Record<string, unknown>) {
    const start = sevdesk.requests.length;
    const result = await client.callTool({ name, arguments: args });
    const isError = result.isError === true;
    steps.push({
      accepted: 'confirm' in args && !isError,
      requests: sevdesk.requests.slice(start),
    });
    return { isError, envelope: envelopeOf(result) };
  }

  return { sevdesk, call };
}

type Call = Awaited<ReturnType<typeof open>>['call'];

/** `search` as a model uses it: list the guides, then read the offer and sending recipes. */
async function readGuides(call: Call): Promise<{ offer: string; delivery: string }> {
  const listed = await call('search', {
    code: 'return Object.entries(guides).map(([id, { title }]) => ({ id, title }))',
  });
  const titles = listed.envelope.result as { id: string; title: string }[];
  const offer = titles.find(({ title }) => title.startsWith('Create an offer'))?.id;
  const delivery = titles.find(({ title }) => title.startsWith('Sending'))?.id;
  expect([offer, delivery]).toEqual(['offer', 'delivery']);

  const read = await call('search', {
    code: `return { offer: guides.${String(offer)}.text, delivery: guides.${String(delivery)}.text }`,
  });
  const texts = read.envelope.result as { offer: string; delivery: string };
  expect(texts).toEqual({ offer: GUIDES.offer?.text, delivery: GUIDES.delivery?.text });
  return texts;
}

/** Step 1 of the offer recipe: find the company, else create it with its person, address and email. */
async function findOrCreateContact(call: Call, offer: string) {
  const company = fill(template(offer, 'POST /Contact with '), { company: COMPANY });
  const person = fill(template(offer, 'POST /Contact with ', 1), {
    'first name': 'Max',
    'last name': 'Mustermann',
    'company id': 'company.id',
  });
  const address = fill(template(offer, 'POST /ContactAddress with '), {
    'company id': 'company.id',
    ...ADDRESS,
    'country id': 'country.id',
    'category id': 'category.id',
  });
  const email = fill(template(offer, 'POST /CommunicationWay with '), {
    'person id': 'person.id',
    email: MAIL_TO,
    'key id': 'key.id',
  });
  return call('execute', {
    code: `
      const found = await sevdesk.request('GET', '/Contact', { query: { name: ${JSON.stringify(COMPANY)}, depth: 1 } });
      const existing = found.objects.find((contact) => contact.name === ${JSON.stringify(COMPANY)});
      if (existing) return { contactId: existing.id, created: false };
      const company = (await sevdesk.request('POST', '/Contact', { body: ${company} })).objects;
      const person = (await sevdesk.request('POST', '/Contact', { body: ${person} })).objects;
      const country = (await sevdesk.request('GET', '/StaticCountry')).objects.find((c) => c.name === 'Deutschland');
      const [category] = (await sevdesk.request('GET', '/Category', { query: { objectType: 'ContactAddress' } })).objects;
      await sevdesk.request('POST', '/ContactAddress', { body: ${address} });
      const key = (await sevdesk.request('GET', '/CommunicationWayKey')).objects.find((k) => k.name === 'Arbeit');
      await sevdesk.request('POST', '/CommunicationWay', { body: ${email} });
      return { contactId: company.id, created: true };`,
  });
}

/** Steps 2 to 4 of the offer recipe: the user, the next offer number and the unit "Tag". */
async function lookUp(call: Call): Promise<{ userId: string; number: string; unitId: string }> {
  const { isError, envelope } = await call('execute', {
    code: `
      const [user] = (await sevdesk.request('GET', '/SevUser')).objects;
      const sequence = (await sevdesk.request('GET', '/SevSequence/Factory/getByType', { query: { objectType: 'Order', type: 'AN' } })).objects;
      const unit = (await sevdesk.request('GET', '/Unity')).objects.find((u) => u.name === 'Tag');
      return { userId: user.id, number: sequence.format.replace('%NUMBER', String(sequence.nextSequence)), unitId: unit.id };`,
  });
  expect({ isError, envelope }).toEqual({
    isError: false,
    envelope: { result: { userId: '3', number: 'AN-1042', unitId: '4' } },
  });
  return envelope.result as { userId: string; number: string; unitId: string };
}

/** Step 5 of the offer recipe with the template as it stands, then the PDF (PRD §4 step 3). */
async function draftWithPdf(call: Call, offer: string, contactId: string) {
  const { userId, number, unitId } = await lookUp(call);
  const body = fill(template(offer, 'POST /Order/Factory/saveOrder:'), {
    'next number': number,
    'contact id': JSON.stringify(contactId),
    'user id': JSON.stringify(userId),
    'unit id': JSON.stringify(unitId),
    item: 'KI-Workshop',
    company: COMPANY,
    ...ADDRESS,
  });
  return call('execute', {
    code: `
      const saved = await sevdesk.request('POST', '/Order/Factory/saveOrder', { body: ${body} });
      const id = saved.objects.order.id;
      return { id, pdf: await sevdesk.savePdf('Order', id) };`,
  });
}

/** The body of every `method path` request the mock received, parsed. */
function bodies(requests: MockRequest[], method: string, path: string): unknown[] {
  return requests
    .filter((request) => request.method === method && request.path === path)
    .map(({ body }) => JSON.parse(body) as unknown);
}

/** The audit log's lines, without time, query and body hash. */
function auditTrail(): Row[] {
  const dir = join(localDirs().state, 'audit');
  return readdirSync(dir)
    .sort()
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
    .map((line) => {
      const { profile, method, path, outcome, status, objectId } = JSON.parse(line) as Row;
      return { profile, method, path, outcome, status, objectId };
    });
}

function audited(outcome: string, method: string, path: string, status?: number, id?: string) {
  return { profile: PROFILE, method, path, outcome, status, objectId: id };
}

/** Where the offer's PDF lands: the profile's download directory in this test's home. */
const pdfPath = () => join(homedir(), 'Downloads', 'sevdesk', PROFILE, 'AN-1042.pdf');

/**
 * The result of the draft run: the offer's id, its saved PDF with its freshness (the test PDF has
 * no creation date, so the PDF is not flagged stale), the draft and its render.
 */
const draftResult = () => ({
  result: {
    id: '42',
    pdf: {
      path: pdfPath(),
      fileName: 'AN-1042.pdf',
      bytes: PDF.length,
      sha256: createHash('sha256').update(PDF).digest('hex'),
      pdfCreated: null,
      documentUpdated: new Date(String(ORDER.update)).toISOString(),
    },
  },
  writes: [
    { method: 'POST', path: '/Order/Factory/saveOrder', status: 201, objectId: '42' },
    { method: 'POST', path: '/Order/42/render', status: 201 },
  ],
});

/** The draft as the recipe writes it: the guide's example offer, 3 days at 1,200 EUR net. */
const DRAFT_BODY = {
  order: {
    orderType: 'AN',
    status: 100,
    orderNumber: 'AN-1042',
    header: 'Angebot AN-1042',
    orderDate: '09.11.2026',
    contact: { id: '7', objectName: 'Contact' },
    contactPerson: { id: '3', objectName: 'SevUser' },
    taxRule: { id: '1', objectName: 'TaxRule' },
    currency: 'EUR',
    address: `${COMPANY}\n${ADDRESS.street}\n${ADDRESS.zip} ${ADDRESS.city}`,
  },
  orderPosSave: [
    { name: 'KI-Workshop', quantity: 3, price: 1200, unity: { id: '4' }, taxRate: 19 },
  ],
};

/** The preview fields every held call on the offer shows. */
const OFFER_PREVIEW = {
  document: 'Offer',
  number: 'AN-1042',
  date: '2026-11-09',
  amount: { net: 3600, gross: 4284, currency: 'EUR' },
};

test(
  'sevDesk mail: the contact and the offer draft are created, the PDF saved, the send held and sent once after confirm',
  async () => {
    const { routes, order } = account(false);
    const { sevdesk, call } = await open(routes);
    const { offer, delivery } = await readGuides(call);

    const contact = await findOrCreateContact(call, offer);
    expect(contact).toEqual({
      isError: false,
      envelope: {
        result: { contactId: '7', created: true },
        writes: [
          { method: 'POST', path: '/Contact', status: 201, objectId: '7' },
          { method: 'POST', path: '/Contact', status: 201, objectId: '8' },
          { method: 'POST', path: '/ContactAddress', status: 201, objectId: '9' },
          { method: 'POST', path: '/CommunicationWay', status: 201, objectId: '10' },
        ],
      },
    });
    expect(bodies(sevdesk.requests, 'POST', '/Contact')).toEqual([
      { name: COMPANY, category: { id: 3, objectName: 'Category' } },
      {
        surename: 'Max',
        familyname: 'Mustermann',
        parent: { id: '7', objectName: 'Contact' },
        category: { id: 3, objectName: 'Category' },
      },
    ]);
    expect(bodies(sevdesk.requests, 'POST', '/ContactAddress')).toEqual([
      {
        contact: { id: '7', objectName: 'Contact' },
        ...ADDRESS,
        country: { id: '1', objectName: 'StaticCountry' },
        category: { id: '47', objectName: 'Category' },
      },
    ]);
    expect(bodies(sevdesk.requests, 'POST', '/CommunicationWay')).toEqual([
      {
        contact: { id: '8', objectName: 'Contact' },
        type: 'EMAIL',
        value: MAIL_TO,
        key: { id: '2', objectName: 'CommunicationWayKey' },
        main: true,
      },
    ]);

    const draft = await draftWithPdf(call, offer, '7');
    expect(draft).toEqual({ isError: false, envelope: draftResult() });
    expect(bodies(sevdesk.requests, 'POST', '/Order/Factory/saveOrder')).toMatchObject([
      DRAFT_BODY,
    ]);
    expect(readFileSync(pdfPath())).toEqual(PDF);

    const mail = fill(template(delivery, 'POST /Order/{orderId}/sendViaEmail with '), {
      address: MAIL_TO,
      number: 'AN-1042',
    });
    const send = await call('execute', {
      code: `return await sevdesk.request('POST', '${SEND}', { body: ${mail} });`,
    });
    const held = { toEmail: MAIL_TO, subject: 'Angebot AN-1042', text: '<p>…</p>' };
    expect(send.isError).toBe(false);
    expect(send.envelope).toMatchObject({
      result: { held: true },
      confirmation: {
        profile: PROFILE,
        held: [
          {
            method: 'POST',
            path: SEND,
            body: held,
            ...OFFER_PREVIEW,
            recipient: MAIL_TO,
            subject: 'Angebot AN-1042',
          },
        ],
      },
    });
    expect(send.envelope).not.toHaveProperty('writes');
    expect(bodies(sevdesk.requests, 'POST', SEND)).toEqual([]);

    const forged = await call('execute', { confirm: UNKNOWN_TOKEN });
    expect(forged.isError).toBe(true);
    expect(forged.envelope.error).toMatchObject({ kind: 'invalid_confirmation' });
    expect(bodies(sevdesk.requests, 'POST', SEND)).toEqual([]);

    const { token } = send.envelope.confirmation as { token: string };
    const confirmed = await call('execute', { confirm: token });
    expect(confirmed).toEqual({
      isError: false,
      envelope: {
        confirmed: [{ method: 'POST', path: SEND, outcome: 'sent', status: 201, objectId: '5' }],
      },
    });
    const again = await call('execute', { confirm: token });
    expect(again.envelope.error).toMatchObject({ kind: 'invalid_confirmation' });

    expect(bodies(sevdesk.requests, 'POST', SEND)).toEqual([held]);
    expect(order.status).toBe('200');
    expect(auditTrail()).toEqual([
      audited('executed', 'POST', '/Contact', 201, '7'),
      audited('executed', 'POST', '/Contact', 201, '8'),
      audited('executed', 'POST', '/ContactAddress', 201, '9'),
      audited('executed', 'POST', '/CommunicationWay', 201, '10'),
      audited('executed', 'POST', '/Order/Factory/saveOrder', 201, '42'),
      audited('executed', 'POST', '/Order/42/render', 201),
      audited('held', 'POST', SEND),
      audited('confirmed', 'POST', SEND, 201, '5'),
    ]);
  },
  TIMEOUT,
);

test(
  'PDF only: the offer stays a draft, and sendBy is its own held step, sent only after its confirm',
  async () => {
    const { routes, order } = account(true);
    const { sevdesk, call } = await open(routes);
    const { offer, delivery } = await readGuides(call);

    const contact = await findOrCreateContact(call, offer);
    expect(contact).toEqual({
      isError: false,
      envelope: { result: { contactId: '7', created: false } },
    });

    const draft = await draftWithPdf(call, offer, '7');
    expect(draft).toEqual({ isError: false, envelope: draftResult() });
    expect(readFileSync(pdfPath())).toEqual(PDF);
    const pdf = sevdesk.requests.filter(({ path }) => path === '/Order/42/getPdf');
    expect(pdf.map(({ query }) => query.get('preventSendBy'))).toEqual(['true']);
    expect(order.status).toBe('100');
    const onOffer = ({ path }: MockRequest) => path.startsWith('/Order/42');
    // The draft is rendered again before its PDF is fetched, so the PDF is never an older one.
    expect(sevdesk.requests.filter(onOffer).map(({ method, path }) => `${method} ${path}`)).toEqual(
      ['GET /Order/42', 'POST /Order/42/render', 'GET /Order/42/getPdf'],
    );
    expect(bodies(sevdesk.requests, 'POST', '/Order/42/render')).toEqual([{ forceReload: true }]);
    const writesOnOffer = () =>
      sevdesk.requests
        .filter((request) => request.method !== 'GET' && onOffer(request))
        .map(({ method, path }) => `${method} ${path}`);
    expect(writesOnOffer()).toEqual(['POST /Order/42/render']);

    const markSent = fill(template(delivery, 'PUT /Order/{orderId}/sendBy with '), {});
    const mark = await call('execute', {
      code: `return await sevdesk.request('PUT', '${SEND_BY}', { body: ${markSent} });`,
    });
    const held = { sendType: 'VPDF', sendDraft: false };
    expect(mark.isError).toBe(false);
    expect(mark.envelope).toMatchObject({
      result: { held: true },
      confirmation: {
        held: [{ method: 'PUT', path: SEND_BY, body: held, ...OFFER_PREVIEW, recipient: COMPANY }],
      },
    });
    expect(writesOnOffer()).toEqual(['POST /Order/42/render']);
    expect(order.status).toBe('100');

    const { token } = mark.envelope.confirmation as { token: string };
    const confirmed = await call('execute', { confirm: token });
    expect(confirmed).toEqual({
      isError: false,
      envelope: {
        confirmed: [{ method: 'PUT', path: SEND_BY, outcome: 'sent', status: 200, objectId: '42' }],
      },
    });

    expect(bodies(sevdesk.requests, 'PUT', SEND_BY)).toEqual([held]);
    expect(writesOnOffer()).toEqual(['POST /Order/42/render', `PUT ${SEND_BY}`]);
    expect(order.status).toBe('200');
    expect(auditTrail()).toEqual([
      audited('executed', 'POST', '/Order/Factory/saveOrder', 201, '42'),
      audited('executed', 'POST', '/Order/42/render', 201),
      audited('held', 'PUT', SEND_BY),
      audited('confirmed', 'PUT', SEND_BY, 200, '42'),
    ]);
  },
  TIMEOUT,
);

test(
  'a held delete never reaches sevDesk without its token',
  async () => {
    const { routes, contacts } = account(true);
    const { sevdesk, call } = await open(routes);

    const remove = await call('execute', {
      code: "return await sevdesk.request('DELETE', '/Contact/8');",
    });
    expect(remove.isError).toBe(false);
    expect(remove.envelope).toMatchObject({
      result: { held: true },
      confirmation: { held: [{ method: 'DELETE', path: '/Contact/8' }] },
    });

    const forged = await call('execute', { confirm: UNKNOWN_TOKEN });
    expect(forged.envelope.error).toMatchObject({ kind: 'invalid_confirmation' });

    expect(sevdesk.requests.filter(({ method }) => method === 'DELETE')).toEqual([]);
    expect(contacts).toHaveLength(2);
    expect(auditTrail()).toEqual([audited('held', 'DELETE', '/Contact/8')]);
  },
  TIMEOUT,
);
