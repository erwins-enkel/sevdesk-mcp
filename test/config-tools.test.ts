import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { startMockSevdesk } from './mock-sevdesk.ts';

// The config file read by `search` and `execute` over MCP; the file lives in this test's
// temporary config directory (test/setup.ts).

const CHECK = '/Tools/bookkeepingSystemVersion';
const contacts = { objects: [{ id: '1', objectName: 'Contact', name: 'MCP Test GmbH' }] };
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv('SEVDESK_API_TOKEN', 'test-token-0b7e');
  vi.stubEnv('SEVDESK_PROFILE', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk for this test; `afterEach` closes it. */
async function mock(...args: Parameters<typeof startMockSevdesk>) {
  const sevdesk = await startMockSevdesk(...args);
  closers.push(sevdesk.close);
  return sevdesk;
}

/** Calls `tool` with `code` on a fresh server, which reads the config file as it starts. */
async function call(tool: 'search' | 'execute', code: string) {
  const client = await connect();
  try {
    const result = await client.callTool({ name: tool, arguments: { code } });
    return { isError: result.isError === true, envelope: envelopeOf(result) };
  } finally {
    await client.close();
  }
}

/** The tool descriptions a fresh server reports, by tool name. */
async function descriptions(): Promise<Record<string, string>> {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.description ?? '']));
}

test('without a config file the descriptions state the default limits', async () => {
  const { search, execute } = await descriptions();

  expect(search).toContain('each cut at 20000 characters');
  expect(execute).toContain('at most 50 calls per run');
  expect(execute).toContain('each cut at 20000 characters');
});

test('a lowered runtime limit ends both search and execute runs at that limit', async () => {
  writeConfig({ limits: { timeoutSeconds: 1 } });
  await mock();
  const timeout = {
    kind: 'timeout',
    message: 'The code ran longer than the 1 s limit.',
    hint: 'Avoid endless loops and narrow the work.',
  };

  const search = await call('search', 'while (true) {}');
  const execute = await call('execute', 'while (true) {}');

  expect(search).toEqual({ isError: true, envelope: { error: timeout } });
  expect(execute).toEqual({ isError: true, envelope: { error: timeout } });
});

test('a lowered call budget stops execute at that many calls and is stated in its description', async () => {
  writeConfig({ limits: { callsPerRun: 2 } });
  const sevdesk = await mock({ 'GET /Contact': () => ({ json: contacts }) });

  const { isError, envelope } = await call(
    'execute',
    `for (let i = 0; i < 3; i++) {
       try { await sevdesk.request('GET', '/Contact'); } catch { /* keep going */ }
     }
     return 'never';`,
  );

  expect(isError).toBe(true);
  expect(envelope.error).toMatchObject({
    kind: 'call_budget',
    message:
      'The run reached the limit of 2 sevDesk calls and was stopped; GET /Contact was not sent.',
  });
  expect(sevdesk.requests.filter((request) => request.path === '/Contact')).toHaveLength(2);
  expect((await descriptions()).execute).toContain('at most 2 calls per run');
});

test('a lowered output limit cuts results and is stated in both descriptions', async () => {
  writeConfig({ limits: { outputChars: 100 } });

  const { isError, envelope } = await call('search', 'return "x".repeat(500)');

  expect(isError).toBe(false);
  expect(envelope.result).toHaveLength(100);
  expect(envelope.notes).toEqual([
    'Result cut to 100 of 502 characters. Filter or map it more narrowly in the code.',
  ]);
  const { search, execute } = await descriptions();
  expect(search).toContain('each cut at 100 characters');
  expect(execute).toContain('each cut at 100 characters');
});

test('a lowered memory limit stops an execute run at that limit', async () => {
  writeConfig({ limits: { memoryMb: 16 } });
  await mock();

  const { isError, envelope } = await call(
    'execute',
    'const a = []; while (true) a.push({ x: "y".repeat(100) + a.length });',
  );

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'memory_limit',
    message: 'The code exceeded the 16 MB memory limit.',
    hint: 'Work on less data at once.',
  });
});

test('execute sends its calls to the configured base URL', async () => {
  const baseUrl = 'https://sevdesk.example/api/v2';
  writeConfig({ baseUrl: `${baseUrl}/` });
  const sevdesk = await mock({ 'GET /Contact': () => ({ json: contacts }) }, baseUrl);

  const { isError, envelope } = await call(
    'execute',
    `return (await sevdesk.request('GET', '/Contact')).objects`,
  );

  expect(isError).toBe(false);
  expect(envelope.result).toEqual(contacts.objects);
  expect(sevdesk.requests.map((request) => request.path)).toEqual([CHECK, '/Contact']);
});

test.each([
  [
    'a non-HTTPS base URL',
    { baseUrl: 'http://my.sevdesk.de/api/v1' },
    'baseUrl must use https://, not http://',
  ],
  ['malformed JSON', '{ "limits": { "timeoutSeconds": 5 }', 'it is not valid JSON ('],
])(
  'with %s both tools fail with the file and the problem and send nothing',
  async (_, content, expected) => {
    const file = writeConfig(content);
    const sevdesk = await mock({ 'GET /Contact': () => ({ json: contacts }) });

    for (const [tool, code] of [
      ['search', 'return 1'],
      ['execute', `return await sevdesk.request('GET', '/Contact')`],
    ] as const) {
      const { isError, envelope } = await call(tool, code);

      expect(isError).toBe(true);
      expect(envelope).toEqual({
        error: {
          kind: 'invalid_config',
          message: expect.stringContaining(`The config file ${file} is invalid: `) as string,
          hint: 'Fix the file or delete it to use the defaults, then restart the MCP server.',
        },
      });
      expect((envelope.error as { message: string }).message).toContain(expected);
    }
    expect(sevdesk.requests).toEqual([]);
  },
);
