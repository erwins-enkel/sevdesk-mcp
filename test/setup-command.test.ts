import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { configFile } from '../src/config.ts';
import type { Locale } from '../src/i18n/index.ts';
import type { Prompter } from '../src/prompt.ts';
import { runSetup } from '../src/setup.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import { type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// `setup` adds a profile (PRD §7, decisions 4, 18, 19), driven through a scripted prompter against
// the fake keychain, a mock sevDesk and the temporary home of test/setup.ts.

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CHECK = 'GET /Tools/bookkeepingSystemVersion';
const COMPANY = 'GET /SevClient';
const acme = { objects: [{ id: '1', objectName: 'SevClient', name: 'Acme GmbH' }] };
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk whose account is Acme GmbH on system 2.0, with `routes` over that. */
async function mock(routes: MockRoutes = {}) {
  const sevdesk = await startMockSevdesk({
    [COMPANY]: () => ({ json: acme }),
    'GET /Contact': () => ({ json: { objects: [{ id: '9', objectName: 'Contact' }] } }),
    ...routes,
  });
  closers.push(sevdesk.close);
  return sevdesk;
}

/** An answer: the line, undefined to cancel, or a function run when the question comes. */
type Answer = string | undefined | (() => string | undefined);

/** Runs setup in `locale` with `answers` given in turn; a question beyond them fails the test. */
async function setup(answers: Answer[], locale: Locale = 'en') {
  const asked: { question: string; hidden: boolean }[] = [];
  const prompter: Prompter = {
    ask(question, { hidden = false } = {}) {
      asked.push({ question, hidden });
      if (asked.length > answers.length) throw new Error(`Unexpected question: ${question}`);
      const answer = answers[asked.length - 1];
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
    close: () => undefined,
  };
  const out: string[] = [];
  const err: string[] = [];
  const done = await runSetup(locale, {
    prompter,
    print: (text) => out.push(text),
    fail: (text) => err.push(text),
  });
  return { done, asked, out: out.join('\n'), err: err.join('\n') };
}

/** The files under the temporary home whose content holds `text`. */
function filesHolding(text: string): string[] {
  return readdirSync(homedir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file, 'utf8').includes(text));
}

function configJson(): unknown {
  return JSON.parse(readFileSync(configFile(), 'utf8'));
}

/** Asserts that setup stored nothing: no token written, no config file. */
function expectNothingStored(err: string): void {
  expect(err).toContain('Nothing was stored.');
  expect(fakeKeychain.tokens.size).toBe(0);
  expect(existsSync(configFile())).toBe(false);
  expect(filesHolding(TOKEN)).toEqual([]);
}

test('a valid token is stored in the keychain, the profile in the config file, and the server resolves it', async () => {
  const sevdesk = await mock();

  const { done, asked, out, err } = await setup(['acme', TOKEN, '']);

  expect(done).toBe(true);
  expect(err).toBe('');
  expect(asked.map(({ hidden }) => hidden)).toEqual([false, true, false]);
  expect(out).toContain('Company: Acme GmbH\nBookkeeping system: 2.0');
  expect(out).toContain('Profile acme (Acme GmbH) is set up.');
  expect(out).toContain('npx -y @erwins-enkel/sevdesk-mcp --profile acme');
  expect(fakeKeychain.tokens).toEqual(new Map([['acme', TOKEN]]));
  expect(fakeKeychain.accesses.every(({ service }) => service === 'sevdesk-mcp')).toBe(true);
  expect(configJson()).toEqual({ profiles: { acme: { company: 'Acme GmbH', readonly: false } } });
  expect(sevdesk.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([CHECK, COMPANY]);
  expect(sevdesk.requests.every(({ authorization }) => authorization === TOKEN)).toBe(true);
  // The scan finds the config file by the company name, but the token in no file.
  expect(filesHolding('Acme GmbH')).toEqual([configFile()]);
  expect(filesHolding(TOKEN)).toEqual([]);

  const client = await connect();
  const result = await client.callTool({
    name: 'execute',
    arguments: { code: "return (await sevdesk.request('GET', '/Contact')).objects.length" },
  });
  await client.close();
  expect(envelopeOf(result)).toMatchObject({ result: 1 });
  expect(sevdesk.requests.at(-1)).toMatchObject({ path: '/Contact', authorization: TOKEN });
});

test('read-only is asked in German and stored when the answer is yes', async () => {
  await mock();

  const { done, asked, out } = await setup(['acme', TOKEN, 'J'], 'de');

  expect(done).toBe(true);
  expect(asked[2]?.question).toContain('[j/N]');
  expect(out).toContain('Firma: Acme GmbH\nBuchhaltungssystem: 2.0');
  expect(out).toContain('Das Profil acme (Acme GmbH) ist eingerichtet, nur lesend.');
  expect(configJson()).toEqual({ profiles: { acme: { company: 'Acme GmbH', readonly: true } } });
});

test('an invalid profile name stops setup before the keychain or sevDesk is reached', async () => {
  const sevdesk = await mock();

  const { done, asked, err } = await setup(['Bad_Name']);

  expect(done).toBe(false);
  expect(asked).toHaveLength(1);
  expect(err).toContain('Invalid profile name: Bad_Name (1 to 32 characters: a-z, 0-9 and -)');
  expect(fakeKeychain.accesses).toEqual([]);
  expect(sevdesk.requests).toEqual([]);
  expectNothingStored(err);
});

test('a token sevDesk rejects (401) stops setup', async () => {
  await mock({ [CHECK]: () => ({ status: 401, json: { error: { message: 'Unauthorized' } } }) });

  const { done, err } = await setup(['acme', TOKEN]);

  expect(done).toBe(false);
  expect(err).toContain('sevDesk rejected the token (HTTP 401).');
  expectNothingStored(err);
});

test('an account on another bookkeeping system is refused before its company is read', async () => {
  const sevdesk = await mock({ [CHECK]: () => ({ json: { objects: { version: '1.0' } } }) });

  const { done, err } = await setup(['acme', TOKEN]);

  expect(done).toBe(false);
  expect(err).toContain(
    "This account's bookkeeping system (1.0) is not supported; sevdesk-mcp supports only system 2.0.",
  );
  expect(sevdesk.requests.map(({ path }) => path)).not.toContain('/SevClient');
  expectNothingStored(err);
});

test('a company name sevDesk does not reveal stops setup with the reason', async () => {
  await mock({ [COMPANY]: () => ({ status: 403, json: { error: { message: 'Forbidden' } } }) });

  const { done, err } = await setup(['acme', TOKEN]);

  expect(done).toBe(false);
  expect(err).toContain(
    'The token could not be checked with sevDesk: GET /SevClient returned HTTP 403.',
  );
  expectNothingStored(err);
});

test('an empty token stops setup before sevDesk is reached', async () => {
  const sevdesk = await mock();

  const { done, err } = await setup(['acme', '  ']);

  expect(done).toBe(false);
  expect(err).toContain('That is not an API token');
  expect(sevdesk.requests).toEqual([]);
  expectNothingStored(err);
});

test('without a keychain setup explains why before the token is asked', async () => {
  fakeKeychain.unavailable = true;
  const sevdesk = await mock();

  const { done, asked, err } = await setup(['acme', TOKEN, '']);

  expect(done).toBe(false);
  expect(asked).toHaveLength(1);
  expect(err).toContain('No OS keychain is available (Platform secure storage failure');
  expect(err).toContain('a token in a plain file can be read by any process and any backup');
  expect(err).toContain('grants full access to the bookkeeping');
  expect(err).toContain('set SEVDESK_API_TOKEN');
  expect(sevdesk.requests).toEqual([]);
  expectNothingStored(err);
});

test('without a keychain the German explanation points to SEVDESK_API_TOKEN', async () => {
  fakeKeychain.unavailable = true;

  const { done, err } = await setup(['acme'], 'de');

  expect(done).toBe(false);
  expect(err).toContain('Kein Schlüsselbund des Betriebssystems verfügbar');
  expect(err).toContain('setzt du stattdessen SEVDESK_API_TOKEN');
  expect(err).toContain('Es wurde nichts gespeichert.');
});

test('a keychain that fails to store the entered token leaves it in no file', async () => {
  await mock();
  const lockKeychain = () => {
    fakeKeychain.unavailable = true;
    return '';
  };

  const { done, err } = await setup(['acme', TOKEN, lockKeychain]);

  expect(done).toBe(false);
  expect(err).toContain('The token could not be stored in the OS keychain (');
  expectNothingStored(err);
});

test('a config file that cannot be written is reported with the keychain entry left behind', async () => {
  await mock();
  const breakConfig = () => {
    writeConfig('[]');
    return '';
  };

  const { done, out, err } = await setup(['acme', TOKEN, breakConfig]);

  expect(done).toBe(false);
  expect(err).toBe(
    `The token is in the OS keychain (service sevdesk-mcp, account acme), but the config file ${configFile()} could not be written (${configFile()} does not hold a JSON object). Fix that and run setup again.`,
  );
  expect(out).not.toContain('is set up');
  expect(fakeKeychain.tokens.get('acme')).toBe(TOKEN);
  expect(readFileSync(configFile(), 'utf8')).toBe('[]');
});

test('an existing profile is left as it is without an explicit yes', async () => {
  const sevdesk = await mock();
  const file = writeConfig({ profiles: { acme: { company: 'Old GmbH' } } });
  const before = readFileSync(file, 'utf8');

  const { done, asked, err } = await setup(['acme', 'maybe']);

  expect(done).toBe(false);
  expect(asked[1]?.question).toBe(
    'Profile acme (Old GmbH) already exists. Replace its token and settings? [y/N] ',
  );
  expect(err).toContain('Profile acme was left as it is.');
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(fakeKeychain.accesses).toEqual([]);
  expect(sevdesk.requests).toEqual([]);
});

test('an existing profile is replaced after a yes, keeping its read-only default and other keys', async () => {
  await mock();
  const downloadDir = join(homedir(), 'Docs');
  writeConfig({
    limits: { outputChars: 99 },
    profiles: {
      acme: { company: 'Old GmbH', readonly: true, downloadDir },
      other: { company: 'Other AG' },
    },
  });
  fakeKeychain.tokens.set('acme', 'old-token');

  const { done, asked } = await setup(['acme', 'y', TOKEN, '']);

  expect(done).toBe(true);
  expect(asked[3]?.question).toContain('[Y/n]');
  expect(fakeKeychain.tokens.get('acme')).toBe(TOKEN);
  expect(configJson()).toEqual({
    limits: { outputChars: 99 },
    profiles: {
      acme: { company: 'Acme GmbH', readonly: true, downloadDir },
      other: { company: 'Other AG' },
    },
  });
});

test('a cancelled question stops setup', async () => {
  await mock();

  const { done, err } = await setup(['acme', undefined]);

  expect(done).toBe(false);
  expect(err).toContain('Setup cancelled.');
  expectNothingStored(err);
});

test('an invalid config file stops setup before anything is asked', async () => {
  writeConfig('{ nope');

  const { done, asked, err } = await setup([]);

  expect(done).toBe(false);
  expect(asked).toEqual([]);
  expect(err).toContain('is invalid: it is not valid JSON');
  expect(err).toContain('Fix the config file and run setup again.');
  expect(fakeKeychain.accesses).toEqual([]);
});
