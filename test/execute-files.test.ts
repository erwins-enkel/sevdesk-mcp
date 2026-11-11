import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OPERATIONS } from '../src/classify.ts';
import { localDirs } from '../src/paths.ts';
import { PDF_TYPES } from '../src/sevdesk.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';
import { getPdfAnswer, sevdeskPdf } from './sevdesk-pdf.ts';

// `sevdesk.savePdf` and the non-JSON responses of `sevdesk.request`, end to end through `execute`
// (decisions 7, 14 and 15): files land in the profile's download directory, inside this test's
// temporary home (test/setup.ts), and only their paths come back.

const TOKEN = 'test-token-9a4e1c';
const CHECK = '/Tools/bookkeepingSystemVersion';
// A small PDF with bytes that do not survive a text round trip.
const PDF = Buffer.from('%PDF-1.4\n%\xff\xfe\x00\x80 sevdesk-mcp test\n%%EOF\n', 'latin1');
const BASE64 = PDF.toString('base64');
// The status of a draft, which savePdf renders again, and of a sent document, which it does not.
const DRAFT = '100';
const SENT = '200';
// The last change of a document (2026-11-10T09:41:00Z) and a PDF created before it, as on the offer
// of issue #52: sevDesk returned a PDF from the day before.
const UPDATED = '2026-11-10T10:41:00+01:00';
const OLDER_PDF = sevdeskPdf('D:20261109144400Z');
const OLDER_FRESHNESS = {
  bytes: OLDER_PDF.length,
  sha256: sha256(OLDER_PDF),
  pdfCreated: '2026-11-09T14:44:00.000Z',
  documentUpdated: '2026-11-10T09:41:00.000Z',
};
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

/** The hex SHA-256 of `bytes`. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What a saved copy of `PDF` comes back with: it has no creation date, its document no update. */
const PDF_FRESHNESS = {
  bytes: PDF.length,
  sha256: sha256(PDF),
  pdfCreated: null,
  documentUpdated: null,
};

/** The envelope note on stale PDFs saved at `paths`. */
function staleNote(...paths: string[]): string {
  return `A saved PDF predates the last change of its draft and does not show the current data: ${paths.join(', ')}. Do not hand it out as current.`;
}

/**
 * The response of `GET /{Type}/{id}`: one document with `field` set to `number`, `status`, and its
 * last change `update` if given.
 */
function document(field: string, number: string | null, status = SENT, update?: string) {
  const changed = update === undefined ? {} : { update };
  return () => ({ json: { objects: [{ id: '7', [field]: number, status, ...changed }] } });
}

/** The answer to a forced render: the PDF's metadata and the whole PDF in base64. */
function rendered() {
  return () => ({ status: 201, json: { objects: { pdf: BASE64, docId: 'd4605b19248a' } } });
}

/**
 * A getPdf response with `PDF` in base64: wrapped in `objects` with the `base64Encoded` flag as
 * sevDesk sends it, or at the top level with `base64encoded` as the official spec documents it.
 */
function pdf(wrapped = true) {
  const file = { filename: 'x.pdf', mimeType: 'application/pdf', content: BASE64 };
  return () => ({
    json: wrapped
      ? { objects: { ...file, base64Encoded: true } }
      : { ...file, base64encoded: true },
  });
}

/** The requests the code made, without the bookkeeping-system check. */
function snippetCalls(requests: MockRequest[]): string[] {
  return requests
    .filter((request) => request.path !== CHECK)
    .map((request) => `${request.method} ${request.path}`);
}

/** Every file under the temporary home, relative to it, without the audit log of a write. */
function filesInHome(): string[] {
  const audit = join(localDirs().state, 'audit');
  return readdirSync(homedir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.parentPath !== audit)
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

test('savePdf renders a draft again, then saves its PDF under its number without marking it sent; only its path and freshness come back', async () => {
  const sevdesk = await mock({
    'GET /Order/7': document('orderNumber', 'AN-1042', DRAFT),
    'POST /Order/7/render': rendered(),
    'GET /Order/7/getPdf': pdf(true),
    'GET /Invoice/8': document('invoiceNumber', 'RE-1001', DRAFT),
    'POST /Invoice/8/render': rendered(),
    'GET /Invoice/8/getPdf': pdf(false),
  });

  const { isError, envelope, text } = await execute(
    "return [await sevdesk.savePdf('Order', 7), await sevdesk.savePdf('Invoice', '8')]",
  );

  expect(isError).toBe(false);
  expect(envelope.result).toEqual([
    { path: join(downloads(), 'AN-1042.pdf'), fileName: 'AN-1042.pdf', ...PDF_FRESHNESS },
    { path: join(downloads(), 'RE-1001.pdf'), fileName: 'RE-1001.pdf', ...PDF_FRESHNESS },
  ]);
  expect(readFileSync(join(downloads(), 'AN-1042.pdf'))).toEqual(PDF);
  expect(readFileSync(join(downloads(), 'RE-1001.pdf'))).toEqual(PDF);
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'GET /Order/7',
    'POST /Order/7/render',
    'GET /Order/7/getPdf',
    'GET /Invoice/8',
    'POST /Invoice/8/render',
    'GET /Invoice/8/getPdf',
  ]);
  const queries = sevdesk.requests
    .filter((request) => request.path !== CHECK)
    .map((request) => Object.fromEntries(request.query));
  expect(queries).toEqual([{}, {}, { preventSendBy: 'true' }, {}, {}, { preventSendBy: 'true' }]);
  const renders = sevdesk.requests.filter((request) => request.method === 'POST');
  expect(renders.map((request) => JSON.parse(request.body) as unknown)).toEqual([
    { forceReload: true },
    { forceReload: true },
  ]);
  expect(envelope.writes).toEqual([
    { method: 'POST', path: '/Order/7/render', status: 201 },
    { method: 'POST', path: '/Invoice/8/render', status: 201 },
  ]);
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
    ...PDF_FRESHNESS,
  });
  expect(readFileSync(join(downloads(), 'CreditNote-7.pdf'))).toEqual(PDF);
  expect(readdirSync(downloads())).toEqual(['CreditNote-7.pdf']);
});

test('a document that is no draft gets the PDF sevDesk stored, without a render', async () => {
  const sevdesk = await mock({
    'GET /Order/7': document('orderNumber', 'AN-1042', SENT),
    'POST /Order/7/render': rendered(),
    'GET /Order/7/getPdf': pdf(),
    'GET /CreditNote/7': document('creditNoteNumber', 'GU-1001', '1000'),
    'POST /CreditNote/7/render': rendered(),
    'GET /CreditNote/7/getPdf': pdf(),
  });

  const { isError, envelope } = await execute(
    "return [(await sevdesk.savePdf('Order', 7)).fileName, (await sevdesk.savePdf('CreditNote', 7)).fileName]",
  );

  expect(isError).toBe(false);
  expect(envelope).toEqual({ result: ['AN-1042.pdf', 'GU-1001.pdf'] });
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'GET /Order/7',
    'GET /Order/7/getPdf',
    'GET /CreditNote/7',
    'GET /CreditNote/7/getPdf',
  ]);
});

test('savePdf flags a draft whose PDF predates its last change, saves it all the same, and notes it in the run', async () => {
  await mock({
    'GET /Order/7': document('orderNumber', 'AN-1006', DRAFT, UPDATED),
    'POST /Order/7/render': rendered(),
    'GET /Order/7/getPdf': () => ({ json: getPdfAnswer(OLDER_PDF) }),
  });

  const saved = await execute("return await sevdesk.savePdf('Order', 7)");
  const pathOnly = await execute("return (await sevdesk.savePdf('Order', 7)).path");

  const path = join(downloads(), 'AN-1006.pdf');
  expect(saved.isError).toBe(false);
  expect(saved.envelope).toEqual({
    result: {
      path,
      fileName: 'AN-1006.pdf',
      ...OLDER_FRESHNESS,
      stale: true,
      hint: 'The PDF predates the last change of the draft, so it does not show the current data, although savePdf rendered it again. Do not hand it out as current; tell the user.',
    },
    writes: [{ method: 'POST', path: '/Order/7/render', status: 201 }],
    notes: [staleNote(path)],
  });
  expect(readFileSync(path)).toEqual(OLDER_PDF);
  // The code returned only the path; the run's note still says the PDF is stale.
  expect(pathOnly.envelope.result).toBe(path);
  expect(pathOnly.envelope.notes).toEqual([staleNote(path)]);
});

test('a current PDF that replaces a stale one of the same name in the run takes it out of the note', async () => {
  let fetches = 0;
  await mock({
    'GET /Order/7': document('orderNumber', 'AN-1006', DRAFT, UPDATED),
    'POST /Order/7/render': rendered(),
    'GET /Order/7/getPdf': () => {
      fetches += 1;
      return { json: getPdfAnswer(fetches === 1 ? OLDER_PDF : sevdeskPdf('D:20261110105759Z')) };
    },
  });

  const { isError, envelope } = await execute(`
    const first = await sevdesk.savePdf('Order', 7);
    const second = await sevdesk.savePdf('Order', 7);
    return [first.stale, second.stale];`);

  expect(isError).toBe(false);
  expect(envelope.result).toEqual([true, null]);
  expect(envelope).not.toHaveProperty('notes');
});

test('no flag for a PDF as new as the change or newer, one without a creation date, or a document that is no draft', async () => {
  const cases = [
    { status: DRAFT, created: 'D:20261110094100Z' },
    { status: DRAFT, created: "D:20261110115759+01'00'" },
    { status: DRAFT, created: undefined },
    { status: SENT, created: 'D:20261109144400Z' },
  ];
  const routes: MockRoutes = {};
  cases.forEach(({ status, created }, index) => {
    const id = String(index + 1);
    routes[`GET /Order/${id}`] = document('orderNumber', `AN-${id}`, status, UPDATED);
    routes[`POST /Order/${id}/render`] = rendered();
    routes[`GET /Order/${id}/getPdf`] = () => ({ json: getPdfAnswer(sevdeskPdf(created)) });
  });
  await mock(routes);

  const { isError, envelope } = await execute(`
    const results = [];
    for (let id = 1; id <= ${String(cases.length)}; id++) {
      const { pdfCreated, documentUpdated, stale, hint } = await sevdesk.savePdf('Order', id);
      results.push({ pdfCreated, documentUpdated, stale, hint });
    }
    return results;`);

  const documentUpdated = '2026-11-10T09:41:00.000Z';
  expect(isError).toBe(false);
  expect(envelope.result).toEqual([
    { pdfCreated: '2026-11-10T09:41:00.000Z', documentUpdated },
    { pdfCreated: '2026-11-10T10:57:59.000Z', documentUpdated },
    { pdfCreated: null, documentUpdated },
    { pdfCreated: '2026-11-09T14:44:00.000Z', documentUpdated },
  ]);
  expect(envelope).not.toHaveProperty('notes');
});

test('a getPdf through request reads the document first, then saves the PDF as a new file with its freshness, from JSON or download=true', async () => {
  const sevdesk = await mock({
    'GET /Order/7': document('orderNumber', 'AN-1006', DRAFT, UPDATED),
    'GET /Order/7/getPdf': (request) =>
      request.query.get('download') === 'true'
        ? { contentType: 'application/pdf', bytes: OLDER_PDF }
        : { json: getPdfAnswer(OLDER_PDF) },
    'GET /Invoice/8': document('invoiceNumber', 'RE-1001', SENT, UPDATED),
    'GET /Invoice/8/getPdf': () => ({ json: getPdfAnswer(OLDER_PDF) }),
  });

  const { isError, envelope, text } = await execute(`
    const query = { preventSendBy: true };
    const results = [
      await sevdesk.request('GET', '/Order/7/getPdf', { query }),
      await sevdesk.request('GET', '/Order/7/getPdf', { query: { ...query, download: true } }),
      await sevdesk.request('GET', '/Invoice/8/getPdf', { query }),
    ];
    try { await sevdesk.request('GET', '/Order/404/getPdf', { query }); }
    catch (e) { results.push({ kind: e.kind, message: e.message }); }
    return results;`);

  const paths = ['Order-7-getPdf.pdf', 'Order-7-getPdf-2.pdf', 'Invoice-8-getPdf.pdf'].map((name) =>
    join(downloads(), name),
  );
  const stale = {
    stale: true,
    hint: 'The PDF predates the last change of the draft, so it does not show the current data: getPdf returns the PDF sevDesk stored. Use sevdesk.savePdf, which renders a draft again first.',
  };
  expect(isError).toBe(false);
  expect(envelope).toEqual({
    result: [
      { path: paths[0], contentType: 'application/pdf', ...OLDER_FRESHNESS, ...stale },
      { path: paths[1], contentType: 'application/pdf', ...OLDER_FRESHNESS, ...stale },
      { path: paths[2], contentType: 'application/pdf', ...OLDER_FRESHNESS },
      { kind: 'api_error', message: 'GET /Order/404 returned HTTP 404.' },
    ],
    notes: [staleNote(...paths.slice(0, 2))],
  });
  for (const path of paths) expect(readFileSync(path)).toEqual(OLDER_PDF);
  expect(text).not.toContain(OLDER_PDF.toString('base64'));
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'GET /Order/7',
    'GET /Order/7/getPdf',
    'GET /Order/7',
    'GET /Order/7/getPdf',
    'GET /Invoice/8',
    'GET /Invoice/8/getPdf',
    'GET /Order/404',
  ]);
});

test('a render that fails fails savePdf: no getPdf, no file, the render in the ledger', async () => {
  const sevdesk = await mock({
    'GET /Order/7': document('orderNumber', 'AN-1042', DRAFT),
    'POST /Order/7/render': () => ({
      status: 500,
      json: { objects: null, error: { message: 'Rendering failed' } },
    }),
    'GET /Order/7/getPdf': pdf(),
  });

  const { isError, envelope } = await execute(`
    try { await sevdesk.savePdf('Order', 7); return 'saved'; }
    catch (e) { return { kind: e.kind, message: e.message, status: e.status, sevdeskMessage: e.sevdeskMessage }; }`);

  expect(isError).toBe(false);
  expect(envelope).toEqual({
    result: {
      kind: 'api_error',
      message: 'POST /Order/7/render returned HTTP 500.',
      status: 500,
      sevdeskMessage: 'Rendering failed',
    },
    writes: [{ method: 'POST', path: '/Order/7/render', status: 500 }],
    notes: [expect.stringContaining('may still have been applied') as string],
  });
  // A POST answered 5xx is sent once (decision 10).
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Order/7', 'POST /Order/7/render']);
  expect(filesInHome()).toEqual([]);
});

test('a document without a status fails savePdf before any render or getPdf', async () => {
  const sevdesk = await mock({
    'GET /Order/7': () => ({ json: { objects: [{ id: '7', orderNumber: 'AN-1042' }] } }),
    'POST /Order/7/render': rendered(),
    'GET /Order/7/getPdf': pdf(),
  });

  const { isError, envelope } = await execute("return await sevdesk.savePdf('Order', 7)");

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'api_error',
    message: 'GET /Order/7 returned no document status.',
    method: 'GET',
    path: '/Order/7',
  });
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Order/7']);
  expect(filesInHome()).toEqual([]);
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
      json: { objects: { filename: 'AN-1.pdf', base64Encoded: false, content: 'abc' } },
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

test("a draft's savePdf costs three calls of the budget; the one over it is not sent and ends the run", async () => {
  writeConfig({ limits: { callsPerRun: 2 } });
  const sevdesk = await mock({
    'GET /Order/7': document('orderNumber', 'AN-1042', DRAFT),
    'POST /Order/7/render': rendered(),
    'GET /Order/7/getPdf': pdf(),
  });

  const { isError, envelope } = await execute(
    "try { return await sevdesk.savePdf('Order', 7) } catch { return 'caught' }",
  );

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'call_budget',
    message:
      'The run reached the limit of 2 sevDesk calls and was stopped; GET /Order/7/getPdf was not sent.',
    hint: 'Save fewer PDFs per run: each costs up to 3 calls.',
  });
  expect(envelope.writes).toEqual([{ method: 'POST', path: '/Order/7/render', status: 201 }]);
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Order/7', 'POST /Order/7/render']);
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

test("savePdf covers exactly the spec's getPdf documents, each with its number field and a reversible render", () => {
  const spec = JSON.parse(
    readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8'),
  ) as { paths: Record<string, { get?: SpecOperation; post?: unknown }> };
  const paths = Object.keys(spec.paths);

  const types = paths.flatMap((path) => /^\/(\w+)\/\{\w+\}\/getPdf$/.exec(path)?.[1] ?? []);
  expect(types.sort()).toEqual(Object.keys(PDF_TYPES).sort());
  for (const [type, field] of Object.entries(PDF_TYPES)) {
    const path = paths.find((candidate) => new RegExp(`^/${type}/\\{\\w+\\}$`).test(candidate));
    const get = path === undefined ? undefined : spec.paths[path]?.get;
    const schema = get?.responses['200']?.content['application/json']?.schema;
    expect(schema?.properties?.objects?.items?.properties, type).toHaveProperty(field);
    const render = paths.find((candidate) =>
      new RegExp(`^/${type}/\\{\\w+\\}/render$`).test(candidate),
    );
    expect(render === undefined ? undefined : spec.paths[render]?.post, type).toBeDefined();
    expect(OPERATIONS[`POST ${String(render)}`], type).toBe('reversible');
  }
});
