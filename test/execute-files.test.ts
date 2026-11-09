import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PDF_TYPES } from '../src/sevdesk.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// `sevdesk.savePdf` and the non-JSON responses of `sevdesk.request`, end to end through `execute`
// (decisions 7, 14 and 15): files land in the profile's download directory, inside this test's
// temporary home (test/setup.ts), and only their paths come back.

const TOKEN = 'test-token-9a4e1c';
const CHECK = '/Tools/bookkeepingSystemVersion';
// A small PDF with bytes that do not survive a text round trip.
const PDF = Buffer.from('%PDF-1.4\n%\xff\xfe\x00\x80 sevdesk-mcp test\n%%EOF\n', 'latin1');
const BASE64 = PDF.toString('base64');
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

/** The download directory of the environment profile `name`. */
function downloads(name = 'env'): string {
  return join(homedir(), 'Downloads', 'sevdesk', name);
}

/** The response of `GET /{Type}/{id}`: one document with `field` set to `number`. */
function document(field: string, number: string | null) {
  return () => ({ json: { objects: [{ id: '7', [field]: number }] } });
}

/** A getPdf response with `PDF` in base64, wrapped in `objects` or at the top level. */
function pdf(wrapped = true) {
  const file = {
    filename: 'x.pdf',
    mimeType: 'application/pdf',
    base64encoded: true,
    content: BASE64,
  };
  return () => ({ json: wrapped ? { objects: file } : file });
}

/** The requests the code made, without the bookkeeping-system check. */
function snippetCalls(requests: MockRequest[]): string[] {
  return requests
    .filter((request) => request.path !== CHECK)
    .map((request) => `${request.method} ${request.path}`);
}

/** Every file under the temporary home, relative to it. */
function filesInHome(): string[] {
  return readdirSync(homedir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(homedir(), join(entry.parentPath, entry.name)))
    .sort();
}

/** Runs `code` through `execute` on a fresh connection. */
async function execute(code: string, account?: string) {
  const client = await connect();
  try {
    const args = account === undefined ? { code } : { code, account };
    const result = await client.callTool({ name: 'execute', arguments: args });
    return {
      isError: result.isError === true,
      envelope: envelopeOf(result),
      text: JSON.stringify(result),
    };
  } finally {
    await client.close();
  }
}

test('savePdf saves the PDF under its document number without marking it sent; only the path comes back', async () => {
  const sevdesk = await mock({
    'GET /Order/7': document('orderNumber', 'AN-1042'),
    'GET /Order/7/getPdf': pdf(true),
    'GET /Invoice/8': document('invoiceNumber', 'RE-1001'),
    'GET /Invoice/8/getPdf': pdf(false),
  });

  const { isError, envelope, text } = await execute(
    "return [await sevdesk.savePdf('Order', 7), await sevdesk.savePdf('Invoice', '8')]",
  );

  expect(isError).toBe(false);
  expect(envelope.result).toEqual([
    { path: join(downloads(), 'AN-1042.pdf'), fileName: 'AN-1042.pdf' },
    { path: join(downloads(), 'RE-1001.pdf'), fileName: 'RE-1001.pdf' },
  ]);
  expect(readFileSync(join(downloads(), 'AN-1042.pdf'))).toEqual(PDF);
  expect(readFileSync(join(downloads(), 'RE-1001.pdf'))).toEqual(PDF);
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'GET /Order/7',
    'GET /Order/7/getPdf',
    'GET /Invoice/8',
    'GET /Invoice/8/getPdf',
  ]);
  const queries = sevdesk.requests
    .filter((request) => request.path !== CHECK)
    .map((request) => Object.fromEntries(request.query));
  expect(queries).toEqual([{}, { preventSendBy: 'true' }, {}, { preventSendBy: 'true' }]);
  expect(text).not.toContain(BASE64);
  expect(text).not.toContain('PDF-1.4');
  expect(filesInHome()).toEqual(
    ['AN-1042.pdf', 'RE-1001.pdf'].map((name) => join('Downloads', 'sevdesk', 'env', name)),
  );
});

test('without a document number the PDF is named <Type>-<id>.pdf and replaces an older copy', async () => {
  mkdirSync(downloads(), { recursive: true });
  writeFileSync(join(downloads(), 'CreditNote-7.pdf'), 'old rendering');
  await mock({
    'GET /CreditNote/7': document('creditNoteNumber', null),
    'GET /CreditNote/7/getPdf': pdf(),
  });

  const { envelope } = await execute("return await sevdesk.savePdf('CreditNote', 7)");

  expect(envelope.result).toEqual({
    path: join(downloads(), 'CreditNote-7.pdf'),
    fileName: 'CreditNote-7.pdf',
  });
  expect(readFileSync(join(downloads(), 'CreditNote-7.pdf'))).toEqual(PDF);
  expect(readdirSync(downloads())).toEqual(['CreditNote-7.pdf']);
});

test('a document number with path separators or dots cannot leave the download directory', async () => {
  const numbers = ['../../outside', 'a/b\\c', '..', 'C:\\x', '/etc/passwd', 'CON'];
  const routes: MockRoutes = {};
  numbers.forEach((number, index) => {
    routes[`GET /Order/${String(index + 1)}`] = document('orderNumber', number);
    routes[`GET /Order/${String(index + 1)}/getPdf`] = pdf();
  });
  await mock(routes);

  const { envelope } = await execute(`
    const names = [];
    for (let id = 1; id <= ${String(numbers.length)}; id++) names.push((await sevdesk.savePdf('Order', id)).fileName);
    return names;`);

  const names = [
    '_.._outside.pdf',
    'a_b_c.pdf',
    'Order-3.pdf',
    'C__x.pdf',
    '_etc_passwd.pdf',
    'Order-6.pdf',
  ];
  expect(envelope.result).toEqual(names);
  expect(filesInHome()).toEqual(
    names.map((name) => join('Downloads', 'sevdesk', 'env', name)).sort(),
  );
});

test("a profile's downloadDir from the config file is honoured; the env profile uses its name", async () => {
  const belege = join(homedir(), 'Belege');
  await mock({ 'GET /Order/7': document('orderNumber', 'AN-1042'), 'GET /Order/7/getPdf': pdf() });

  vi.stubEnv('SEVDESK_API_TOKEN', undefined);
  writeConfig({ profiles: { a: { company: 'A', downloadDir: belege } } });
  fakeKeychain.tokens.set('a', 'token-a-1f');
  const configured = await execute("return (await sevdesk.savePdf('Order', 7)).path");
  const downloadsCreated = existsSync(join(homedir(), 'Downloads'));

  vi.stubEnv('SEVDESK_API_TOKEN', TOKEN);
  vi.stubEnv('SEVDESK_PROFILE', 'mcp-test');
  const named = await execute("return (await sevdesk.savePdf('Order', 7)).path");

  expect(configured.envelope.result).toBe(join(belege, 'AN-1042.pdf'));
  expect(readFileSync(join(belege, 'AN-1042.pdf'))).toEqual(PDF);
  expect(downloadsCreated).toBe(false);
  expect(named.envelope.result).toBe(join(downloads('mcp-test'), 'AN-1042.pdf'));
});

test('a non-JSON response is saved as a new file and only { path, contentType, bytes } comes back', async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f]);
  await mock({
    'GET /Export/datevCSV': () => ({ contentType: 'text/csv', text: 'secret;csv;row' }),
    'GET /Export/invoiceZip': () => ({ contentType: 'application/zip', bytes: zip }),
    'GET /Export/contactListCsv': () => ({ contentType: null, bytes: new Uint8Array([1, 2, 3]) }),
  });

  const { isError, envelope, text } = await execute(`
    return [
      await sevdesk.request('GET', '/Export/datevCSV'),
      await sevdesk.request('GET', '/Export/datevCSV', { query: { startDate: 1 } }),
      await sevdesk.request('GET', '/Export/invoiceZip'),
      await sevdesk.request('GET', '/Export/contactListCsv'),
    ];`);

  expect(isError).toBe(false);
  expect(envelope.result).toEqual([
    { path: join(downloads(), 'Export-datevCSV.csv'), contentType: 'text/csv', bytes: 14 },
    { path: join(downloads(), 'Export-datevCSV-2.csv'), contentType: 'text/csv', bytes: 14 },
    { path: join(downloads(), 'Export-invoiceZip.zip'), contentType: 'application/zip', bytes: 8 },
    {
      path: join(downloads(), 'Export-contactListCsv.bin'),
      contentType: 'application/octet-stream',
      bytes: 3,
    },
  ]);
  for (const name of ['Export-datevCSV.csv', 'Export-datevCSV-2.csv']) {
    expect(readFileSync(join(downloads(), name), 'utf8')).toBe('secret;csv;row');
  }
  expect(new Uint8Array(readFileSync(join(downloads(), 'Export-invoiceZip.zip')))).toEqual(zip);
  expect(text).not.toContain('secret;csv;row');
});

test('savePdf rejects an unknown type, a malformed id and extra arguments before any request', async () => {
  const sevdesk = await mock({});
  const calls = [
    ['Voucher', 1],
    ['order', 1],
    ['constructor', 1],
    ['Order', -1],
    ['Order', 0],
    ['Order', 1.5],
    ['Order', '1/2'],
    ['Order', '01'],
    ['Order'],
    ['Order', 1, {}],
  ];

  const { envelope } = await execute(`
    const kinds = [];
    for (const call of ${JSON.stringify(calls)}) {
      try { await sevdesk.savePdf(...call); kinds.push('saved'); } catch (e) { kinds.push(e.kind); }
    }
    return kinds;`);

  expect(envelope.result).toEqual(calls.map(() => 'invalid_request'));
  expect(snippetCalls(sevdesk.requests)).toEqual([]);
});

test('an unexpected PDF response, an unknown document and a non-JSON page fail without a file', async () => {
  const sevdesk = await mock({
    'GET /Order/1': document('orderNumber', 'AN-1'),
    'GET /Order/1/getPdf': () => ({
      json: { objects: { filename: 'AN-1.pdf', base64encoded: false, content: 'abc' } },
    }),
    'GET /Order/2': document('orderNumber', 'AN-2'),
    'GET /Order/2/getPdf': () => ({ contentType: 'application/pdf', bytes: PDF }),
    'GET /Contact': () => ({ contentType: 'text/csv', text: 'a;b' }),
  });

  const { envelope } = await execute(`
    const errors = [];
    const calls = [
      () => sevdesk.savePdf('Order', 1),
      () => sevdesk.savePdf('Order', 2),
      () => sevdesk.savePdf('Order', 404),
      () => sevdesk.paginate('/Contact'),
    ];
    for (const call of calls) {
      try { await call(); errors.push('returned'); }
      catch (e) { errors.push({ kind: e.kind, message: e.message, status: e.status }); }
    }
    return errors;`);

  expect(envelope.result).toEqual([
    {
      kind: 'api_error',
      message: 'GET /Order/1/getPdf returned no base64-encoded PDF content.',
    },
    {
      kind: 'api_error',
      message: 'GET /Order/2/getPdf returned application/pdf, not JSON.',
      status: 200,
    },
    { kind: 'api_error', message: 'GET /Order/404 returned HTTP 404.', status: 404 },
    { kind: 'api_error', message: 'GET /Contact returned text/csv, not JSON.', status: 200 },
  ]);
  expect(snippetCalls(sevdesk.requests)).not.toContain('GET /Order/404/getPdf');
  expect(filesInHome()).toEqual([]);
});

test('a download directory that cannot be written is a catchable download_error', async () => {
  const blocked = join(homedir(), 'not-a-directory');
  writeFileSync(blocked, 'x');
  vi.stubEnv('SEVDESK_API_TOKEN', undefined);
  writeConfig({ profiles: { a: { company: 'A', downloadDir: blocked } } });
  fakeKeychain.tokens.set('a', 'token-a-1f');
  await mock({ 'GET /Order/7': document('orderNumber', 'AN-1042'), 'GET /Order/7/getPdf': pdf() });

  const { isError, envelope } = await execute(
    "try { await sevdesk.savePdf('Order', 7) } catch (e) { return { kind: e.kind, message: e.message, hint: e.hint } }",
  );

  expect(isError).toBe(false);
  expect(envelope.result).toEqual({
    kind: 'download_error',
    message: expect.stringMatching(
      /^AN-1042\.pdf could not be saved in .+ \(E[A-Z]+\)\.$/,
    ) as string,
    hint: expect.stringContaining('downloadDir') as string,
  });
});

test('savePdf costs two calls of the budget; the one over it is not sent and ends the run', async () => {
  writeConfig({ limits: { callsPerRun: 1 } });
  const sevdesk = await mock({
    'GET /Order/7': document('orderNumber', 'AN-1042'),
    'GET /Order/7/getPdf': pdf(),
  });

  const { isError, envelope } = await execute(
    "try { return await sevdesk.savePdf('Order', 7) } catch { return 'caught' }",
  );

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'call_budget',
    message:
      'The run reached the limit of 1 sevDesk calls and was stopped; GET /Order/7/getPdf was not sent.',
    hint: 'Save fewer PDFs per run: each costs 2 calls.',
  });
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Order/7']);
  expect(filesInHome().filter((file) => file.endsWith('.pdf'))).toEqual([]);
});

test('a non-JSON answer to the bookkeeping-system check fails and is never saved', async () => {
  const sevdesk = await mock({
    [`GET ${CHECK}`]: () => ({ contentType: 'text/html', text: '<p>Maintenance</p>' }),
  });

  const { isError, envelope } = await execute('return 1');

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'api_error',
    message: `GET ${CHECK} returned text/html, not JSON.`,
    status: 200,
    method: 'GET',
    path: CHECK,
    hint: 'sevdesk.request saves a non-JSON response as a file.',
  });
  expect(sevdesk.requests.map((request) => request.path)).toEqual([CHECK]);
  expect(filesInHome()).toEqual([]);
});

interface SpecOperation {
  responses: Record<string, { content: Record<string, { schema: SpecSchema }> }>;
}
interface SpecSchema {
  properties?: Record<string, SpecSchema>;
  items?: SpecSchema;
}

test("savePdf covers exactly the spec's getPdf documents, each with its number field", () => {
  const spec = JSON.parse(
    readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8'),
  ) as { paths: Record<string, { get?: SpecOperation }> };
  const paths = Object.keys(spec.paths);

  const types = paths.flatMap((path) => /^\/(\w+)\/\{\w+\}\/getPdf$/.exec(path)?.[1] ?? []);
  expect(types.sort()).toEqual(Object.keys(PDF_TYPES).sort());
  for (const [type, field] of Object.entries(PDF_TYPES)) {
    const path = paths.find((candidate) => new RegExp(`^/${type}/\\{\\w+\\}$`).test(candidate));
    const get = path === undefined ? undefined : spec.paths[path]?.get;
    const schema = get?.responses['200']?.content['application/json']?.schema;
    expect(schema?.properties?.objects?.items?.properties, type).toHaveProperty(field);
  }
});
