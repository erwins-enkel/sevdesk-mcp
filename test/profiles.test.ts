import { afterEach, expect, test, vi } from 'vitest';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import { startMockSevdesk } from './mock-sevdesk.ts';

// Profiles from the config file with their tokens in the (fake) OS keychain, and how `execute`
// resolves the tenant (decision 1). Every test starts with an empty fake keychain (test/setup.ts).

const CHECK = '/Tools/bookkeepingSystemVersion';
const TOKENS = { a: 'token-a-3c9f', b: 'token-b-81d2' };
const PROFILES = { a: { company: 'Company A' }, b: { company: 'Company B', readonly: true } };
const READ = "return (await sevdesk.request('GET', '/Contact')).objects.length";
const contacts = { objects: [{ id: '1', objectName: 'Contact', name: 'MCP Test GmbH' }] };
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk with a contact list for this test; `afterEach` closes it. */
async function mock() {
  const sevdesk = await startMockSevdesk({ 'GET /Contact': () => ({ json: contacts }) });
  closers.push(sevdesk.close);
  return sevdesk;
}

/** Puts the tokens of profiles a and b into the fake keychain. */
function storeTokens(): void {
  for (const [name, token] of Object.entries(TOKENS)) fakeKeychain.tokens.set(name, token);
}

type Options = Parameters<typeof connect>[0];

/** Calls `execute` with `READ` and `args` on a fresh server built with `options`. */
async function execute(args: { account?: string }, options?: Options) {
  const client = await connect(options);
  try {
    const result = await client.callTool({ name: 'execute', arguments: { code: READ, ...args } });
    return { isError: result.isError === true, result, text: JSON.stringify(result) };
  } finally {
    await client.close();
  }
}

/** The `account` property of `execute`'s input schema on a fresh server built with `options`. */
async function accountSchema(options?: Options) {
  const client = await connect(options);
  const { tools } = await client.listTools();
  await client.close();
  const properties = tools.find((tool) => tool.name === 'execute')?.inputSchema.properties;
  return properties?.account as { enum: string[]; description: string } | undefined;
}

test('with several profiles and no pin, account is required and lists them with their companies', async () => {
  writeConfig({ profiles: PROFILES });
  storeTokens();
  const sevdesk = await mock();

  const { isError, result } = await execute({});

  expect(isError).toBe(true);
  expect(envelopeOf(result)).toEqual({
    error: {
      kind: 'account_required',
      message:
        'Several sevDesk profiles are set up; pass account as one of: a (Company A), b (Company B).',
      hint: 'If the conversation does not make clear which company is meant, ask the user.',
    },
  });
  expect(await accountSchema()).toEqual({
    type: 'string',
    enum: ['a', 'b'],
    description:
      'sevDesk profile to use, one of: a (Company A), b (Company B). Required when there are several.',
  });
  expect(fakeKeychain.accesses).toEqual([]);
  expect(sevdesk.requests).toEqual([]);
});

test("with account set, every request carries that profile's token from the keychain", async () => {
  writeConfig({ profiles: PROFILES });
  storeTokens();
  const sevdesk = await mock();

  const { isError, result, text } = await execute({ account: 'b' });

  expect(isError).toBe(false);
  expect(envelopeOf(result).result).toBe(1);
  expect(sevdesk.requests.map((r) => `${String(r.authorization)} ${r.path}`)).toEqual([
    `${TOKENS.b} ${CHECK}`,
    `${TOKENS.b} /Contact`,
  ]);
  expect(fakeKeychain.accesses).toEqual([
    { service: 'sevdesk-mcp', account: 'b', store: 'secret-service' },
  ]);
  expect(text).not.toContain(TOKENS.b);
});

test('--profile pins the server: the enum holds only that profile and any other account is rejected', async () => {
  writeConfig({ profiles: PROFILES });
  storeTokens();
  const sevdesk = await mock();
  const pinned = { pinnedProfile: 'a' };

  const schema = await accountSchema(pinned);
  const other = await execute({ account: 'b' }, pinned);
  const accessesAfterOther = fakeKeychain.accesses.length;
  const requestsAfterOther = sevdesk.requests.length;
  const own = await execute({}, pinned);

  expect(schema?.enum).toEqual(['a']);
  expect(schema?.description).not.toContain('Company B');
  expect(other.isError).toBe(true);
  expect(other.text).toContain('account');
  expect([accessesAfterOther, requestsAfterOther]).toEqual([0, 0]);
  expect(own.isError).toBe(false);
  expect(sevdesk.requests.map((r) => r.authorization)).toEqual([TOKENS.a, TOKENS.a]);
  expect(fakeKeychain.accesses.map((access) => access.account)).toEqual(['a']);
});

test('with exactly one profile, execute without account uses it', async () => {
  writeConfig({ profiles: { a: PROFILES.a } });
  storeTokens();
  const sevdesk = await mock();

  const { isError, result } = await execute({});

  expect(isError).toBe(false);
  expect(envelopeOf(result).result).toBe(1);
  expect(sevdesk.requests.map((r) => r.authorization)).toEqual([TOKENS.a, TOKENS.a]);
});

test('with SEVDESK_API_TOKEN set, the env profile is the only one and the keychain is never read', async () => {
  writeConfig({ profiles: PROFILES });
  storeTokens();
  vi.stubEnv('SEVDESK_API_TOKEN', 'token-env-5e0a');
  const sevdesk = await mock();

  const schema = await accountSchema();
  const own = await execute({});
  const configured = await execute({ account: 'a' });
  const pinned = await execute({}, { pinnedProfile: 'a' });

  expect(schema?.enum).toEqual(['env']);
  expect(own.isError).toBe(false);
  expect(sevdesk.requests.map((r) => r.authorization)).toEqual([
    'token-env-5e0a',
    'token-env-5e0a',
  ]);
  expect(configured.isError).toBe(true);
  expect(pinned.isError).toBe(true);
  expect(envelopeOf(pinned.result).error).toMatchObject({
    kind: 'unknown_profile',
    message: '--profile a does not match the profile of SEVDESK_API_TOKEN, env.',
    hint: expect.stringContaining('SEVDESK_PROFILE=a') as string,
  });
  expect(fakeKeychain.accesses).toEqual([]);
});

test('a pin that names the env profile (SEVDESK_PROFILE) uses the env token', async () => {
  writeConfig({ profiles: PROFILES });
  vi.stubEnv('SEVDESK_API_TOKEN', 'token-env-5e0a');
  vi.stubEnv('SEVDESK_PROFILE', 'a');
  const sevdesk = await mock();

  const { isError } = await execute({ account: 'a' }, { pinnedProfile: 'a' });

  expect(isError).toBe(false);
  expect(sevdesk.requests.map((r) => r.authorization)).toEqual([
    'token-env-5e0a',
    'token-env-5e0a',
  ]);
  expect(fakeKeychain.accesses).toEqual([]);
});

test('a missing keychain entry is an explicit error naming the profile', async () => {
  writeConfig({ profiles: PROFILES });
  fakeKeychain.tokens.set('b', TOKENS.b);
  const sevdesk = await mock();

  const { isError, result } = await execute({ account: 'a' });

  expect(isError).toBe(true);
  expect(envelopeOf(result)).toEqual({
    error: {
      kind: 'keychain_entry_missing',
      message: 'The OS keychain holds no sevDesk API token for profile a.',
      hint: 'Store it under service "sevdesk-mcp", account "a", or set SEVDESK_API_TOKEN for this MCP server.',
    },
  });
  expect(sevdesk.requests).toEqual([]);
});

test('an unavailable keychain is an explicit error naming the profile', async () => {
  writeConfig({ profiles: PROFILES });
  fakeKeychain.unavailable = true;
  const sevdesk = await mock();

  const { isError, result } = await execute({ account: 'b' });

  expect(isError).toBe(true);
  expect(envelopeOf(result)).toEqual({
    error: {
      kind: 'keychain_unavailable',
      message:
        'The OS keychain could not be read for profile b: Platform secure storage failure: no Secret Service is running',
      hint: expect.stringContaining('SEVDESK_API_TOKEN') as string,
    },
  });
  expect(sevdesk.requests).toEqual([]);
});

test('a pinned profile that is not configured is an explicit error naming it, without a keychain read', async () => {
  const file = writeConfig({ profiles: PROFILES });
  const sevdesk = await mock();

  const schema = await accountSchema({ pinnedProfile: 'zzz' });
  const { isError, result } = await execute({}, { pinnedProfile: 'zzz' });

  expect(schema).toBeUndefined();
  expect(isError).toBe(true);
  expect(envelopeOf(result)).toEqual({
    error: {
      kind: 'unknown_profile',
      message: `Profile zzz (--profile) is not in the config file ${file}.`,
      hint: expect.stringContaining('a (Company A), b (Company B)') as string,
    },
  });
  expect(fakeKeychain.accesses).toEqual([]);
  expect(sevdesk.requests).toEqual([]);
});

test('a token in the config file is never read: the file is invalid and nothing is sent', async () => {
  writeConfig({ profiles: { a: { company: 'Company A', token: 'plain-token-7d1e' } } });
  fakeKeychain.tokens.set('a', TOKENS.a);
  const sevdesk = await mock();

  const { isError, result, text } = await execute({});

  expect(isError).toBe(true);
  expect(envelopeOf(result).error).toMatchObject({
    kind: 'invalid_config',
    message: expect.stringContaining('unknown key "profiles.a.token"') as string,
  });
  expect(text).not.toContain('plain-token-7d1e');
  expect(fakeKeychain.accesses).toEqual([]);
  expect(sevdesk.requests).toEqual([]);
});
