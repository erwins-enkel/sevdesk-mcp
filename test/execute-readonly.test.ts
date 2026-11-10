import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { READ_ONLY_HINT } from '../src/sevdesk.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// Read-only mode (PRD §6, decision 3): `SEVDESK_READONLY` or a profile's `readonly: true` rejects
// every write and every irreversible call before it reaches sevDesk, never holding it, so no
// confirmation token can get it through; reads and `savePdf` still run.

const TOKEN = 'token-readonly-5e2a';
const CHECK = '/Tools/bookkeepingSystemVersion';
const COMPANY = 'MCP Test GmbH';
// A small PDF, as sevDesk's getPdf returns it in base64.
const PDF = Buffer.from('%PDF-1.4\n% sevdesk-mcp read-only test\n%%EOF\n', 'latin1');
const closers: (() => Promise<void>)[] = [];

/** Calls read-only mode blocks: writes of every method, an irreversible POST and GET. */
const BLOCKED: [string, string, object?][] = [
  ['POST', '/Contact', { body: { name: COMPANY } }],
  ['PUT', '/Contact/1', { body: { name: COMPANY } }],
  ['DELETE', '/Contact/1'],
  ['POST', '/Order/42/sendViaEmail', { body: { toEmail: 'max@example.com', subject: 'AN-1042' } }],
  ['GET', '/Order/42/getPdf'],
];

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

function snippetCalls(requests: MockRequest[]): string[] {
  return requests
    .filter((request) => request.path !== CHECK)
    .map((request) => `${request.method} ${request.path}`);
}

/** Calls `execute` with `args` on a fresh connection (a fresh session). */
async function execute(args: Record<string, unknown>) {
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'execute', arguments: args });
    return { isError: result.isError === true, envelope: envelopeOf(result) };
  } finally {
    await client.close();
  }
}

/** Writes a config file with profile `mcp-test`, its `readonly` flag and its token. */
function configProfile(readonly: boolean): void {
  writeConfig({ profiles: { 'mcp-test': { company: COMPANY, readonly } } });
  fakeKeychain.tokens.set('mcp-test', TOKEN);
}

const setups = [
  {
    name: 'SEVDESK_READONLY=true with the environment profile',
    profile: 'env',
    source: 'SEVDESK_READONLY is on',
    arrange: () => {
      vi.stubEnv('SEVDESK_API_TOKEN', TOKEN);
      vi.stubEnv('SEVDESK_READONLY', 'true');
    },
  },
  {
    name: 'SEVDESK_READONLY=true over a writable profile',
    profile: 'mcp-test',
    source: 'SEVDESK_READONLY is on',
    arrange: () => {
      configProfile(false);
      vi.stubEnv('SEVDESK_READONLY', 'true');
    },
  },
  {
    name: 'a read-only profile with SEVDESK_READONLY=false',
    profile: 'mcp-test',
    source: 'profile mcp-test is read-only',
    arrange: () => {
      configProfile(true);
      vi.stubEnv('SEVDESK_READONLY', 'false');
    },
  },
];

describe.each(setups)('$name', ({ profile, source, arrange }) => {
  test('writes and irreversible calls are rejected, not held, and never reach sevDesk; reads run', async () => {
    arrange();
    const sevdesk = await mock({ 'GET /Contact': () => ({ json: { objects: [{ id: '1' }] } }) });

    const { isError, envelope } = await execute({
      code: `
        const rejected = [];
        const attempts = ${JSON.stringify(BLOCKED)}.map((call) => () => sevdesk.request(...call));
        attempts.push(() => sevdesk.paginate('/Order/42/getPdf'));
        for (const attempt of attempts) {
          try { await attempt(); rejected.push('sent'); } catch (e) { rejected.push([e.kind, e.method, e.path]); }
        }
        const contacts = await sevdesk.request('GET', '/Contact');
        return { rejected, contacts: contacts.objects.length };`,
    });

    expect(isError).toBe(false);
    expect(envelope).toEqual({
      result: {
        rejected: [
          ...BLOCKED.map(([method, path]) => ['read_only', method, path]),
          ['read_only', 'GET', '/Order/42/getPdf'],
        ],
        contacts: 1,
      },
    });
    expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Contact']);
  });

  test('an uncaught rejection ends the run with the read-only error', async () => {
    arrange();
    const sevdesk = await mock();

    const deleted = await execute({ code: "await sevdesk.request('DELETE', '/Contact/1')" });
    const pdf = await execute({ code: "await sevdesk.request('GET', '/Order/42/getPdf')" });

    expect(deleted).toEqual({
      isError: true,
      envelope: {
        error: {
          kind: 'read_only',
          message: `DELETE /Contact/1 was rejected: ${source}, so only calls that change nothing run. Nothing was sent or held.`,
          method: 'DELETE',
          path: '/Contact/1',
          hint: READ_ONLY_HINT,
        },
      },
    });
    expect(pdf.isError).toBe(true);
    expect(pdf.envelope.error).toMatchObject({
      kind: 'read_only',
      message: expect.stringMatching(
        new RegExp(
          `^GET /Order/42/getPdf was rejected: ${source}, .* or use sevdesk\\.savePdf\\.$`,
        ),
      ) as string,
    });
    expect(snippetCalls(sevdesk.requests)).toEqual([]);
  });

  test('savePdf and getPdf with preventSendBy=true still work', async () => {
    arrange();
    const file = { base64Encoded: true, content: PDF.toString('base64') };
    const sevdesk = await mock({
      'GET /Invoice/7': () => ({ json: { objects: [{ id: '7', invoiceNumber: 'RE-1001' }] } }),
      'GET /Invoice/7/getPdf': () => ({ json: { objects: file } }),
    });

    const { isError, envelope } = await execute({
      code: `
        const saved = await sevdesk.savePdf('Invoice', 7);
        const read = await sevdesk.request('GET', '/Invoice/7/getPdf', { query: { preventSendBy: true } });
        return { saved, read: read.objects.base64Encoded };`,
    });

    const path = join(homedir(), 'Downloads', 'sevdesk', profile, 'RE-1001.pdf');
    expect(isError).toBe(false);
    expect(envelope).toEqual({ result: { saved: { path, fileName: 'RE-1001.pdf' }, read: true } });
    expect(readFileSync(path)).toEqual(PDF);
    const pdfQueries = sevdesk.requests
      .filter((request) => request.path === '/Invoice/7/getPdf')
      .map((request) => request.query.toString());
    expect(pdfQueries).toEqual(['preventSendBy=true', 'preventSendBy=true']);
  });

  test('confirm is rejected before any token is looked at', async () => {
    arrange();
    const sevdesk = await mock();

    const confirmed = await execute({ confirm: '00000000-0000-4000-8000-000000000000' });

    expect(confirmed).toEqual({
      isError: true,
      envelope: {
        error: {
          kind: 'read_only',
          message: `The confirmation was rejected: ${source}, so no held call can be sent. Nothing was sent.`,
          hint: READ_ONLY_HINT,
        },
      },
    });
    expect(sevdesk.requests).toEqual([]);
  });
});

const TOKENS = { a: 'token-a-6b1d', b: 'token-b-f04c' };
const PROFILES = { a: { company: 'Company A' }, b: { company: 'Company B', readonly: true } };

test('a read-only profile blocks only its own calls; a writable one next to it writes', async () => {
  writeConfig({ profiles: PROFILES });
  for (const [name, token] of Object.entries(TOKENS)) fakeKeychain.tokens.set(name, token);
  const sevdesk = await mock({
    'POST /Contact': () => ({ status: 201, json: { objects: { id: '7', objectName: 'Contact' } } }),
  });
  const code = `return (await sevdesk.request('POST', '/Contact', { body: { name: 'x' } })).objects.id`;

  const writable = await execute({ code, account: 'a' });
  const readOnly = await execute({ code, account: 'b' });

  expect(writable).toEqual({
    isError: false,
    envelope: {
      result: '7',
      writes: [{ method: 'POST', path: '/Contact', status: 201, objectId: '7' }],
    },
  });
  expect(readOnly.isError).toBe(true);
  expect(readOnly.envelope.error).toMatchObject({
    kind: 'read_only',
    message: expect.stringContaining('profile b is read-only') as string,
  });
  const posts = sevdesk.requests.filter((request) => request.method === 'POST');
  expect(posts.map((request) => request.authorization)).toEqual([TOKENS.a]);
});

/** The annotations of `execute` on a fresh server built with `options`. */
async function annotations(options?: Parameters<typeof connect>[0]) {
  const client = await connect(options);
  const { tools } = await client.listTools();
  await client.close();
  return tools.find((tool) => tool.name === 'execute')?.annotations;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false };
const DESTRUCTIVE = { destructiveHint: true };

test.each(['true', 'TRUE', ' 1 ', 'yes'])(
  'SEVDESK_READONLY=%j gives execute the read-only annotation',
  async (value) => {
    vi.stubEnv('SEVDESK_READONLY', value);
    expect(await annotations()).toEqual(READ_ONLY);
  },
);

test.each([undefined, '', 'false', 'False', ' 0 '])(
  'SEVDESK_READONLY=%j leaves execute destructive',
  async (value) => {
    vi.stubEnv('SEVDESK_READONLY', value);
    expect(await annotations()).toEqual(DESTRUCTIVE);
  },
);

test.each([
  { pin: 'b', env: undefined, expected: READ_ONLY },
  { pin: 'a', env: undefined, expected: DESTRUCTIVE },
  { pin: 'a', env: 'true', expected: READ_ONLY },
  { pin: 'b', env: 'false', expected: READ_ONLY },
  { pin: undefined, env: undefined, expected: DESTRUCTIVE },
])('pinned profile $pin with SEVDESK_READONLY=$env: $expected', async ({ pin, env, expected }) => {
  writeConfig({ profiles: PROFILES });
  vi.stubEnv('SEVDESK_READONLY', env);
  expect(await annotations(pin === undefined ? {} : { pinnedProfile: pin })).toEqual(expected);
});
