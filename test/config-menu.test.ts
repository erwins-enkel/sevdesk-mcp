import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { auditDir } from '../src/audit.ts';
import { runConfig } from '../src/config-menu.ts';
import { configFile } from '../src/config.ts';
import type { Locale } from '../src/i18n/index.ts';
import { version } from '../src/manifest.ts';
import { claudeCodeFile } from '../src/paths.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { fakeKeychain } from './fake-keychain.ts';
import {
  BACK,
  backupsOf,
  CHECK,
  COMPANY,
  filesHolding,
  json,
  mock,
  setup,
  TOKEN,
  writeClient,
} from './setup-dialogue.ts';

// `config` (issue #46): the interactive menu over profiles, MCP client entries and settings, driven
// through a scripted prompter against the fake keychain, a mock sevDesk and fake client configs in
// the temporary home of test/setup.ts. These tests run from this checkout, so client entries start
// its build (`local build`).

const checkout = resolve(fileURLToPath(new URL('..', import.meta.url)));
const localEntry = (profile: string) => ({
  type: 'stdio',
  command: process.execPath,
  args: [join(checkout, 'dist', 'cli.js'), '--profile', profile, '--reload'],
});

/** `path` under the home directory as the overview shows it, with `~` for the home directory. */
function tilde(path: string): string {
  const rest = relative(homedir(), path);
  expect(rest.startsWith('..')).toBe(false);
  return join('~', rest);
}

/** Runs `config` in `locale` with `answers` given in turn to its menus and questions. */
function config(answers: Parameters<typeof setup>[0], locale: Locale = 'en') {
  return setup(answers, locale, runConfig);
}

/** Writes the config file with the profile acme (Acme GmbH) and `settings` of it. */
function acme(settings: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return writeConfig({ ...top, profiles: { acme: { company: 'Acme GmbH', ...settings } } });
}

/** The Claude Code config in the temporary home, which makes Claude Code count as installed. */
function claudeCode(content: unknown = {}): string {
  const file = claudeCodeFile();
  if (file === undefined) throw new Error('no Claude Code location');
  return writeClient(file, content);
}

/** Runs `execute` with `code` on a fresh connection. */
async function execute(code: string) {
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'execute', arguments: { code } });
    return { isError: result.isError === true, envelope: envelopeOf(result) };
  } finally {
    await client.close();
  }
}

const CREATE =
  "return (await sevdesk.request('POST', '/Contact', { body: { name: 'Max' } })).objects";

test('the overview shows every profile with its state and client entries, and reads no keychain', async () => {
  writeConfig({
    audit: false,
    profiles: {
      acme: { company: 'Acme GmbH', readonly: true },
      other: { company: 'Other AG', downloadDir: '/srv/pdfs' },
    },
  });
  const npx = { command: 'npx', args: ['-y', '@erwins-enkel/sevdesk-mcp', '--profile', 'other'] };
  claudeCode({ mcpServers: { 'sevdesk-acme': localEntry('acme'), 'sevdesk-other': npx } });

  const { done, asked, out, err } = await config([BACK]);

  expect(done).toBe(true);
  expect(err).toBe('');
  // The heading once, then the overview in columns, the home directory shown as `~`. Without a
  // checkout (as for an installed package) the version is shown and updates are not checked.
  expect(out).toBe(
    [
      'sevdesk-mcp config',
      '',
      `Version      ${version} (npm)`,
      'Updates      not checked here (npm install)',
      `Config file  ${tilde(configFile())}`,
      `Audit log    off (${tilde(auditDir())})`,
      '',
      'acme  Acme GmbH  read-only',
      `  Downloads    ${join('~', 'Downloads', 'sevdesk', 'acme')} (default)`,
      '  Claude Code  sevdesk-acme (local build)',
      '',
      'other  Other AG  read and write',
      '  Downloads    /srv/pdfs',
      '  Claude Code  sevdesk-other (npx)',
    ].join('\n'),
  );
  expect(asked[0]?.question).toBe('What do you want to change?');
  expect(asked[0]?.hint).toBe('arrow keys or 1-9, Enter to choose, Esc or q to go back');
  expect(asked[0]?.items).toEqual([
    'Profile acme (Acme GmbH)',
    'Profile other (Other AG)',
    'Add a profile',
    'Turn the audit log on',
    'Quit',
  ]);
  expect(fakeKeychain.accesses).toEqual([]);
});

test('toggling read-only changes only that key, and the server rejects or accepts writes accordingly', async () => {
  const sevdesk = await mock({ 'POST /Contact': () => ({ json: { objects: { id: '7' } } }) });
  acme({ downloadDir: '/srv/pdfs' }, { limits: { timeoutSeconds: 20 } });
  fakeKeychain.tokens.set('acme', TOKEN);
  const before = json(configFile());

  const on = await config(['Profile acme', 'Make it read-only', BACK, BACK]);

  expect(on.done).toBe(true);
  expect(on.successes).toBe('Profile acme is read-only now.');
  expect(on.out).toContain(
    'Profile acme is read-only now.\nRestart your MCP clients so they pick up the change.',
  );
  expect(on.asked[1]?.question).toBe('Profile acme (Acme GmbH)');
  expect(on.asked[2]?.items?.[0]).toBe('Allow writes again (read and write)');
  expect(json(configFile())).toEqual({
    limits: { timeoutSeconds: 20 },
    profiles: { acme: { company: 'Acme GmbH', downloadDir: '/srv/pdfs', readonly: true } },
  });
  const rejected = await execute(CREATE);
  expect(rejected.isError).toBe(true);
  expect(rejected.envelope).toMatchObject({ error: { kind: 'read_only' } });
  expect(sevdesk.requests.some(({ method }) => method === 'POST')).toBe(false);

  const off = await config(['Profile acme', 'Allow writes again', BACK, BACK]);

  expect(off.successes).toBe('Profile acme can read and write now.');
  expect(json(configFile())).toEqual({
    ...(before as object),
    profiles: { acme: { company: 'Acme GmbH', downloadDir: '/srv/pdfs', readonly: false } },
  });
  const accepted = await execute(CREATE);
  expect(accepted.isError).toBe(false);
  expect(accepted.envelope).toMatchObject({ result: { id: '7' } });
});

test('the download directory is set to an absolute path, a relative one is refused, and reset removes it', async () => {
  acme({ readonly: false });

  const set = await config([
    'Profile acme',
    'Set the download directory',
    'pdfs',
    'Set the download directory',
    '/srv/acme',
    BACK,
    BACK,
  ]);

  expect(set.done).toBe(false);
  expect(set.err).toBe('pdfs is not an absolute path; nothing was changed.');
  expect(set.successes).toBe('Profile acme saves its files in /srv/acme now.');
  expect(json(configFile())).toEqual({
    profiles: { acme: { company: 'Acme GmbH', readonly: false, downloadDir: '/srv/acme' } },
  });

  const reset = await config(['Profile acme', 'Reset the download directory', BACK, BACK]);

  expect(reset.done).toBe(true);
  const fallback = join(homedir(), 'Downloads', 'sevdesk', 'acme');
  expect(reset.successes).toBe(`Profile acme saves its files in ${fallback} now, the default.`);
  expect(json(configFile())).toEqual({
    profiles: { acme: { company: 'Acme GmbH', readonly: false } },
  });
});

test('the audit log is turned off and on again, with every other key kept', async () => {
  acme();

  const off = await config(['Turn the audit log off', BACK]);

  expect(off.done).toBe(true);
  expect(off.successes).toBe('The audit log is off: execute writes no more lines to it.');
  expect(json(configFile())).toEqual({
    profiles: { acme: { company: 'Acme GmbH' } },
    audit: false,
  });
  expect(off.asked[1]?.items).toContain('Turn the audit log on');

  const on = await config(['Turn the audit log on', BACK]);

  expect(on.successes).toBe('The audit log is on.');
  expect(json(configFile())).toEqual({ profiles: { acme: { company: 'Acme GmbH' } }, audit: true });
});

test('a profile is added to and removed from the installed clients, each with a backup', async () => {
  acme();
  const file = claudeCode({ mcpServers: { files: { command: 'files-mcp' } } });

  const add = await config(['Profile acme', 'Add it to the MCP clients', '', BACK, BACK]);

  expect(add.err).toBe('');
  expect(add.done).toBe(true);
  expect(add.asked[2]?.question).toBe(`Add the server to Claude Code as sevdesk (${file})? [Y/n] `);
  expect(json(file)).toEqual({
    mcpServers: { files: { command: 'files-mcp' }, sevdesk: localEntry('acme') },
  });
  expect(add.successes).toBe('Claude Code: sevdesk is added. Restart Claude Code to use it.');
  expect(backupsOf(file)).toHaveLength(1);

  const drop = await config(['Profile acme', 'Remove it from the MCP clients', 'y', BACK, BACK]);

  expect(drop.done).toBe(true);
  expect(drop.successes).toBe(
    'Claude Code: sevdesk removed. Restart Claude Code for the change to apply.',
  );
  expect(drop.out).toContain('  Claude Code  no entry');
  expect(json(file)).toEqual({ mcpServers: { files: { command: 'files-mcp' } } });
  expect(backupsOf(file)).toHaveLength(2);
  expect(json(configFile())).toEqual({ profiles: { acme: { company: 'Acme GmbH' } } });
  expect(fakeKeychain.accesses).toEqual([]);
});

test('the connection check uses the keychain token against sevDesk and never shows it', async () => {
  const sevdesk = await mock();
  acme();
  fakeKeychain.tokens.set('acme', TOKEN);

  const { done, out, successes, err } = await config([
    'Profile acme',
    'Check the connection',
    BACK,
    BACK,
  ]);

  expect(done).toBe(true);
  expect(err).toBe('');
  expect(out).toContain('Company: Acme GmbH\nBookkeeping system: 2.0');
  expect(successes).toBe('The connection of profile acme works.');
  expect(out).not.toContain(TOKEN);
  expect(sevdesk.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([CHECK, COMPANY]);
  expect(sevdesk.requests.every(({ authorization }) => authorization === TOKEN)).toBe(true);
});

test('a connection check without a keychain token fails before it reaches sevDesk', async () => {
  const sevdesk = await mock();
  acme();

  const { done, err } = await config(['Profile acme', 'Check the connection', BACK, BACK]);

  expect(done).toBe(false);
  expect(err).toContain('The token could not be read from the OS keychain');
  expect(err).toContain('The connection could not be checked.');
  expect(sevdesk.requests).toEqual([]);
});

test('a profile is removed after a yes: token and config entry gone, back to the main menu', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' }, other: { company: 'Other AG' } } });
  fakeKeychain.tokens.set('acme', TOKEN);

  const { done, asked, out } = await config(['Profile acme', 'Remove the profile', 'y', BACK]);

  expect(done).toBe(true);
  expect(asked[2]?.question).toContain('Remove profile acme (Acme GmbH)');
  expect(out).toContain('Profile acme (Acme GmbH) is removed');
  expect(fakeKeychain.tokens.has('acme')).toBe(false);
  expect(json(configFile())).toEqual({ profiles: { other: { company: 'Other AG' } } });
  expect(asked[3]?.items).toEqual([
    'Profile other (Other AG)',
    'Add a profile',
    'Turn the audit log off',
    'Quit',
  ]);
});

test('adding a profile hands over to the setup dialogue', async () => {
  await mock();

  const { done, out, successes } = await config(['Add a profile', 'acme', TOKEN, '', 'Quit']);

  expect(done).toBe(true);
  expect(out).toContain('There are no profiles yet.');
  expect(successes).toBe('Profile acme (Acme GmbH) is set up.');
  expect(out).toContain('\nacme  Acme GmbH  read and write\n');
  expect(fakeKeychain.tokens).toEqual(new Map([['acme', TOKEN]]));
  expect(filesHolding(TOKEN)).toEqual([]);
});

test('Ctrl+C at a question leaves the menu and changes nothing', async () => {
  acme();
  const before = readFileSync(configFile(), 'utf8');

  const { done, asked, err } = await config([
    'Profile acme',
    'Set the download directory',
    // Ctrl+C at the question; the prompter then cancels the next menu too, which leaves at once.
    undefined,
    undefined,
  ]);

  expect(done).toBe(false);
  expect(asked).toHaveLength(4);
  expect(err).toBe('Cancelled; nothing was changed.');
  expect(readFileSync(configFile(), 'utf8')).toBe(before);
});

test('the menu speaks German', async () => {
  acme();

  const { done, asked, out, successes } = await config(
    ['Profil acme', 'Nur lesend machen', BACK, BACK],
    'de',
  );

  expect(done).toBe(true);
  expect(out).toContain(`Konfigurationsdatei  ${tilde(configFile())}\nAudit-Log            an (`);
  expect(out).toContain(`  Downloads  ${join('~', 'Downloads', 'sevdesk', 'acme')} (Standard)`);
  expect(successes).toBe('Das Profil acme ist jetzt nur lesend.');
  expect(asked[0]?.question).toBe('Was möchtest du ändern?');
  expect(asked[0]?.hint).toBe('Pfeiltasten oder 1-9, Enter wählt, Esc oder q geht zurück');
  expect(asked[1]?.question).toBe('Profil acme (Acme GmbH)');
  expect(json(configFile())).toEqual({
    profiles: { acme: { company: 'Acme GmbH', readonly: true } },
  });
});

test('an unreadable client config shows in its row and the menu goes on', async () => {
  acme();
  const file = claudeCode();
  writeFileSync(file, '{ nope');

  const { done, out, err } = await config([BACK]);

  expect(done).toBe(true);
  expect(err).toBe('');
  expect(out).toContain(`\n  Claude Code  ${tilde(file)} could not be read (`);
});

test('an invalid config file stops the menu before it shows anything', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH', token: TOKEN } } });

  const { done, asked, out, err } = await config([]);

  expect(done).toBe(false);
  expect(asked).toEqual([]);
  expect(out).toBe('');
  expect(err).toContain('is invalid');
  expect(err).not.toContain(TOKEN);
  expect(existsSync(configFile())).toBe(true);
});
