import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { configFile } from '../src/config.ts';
import type { Locale } from '../src/i18n/index.ts';
import { runList } from '../src/setup.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import {
  CHECK,
  COMPANY,
  filesHolding,
  mock,
  recordOutput,
  remove,
  setup,
  TOKEN,
} from './setup-dialogue.ts';

// `setup` adds a profile (PRD §7, decisions 4, 18, 19), `setup --list` lists the profiles and
// `setup --remove` removes one, driven through a scripted prompter against the fake keychain, a mock
// sevDesk and the temporary home of test/setup.ts.

// setup runs as from an installed package here, so its client entries run npx (decision 18).
vi.mock('../src/manifest.ts', () => import('./installed-package.ts'));

/** Runs `setup --list` in `locale`. */
function list(locale: Locale = 'en') {
  const { output, lines } = recordOutput();
  const done = runList(locale, output);
  return { done, ...lines() };
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

  const { done, asked, out, successes, err } = await setup(['acme', TOKEN, '']);

  expect(done).toBe(true);
  expect(err).toBe('');
  expect(asked.map(({ hidden }) => hidden)).toEqual([false, true, false]);
  expect(out).toContain('Company: Acme GmbH\nBookkeeping system: 2.0');
  expect(successes).toBe('Profile acme (Acme GmbH) is set up.');
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

  const { done, asked, out, successes } = await setup(['acme', TOKEN, 'J'], 'de');

  expect(done).toBe(true);
  expect(asked[2]?.question).toContain('[j/N]');
  expect(out).toContain('Firma: Acme GmbH\nBuchhaltungssystem: 2.0');
  expect(successes).toBe('Das Profil acme (Acme GmbH) ist eingerichtet, nur lesend.');
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

test('setup --list shows every profile with its company and access in columns, and never touches the keychain', () => {
  writeConfig({
    profiles: { acme: { company: 'Acme GmbH' }, ro: { company: 'RO AG', readonly: true } },
  });
  fakeKeychain.tokens.set('acme', TOKEN);

  const { done, out, err } = list();

  expect(done).toBe(true);
  expect(err).toBe('');
  expect(out).toBe(
    `Profiles in ${configFile()}:\n  acme  Acme GmbH  read and write\n  ro    RO AG      read-only`,
  );
  expect(fakeKeychain.accesses).toEqual([]);
});

test('setup --list names the access in German', () => {
  writeConfig({
    profiles: { acme: { company: 'Acme GmbH' }, ro: { company: 'RO AG', readonly: true } },
  });

  const { done, out } = list('de');

  expect(done).toBe(true);
  expect(out).toContain('  acme  Acme GmbH  lesend und schreibend');
  expect(out).toContain('  ro    RO AG      nur lesend');
});

test('setup --list without a config file says there are no profiles', () => {
  const { done, out, err } = list();

  expect(done).toBe(true);
  expect(err).toBe('');
  expect(out).toBe('There are no profiles yet. sevdesk-mcp setup adds one.');
});

test('setup --list with an invalid config file fails with the problem', () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH', token: TOKEN } } });

  const { done, out, err } = list();

  expect(done).toBe(false);
  expect(out).toBe('');
  expect(err).toContain('unknown key "profiles.acme.token"');
  expect(err).not.toContain(TOKEN);
});

test('setup --remove deletes the token and the config entry after a yes and keeps everything else', async () => {
  const downloadDir = join(homedir(), 'Docs');
  writeConfig({
    limits: { outputChars: 99 },
    profiles: {
      acme: { company: 'Acme GmbH', readonly: true },
      other: { company: 'Other AG', downloadDir },
    },
  });
  fakeKeychain.tokens.set('acme', TOKEN);
  fakeKeychain.tokens.set('other', 'other-token');

  const { done, asked, out, successes, err } = await remove('acme', ['y']);

  expect(done).toBe(true);
  expect(successes).toBe(
    'Profile acme (Acme GmbH) is removed; the OS keychain holds no token for it any more.',
  );
  expect(err).toBe('');
  expect(asked).toEqual([
    {
      question: 'Remove profile acme (Acme GmbH) and delete its token from the OS keychain? [y/N] ',
      hidden: false,
    },
  ]);
  expect(out).toBe(
    'Profile acme (Acme GmbH) is removed; the OS keychain holds no token for it any more.\n' +
      'If an MCP client runs sevdesk-mcp with --profile acme, remove that entry from its config.',
  );
  expect(fakeKeychain.tokens).toEqual(new Map([['other', 'other-token']]));
  expect(fakeKeychain.accesses.every(({ service }) => service === 'sevdesk-mcp')).toBe(true);
  expect(configJson()).toEqual({
    limits: { outputChars: 99 },
    profiles: { other: { company: 'Other AG', downloadDir } },
  });
});

test('after the only profile is removed in German, execute asks for setup', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' } } });
  fakeKeychain.tokens.set('acme', TOKEN);

  const { done, asked, out } = await remove('acme', ['ja'], 'de');

  expect(done).toBe(true);
  expect(asked[0]?.question).toContain('[j/N]');
  expect(out).toContain('Das Profil acme (Acme GmbH) ist entfernt');
  expect(fakeKeychain.tokens.size).toBe(0);
  expect(configJson()).toEqual({ profiles: {} });

  const client = await connect();
  const result = await client.callTool({ name: 'execute', arguments: { code: 'return 1' } });
  await client.close();
  expect(result.isError).toBe(true);
  expect(envelopeOf(result)).toMatchObject({ error: { kind: 'setup_required' } });
});

test.each([['n'], [''], ['maybe'], [undefined]])(
  'setup --remove after the answer %j changes nothing',
  async (answer) => {
    const file = writeConfig({ profiles: { acme: { company: 'Acme GmbH' } } });
    const before = readFileSync(file, 'utf8');
    fakeKeychain.tokens.set('acme', TOKEN);

    const { done, out, err } = await remove('acme', [answer]);

    expect(done).toBe(false);
    expect(out).toBe('');
    expect(err).toMatch(
      /(Profile acme was left as it is\.|Setup cancelled\.)\nNothing was removed\.$/,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(fakeKeychain.tokens.get('acme')).toBe(TOKEN);
    expect(fakeKeychain.accesses).toEqual([]);
  },
);

test('setup --remove of an unknown profile fails before asking or touching the keychain', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' } } });

  const { done, asked, err } = await remove('nope', []);

  expect(done).toBe(false);
  expect(asked).toEqual([]);
  expect(err).toBe(
    'There is no profile nope. sevdesk-mcp setup --list shows every profile.\nNothing was removed.',
  );
  expect(fakeKeychain.accesses).toEqual([]);
});

test('a keychain that cannot delete the token leaves the profile as it is', async () => {
  const file = writeConfig({ profiles: { acme: { company: 'Acme GmbH' } } });
  const before = readFileSync(file, 'utf8');
  fakeKeychain.unavailable = true;

  const { done, err } = await remove('acme', ['y']);

  expect(done).toBe(false);
  expect(err).toContain(
    'The token could not be deleted from the OS keychain (Platform secure storage failure',
  );
  expect(err).toContain('Nothing was removed.');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('a config file that cannot be written after the token is deleted is reported, and a rerun finishes', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' } } });
  fakeKeychain.tokens.set('acme', TOKEN);
  const breakConfig = () => {
    writeConfig('[]');
    return 'y';
  };

  const failed = await remove('acme', [breakConfig]);

  expect(failed.done).toBe(false);
  expect(failed.out).toBe('');
  expect(failed.err).toBe(
    `The token of profile acme is deleted from the OS keychain, but the config file ${configFile()} could not be written (${configFile()} does not hold a JSON object). Fix that and run setup --remove acme again.`,
  );
  expect(fakeKeychain.tokens.size).toBe(0);
  expect(readFileSync(configFile(), 'utf8')).toBe('[]');

  // Fixed by hand, the profile is back without a keychain entry; removing it again succeeds.
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' } } });
  const rerun = await remove('acme', ['y']);

  expect(rerun.done).toBe(true);
  expect(rerun.err).toBe('');
  expect(configJson()).toEqual({ profiles: {} });
});
