import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { type Config, configFile, DEFAULT_CONFIG, loadConfig, saveProfile } from '../src/config.ts';
import { DEFAULT_LIMITS } from '../src/sandbox.ts';
import { DEFAULT_BASE_URL, DEFAULT_CALL_BUDGET } from '../src/sevdesk.ts';
import { writeConfig } from './config-file.ts';

const HINT = 'Fix the file or delete it to use the defaults, then restart the MCP server.';

/** The config the file yields; fails the test when the file is invalid. */
function loaded(): Config {
  const result = loadConfig();
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

/** The error message the file yields; fails the test when the file is valid. */
function problem(): string {
  const result = loadConfig();
  if (result.ok) throw new Error('the config file was accepted');
  expect(result.error).toMatchObject({ kind: 'invalid_config', hint: HINT });
  return result.error.message;
}

test('without a config file the documented defaults apply', () => {
  expect(loaded()).toEqual({
    baseUrl: 'https://my.sevdesk.de/api/v1',
    limits: { timeoutMs: 30_000, memoryBytes: 64 * 1024 * 1024, outputChars: 20_000 },
    maxCalls: 50,
    profiles: [],
    audit: true,
  });
  expect(DEFAULT_CONFIG).toEqual({
    baseUrl: DEFAULT_BASE_URL,
    limits: DEFAULT_LIMITS,
    maxCalls: DEFAULT_CALL_BUDGET,
    profiles: [],
    audit: true,
  });
});

test('the file sits in the config directory as config.json', () => {
  expect(writeConfig({})).toBe(configFile());
  expect(configFile()).toMatch(/[/\\]sevdesk-mcp[/\\]config\.json$/);
  expect(loaded()).toEqual(DEFAULT_CONFIG);
});

test('every key in the file is converted to the units the code uses', () => {
  writeConfig({
    baseUrl: 'https://sevdesk.example/api/v2/',
    limits: { timeoutSeconds: 5, memoryMb: 32, callsPerRun: 7, outputChars: 900 },
    profiles: { 'mcp-test': { company: 'MCP Test GmbH', readonly: true }, b2: { company: 'B' } },
    audit: false,
  });

  expect(loaded()).toEqual({
    baseUrl: 'https://sevdesk.example/api/v2',
    limits: { timeoutMs: 5000, memoryBytes: 32 * 1024 * 1024, outputChars: 900 },
    maxCalls: 7,
    profiles: [
      { name: 'mcp-test', company: 'MCP Test GmbH', readonly: true },
      { name: 'b2', company: 'B', readonly: false },
    ],
    audit: false,
  });
});

test('a profile keeps an absolute downloadDir as it is', () => {
  const downloadDir = join(homedir(), 'Belege');
  writeConfig({ profiles: { a: { company: 'A', downloadDir } } });

  expect(loaded().profiles).toEqual([{ name: 'a', company: 'A', readonly: false, downloadDir }]);
});

test('keys the file leaves out keep their defaults', () => {
  writeConfig({ limits: { callsPerRun: 3 } });

  expect(loaded()).toEqual({ ...DEFAULT_CONFIG, maxCalls: 3 });
});

test('a leading byte-order mark is accepted', () => {
  writeConfig('\uFEFF{ "limits": { "outputChars": 10 } }');

  expect(loaded().limits.outputChars).toBe(10);
});

test.each([
  ['{ "limits": ', 'it is not valid JSON ('],
  ['', 'it is not valid JSON ('],
  ['[]', 'it must hold a JSON object'],
  ['null', 'it must hold a JSON object'],
  ['"https://my.sevdesk.de/api/v1"', 'it must hold a JSON object'],
])('malformed content %j fails with the path and the problem', (content, expected) => {
  const file = writeConfig(content);

  const message = problem();
  expect(message).toContain(`The config file ${file} is invalid: `);
  expect(message).toContain(expected);
});

test.each([
  [{ baseURL: 'https://x.example' }, 'unknown key "baseURL"'],
  [{ limits: { timeoutSecond: 5 } }, 'unknown key "limits.timeoutSecond"'],
  [{ limits: [] }, 'limits must be an object'],
  [
    { limits: { timeoutSeconds: '30' } },
    'limits.timeoutSeconds must be an integer from 1 to 3600, not "30"',
  ],
  [
    { limits: { timeoutSeconds: 0 } },
    'limits.timeoutSeconds must be an integer from 1 to 3600, not 0',
  ],
  [
    { limits: { timeoutSeconds: 3601 } },
    'limits.timeoutSeconds must be an integer from 1 to 3600, not 3601',
  ],
  [{ limits: { memoryMb: 8 } }, 'limits.memoryMb must be an integer from 16 to 2048, not 8'],
  [{ limits: { memoryMb: 4096 } }, 'limits.memoryMb must be an integer from 16 to 2048, not 4096'],
  [{ limits: { callsPerRun: 1.5 } }, 'limits.callsPerRun must be a positive integer, not 1.5'],
  [{ limits: { outputChars: -1 } }, 'limits.outputChars must be a positive integer, not -1'],
  [{ limits: { outputChars: null } }, 'limits.outputChars must be a positive integer, not null'],
  [
    { baseUrl: 'http://my.sevdesk.de/api/v1' },
    'baseUrl must use https://, not http://, so the token never travels in clear text',
  ],
  [{ baseUrl: 'my.sevdesk.de/api/v1' }, 'baseUrl must be a URL string'],
  [{ baseUrl: 42 }, 'baseUrl must be a URL string'],
  [{ baseUrl: 'https://my.sevdesk.de/api/v1?x=1' }, 'baseUrl must not contain a query or fragment'],
  [{ baseUrl: 'https://my.sevdesk.de/api/v1#x' }, 'baseUrl must not contain a query or fragment'],
  [{ baseUrl: 'https://user:secret@my.sevdesk.de/api/v1' }, 'baseUrl must not contain credentials'],
  [{ profiles: [] }, 'profiles must be an object of profiles by name'],
  [{ audit: 'no' }, 'audit must be true or false'],
  [{ audit: 0 }, 'audit must be true or false'],
  [
    { profiles: { 'Bad Name': { company: 'A' } } },
    'profile name "Bad Name" must be 1 to 32 characters a-z, 0-9 and -',
  ],
  [
    { profiles: { ['a'.repeat(33)]: { company: 'A' } } },
    `profile name "${'a'.repeat(33)}" must be 1 to 32 characters a-z, 0-9 and -`,
  ],
  [{ profiles: { a: 'A GmbH' } }, 'profiles.a must be an object'],
  [{ profiles: { a: {} } }, 'profiles.a.company must be a non-empty string'],
  [{ profiles: { a: { company: ' ' } } }, 'profiles.a.company must be a non-empty string'],
  [
    { profiles: { a: { company: 'A', readonly: 'yes' } } },
    'profiles.a.readonly must be true or false',
  ],
  [{ profiles: { a: { company: 'A', readOnly: true } } }, 'unknown key "profiles.a.readOnly"'],
  [
    { profiles: { a: { company: 'A', downloadDir: 'Belege/sevdesk' } } },
    'profiles.a.downloadDir must be an absolute path',
  ],
  [
    { profiles: { a: { company: 'A', downloadDir: '~/Belege' } } },
    'profiles.a.downloadDir must be an absolute path',
  ],
  [
    { profiles: { a: { company: 'A', downloadDir: '' } } },
    'profiles.a.downloadDir must be an absolute path',
  ],
  [
    { profiles: { a: { company: 'A', downloadDir: ['/srv'] } } },
    'profiles.a.downloadDir must be an absolute path',
  ],
])('the invalid value in %j fails with the path and the problem', (content, expected) => {
  const file = writeConfig(content);

  expect(problem()).toBe(`The config file ${file} is invalid: ${expected}.`);
});

test('every problem of a file is reported at once, and a credential is never echoed', () => {
  const file = writeConfig({
    baseUrl: 'ftp://user:secret@my.sevdesk.de',
    limits: { memoryMb: 1, extra: true },
    telemetry: false,
  });

  const message = problem();
  expect(message).toBe(
    `The config file ${file} is invalid: unknown key "telemetry"; baseUrl must use https://, not ftp://, so the token never travels in clear text; limits.memoryMb must be an integer from 16 to 2048, not 1; unknown key "limits.extra".`,
  );
  expect(message).not.toContain('secret');
});

test('a token in a profile of the file is rejected, never read, and never echoed', () => {
  const file = writeConfig({ profiles: { a: { company: 'A', token: 'plain-token-7d1e' } } });

  const message = problem();
  expect(message).toBe(`The config file ${file} is invalid: unknown key "profiles.a.token".`);
  expect(message).not.toContain('plain-token-7d1e');
});

test('an unreadable config file fails with the path and the reason, not with the defaults', () => {
  const file = configFile();
  mkdirSync(file, { recursive: true });

  const message = problem();
  expect(message).toMatch(/^The config file .+ could not be read \(E[A-Z]+\)\.$/);
  expect(message).toContain(file);
});

/** The config file's JSON as it is on disk. */
function fileJson(): unknown {
  return JSON.parse(readFileSync(configFile(), 'utf8'));
}

test('saveProfile creates the config file and its directory', () => {
  saveProfile({ name: 'acme', company: 'Acme GmbH', readonly: false });

  expect(fileJson()).toEqual({ profiles: { acme: { company: 'Acme GmbH', readonly: false } } });
  expect(loaded().profiles).toEqual([{ name: 'acme', company: 'Acme GmbH', readonly: false }]);
  expect(readdirSync(dirname(configFile()))).toEqual(['config.json']);
});

test('saveProfile updates one profile and keeps every other key as it is', () => {
  const downloadDir = join(homedir(), 'Docs');
  writeConfig(
    `\uFEFF${JSON.stringify({
      baseUrl: 'https://example.test/api',
      limits: { outputChars: 99 },
      profiles: {
        acme: { company: 'Old GmbH', readonly: true, downloadDir },
        other: { company: 'Other AG' },
      },
    })}`,
  );

  saveProfile({ name: 'acme', company: 'Acme GmbH', readonly: false });
  saveProfile({ name: 'new', company: 'New KG', readonly: true });

  expect(fileJson()).toEqual({
    baseUrl: 'https://example.test/api',
    limits: { outputChars: 99 },
    profiles: {
      acme: { company: 'Acme GmbH', readonly: false, downloadDir },
      other: { company: 'Other AG' },
      new: { company: 'New KG', readonly: true },
    },
  });
  expect(loaded().profiles.map(({ name }) => name)).toEqual(['acme', 'other', 'new']);
});

test('saveProfile refuses a file that is not a JSON object and leaves it as it is', () => {
  writeConfig('[]');

  expect(() => {
    saveProfile({ name: 'acme', company: 'Acme GmbH', readonly: false });
  }).toThrow('does not hold a JSON object');
  expect(readFileSync(configFile(), 'utf8')).toBe('[]');
});
