import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { configFile } from '../src/config.ts';
import { claudeCodeFile, claudeDesktopDirs } from '../src/paths.ts';
import { writeConfig } from './config-file.ts';
import {
  backupsOf,
  filesHolding,
  json,
  mock,
  remove,
  setup,
  TOKEN,
  writeClient,
} from './setup-dialogue.ts';

// `setup` registers the server in the installed Claude Desktop and Claude Code (PRD §7 step 3,
// decision 18) and `setup --remove` offers to remove the entries of the removed profile: fake
// client configs in the temporary home of test/setup.ts, a scripted prompter, the fake keychain
// and a mock sevDesk.

// setup runs as from an installed package here, so its client entries run npx (decision 18).
vi.mock('../src/manifest.ts', () => import('./installed-package.ts'));

const PACKAGE = '@erwins-enkel/sevdesk-mcp';
const windows = process.platform === 'win32';

/** The command line of an entry for `profile`. */
const argv = (profile: string) => ['npx', '-y', PACKAGE, '--profile', profile];

/** The entry setup writes into Claude Desktop's config for `profile`. */
function desktopEntry(profile: string) {
  const [command, ...args] = argv(profile);
  return { command, args };
}

/** The entry setup writes into Claude Code's config for `profile` (cmd /c on native Windows). */
function codeEntry(profile: string) {
  const [command, ...args] = windows ? ['cmd', '/c', ...argv(profile)] : argv(profile);
  return { type: 'stdio', command, args };
}

/** Claude Desktop's config file in the temporary home (on Windows the APPDATA one). */
function desktopFile(): string {
  const dir = claudeDesktopDirs().at(-1);
  if (dir === undefined) throw new Error('no Claude Desktop directory');
  return join(dir, 'claude_desktop_config.json');
}

/** Claude Code's config file in the temporary home. */
function codeFile(): string {
  const file = claudeCodeFile();
  if (file === undefined) throw new Error('no Claude Code config file');
  return file;
}

/** The profiles of the config file. */
function profiles(): unknown {
  return (json(configFile()) as { profiles: unknown }).profiles;
}

const desktopConfig = {
  mcpServers: { files: { command: 'files-mcp', args: ['/data'] } },
  preferences: { sidebarMode: 'chat' },
};
const codeConfig = {
  numStartups: 3,
  projects: { '/work/app': { mcpServers: { local: { type: 'stdio', command: 'local-mcp' } } } },
  mcpServers: { github: { type: 'http', url: 'https://example.com/mcp' } },
};

test('setup adds the entry to Claude Desktop after a yes, keeps every other key and backs the file up', async () => {
  await mock();
  const file = writeClient(desktopFile(), desktopConfig);
  const before = readFileSync(file);

  const { done, asked, out, err } = await setup(['acme', TOKEN, '', 'y']);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(asked[3]?.question).toBe(`Add the server to Claude Desktop as sevdesk (${file})? [Y/n] `);
  expect(json(file)).toEqual({
    mcpServers: { ...desktopConfig.mcpServers, sevdesk: desktopEntry('acme') },
    preferences: desktopConfig.preferences,
  });
  const backups = backupsOf(file);
  expect(backups).toHaveLength(1);
  expect(readFileSync(backups[0] ?? '')).toEqual(before);
  expect(out).toContain('Claude Desktop: sevdesk is added. Restart Claude Desktop to use it.');
  expect(out).toContain(`The previous file is saved as ${backups[0] ?? ''}.`);
  expect(out).toContain(
    `For other MCP clients, use this command: npx -y ${PACKAGE} --profile acme`,
  );
  expect(out).not.toContain('Add this command to your MCP client');
});

test('setup adds the entry to Claude Code after a yes, keeps every other key and backs the file up', async () => {
  await mock();
  const file = writeClient(codeFile(), codeConfig);
  const before = readFileSync(file);

  const { done, asked, err } = await setup(['acme', TOKEN, '', 'yes']);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(asked[3]?.question).toBe(`Add the server to Claude Code as sevdesk (${file})? [Y/n] `);
  expect(json(file)).toEqual({
    ...codeConfig,
    mcpServers: { ...codeConfig.mcpServers, sevdesk: codeEntry('acme') },
  });
  const backups = backupsOf(file);
  expect(backups).toHaveLength(1);
  expect(readFileSync(backups[0] ?? '')).toEqual(before);
});

test('both clients are asked in turn, an empty answer adds, and no written file holds the token', async () => {
  await mock();
  const desktop = writeClient(desktopFile(), desktopConfig);
  const code = writeClient(codeFile(), codeConfig);

  const { done, asked } = await setup(['acme', TOKEN, '', '', '']);

  expect(done).toBe(true);
  expect(asked.slice(3).map(({ question }) => question.split(' as ')[0])).toEqual([
    'Add the server to Claude Desktop',
    'Add the server to Claude Code',
  ]);
  expect(json(desktop)).toMatchObject({ mcpServers: { sevdesk: desktopEntry('acme') } });
  expect(json(code)).toMatchObject({ mcpServers: { sevdesk: codeEntry('acme') } });
  expect(filesHolding(TOKEN)).toEqual([]);
});

test('a no leaves the client config byte-identical and without a backup', async () => {
  await mock();
  const file = writeClient(desktopFile(), desktopConfig);
  const before = readFileSync(file);

  const { done, out } = await setup(['acme', TOKEN, '', 'n']);

  expect(done).toBe(true);
  expect(readFileSync(file)).toEqual(before);
  expect(backupsOf(file)).toEqual([]);
  expect(out).toContain(`Claude Desktop (${file}) was left as it is.`);
});

test.each([['n'], [''], ['maybe']])(
  'an existing different sevdesk entry stays byte-identical after the answer %j',
  async (answer) => {
    await mock();
    const file = writeClient(codeFile(), {
      ...codeConfig,
      mcpServers: { sevdesk: { command: 'node', args: ['/opt/sevdesk/cli.js'] } },
    });
    const before = readFileSync(file);

    const { done, asked, out, err } = await setup(['acme', TOKEN, '', answer]);

    expect(err).toBe('');
    expect(done).toBe(true);
    expect(asked[3]?.question).toBe(
      `Claude Code already has an MCP server named sevdesk (${file}). Replace it? [y/N] `,
    );
    expect(readFileSync(file)).toEqual(before);
    expect(backupsOf(file)).toEqual([]);
    expect(out).toContain(`Claude Code (${file}) was left as it is.`);
  },
);

test('an existing different sevdesk entry is replaced after an explicit yes', async () => {
  await mock();
  const file = writeClient(codeFile(), {
    ...codeConfig,
    mcpServers: { sevdesk: { command: 'node', args: ['/opt/sevdesk/cli.js'] }, z: {} },
  });

  const { done } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(json(file)).toEqual({ ...codeConfig, mcpServers: { sevdesk: codeEntry('acme'), z: {} } });
  expect(backupsOf(file)).toHaveLength(1);
});

test('a local-build entry switches to the published package after an explicit yes to replace it', async () => {
  await mock();
  const local = {
    command: '/usr/bin/node',
    args: ['/home/you/sevdesk-mcp/dist/cli.js', '--profile', 'acme'],
  };
  const file = writeClient(desktopFile(), { mcpServers: { sevdesk: local } });
  const before = readFileSync(file);

  const { done, asked, out } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(out).toContain('The client entries start the published package with npx.');
  expect(asked[3]?.question).toBe(
    `Claude Desktop already has an MCP server named sevdesk (${file}). Replace it? [y/N] `,
  );
  expect(json(file)).toEqual({ mcpServers: { sevdesk: desktopEntry('acme') } });
  expect(backupsOf(file).map((backup) => readFileSync(backup))).toEqual([before]);
});

test('an entry that already starts the profile is left alone without a question', async () => {
  await mock();
  const file = writeClient(desktopFile(), { mcpServers: { sevdesk: desktopEntry('acme') } });
  const before = readFileSync(file);

  const { done, asked, out } = await setup(['acme', TOKEN, '']);

  expect(done).toBe(true);
  expect(asked).toHaveLength(3);
  expect(out).toContain('Claude Desktop already starts this profile as sevdesk.');
  expect(readFileSync(file)).toEqual(before);
  expect(backupsOf(file)).toEqual([]);
});

test('with several profiles the entry is named sevdesk-<profile> in both clients', async () => {
  await mock();
  writeConfig({ profiles: { other: { company: 'Other AG' } } });
  const otherEntry = { sevdesk: desktopEntry('other') };
  const desktop = writeClient(desktopFile(), { mcpServers: otherEntry });
  const code = writeClient(codeFile(), codeConfig);

  const { done, asked } = await setup(['acme', TOKEN, '', 'y', 'y']);

  expect(done).toBe(true);
  expect(asked[3]?.question).toContain('Claude Desktop as sevdesk-acme');
  expect(json(desktop)).toEqual({
    mcpServers: { ...otherEntry, 'sevdesk-acme': desktopEntry('acme') },
  });
  expect(json(code)).toMatchObject({ mcpServers: { 'sevdesk-acme': codeEntry('acme') } });
});

test('an installed Claude Desktop without a config file gets one holding only the entry', async () => {
  await mock();
  const file = desktopFile();
  mkdirSync(dirname(file), { recursive: true });

  const { done, out } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(json(file)).toEqual({ mcpServers: { sevdesk: desktopEntry('acme') } });
  expect(backupsOf(file)).toEqual([]);
  expect(out).not.toContain('The previous file is saved');
});

test.each([['{ nope'], ['[]'], ['{ "mcpServers": [] }'], ['{ "mcpServers": null }']])(
  'a client config %j that cannot be used is reported and left alone; the other client still is asked',
  async (content) => {
    await mock();
    const desktop = writeClient(desktopFile(), content);
    const code = writeClient(codeFile(), codeConfig);

    const { done, asked, err } = await setup(['acme', TOKEN, '', 'y']);

    expect(done).toBe(false);
    expect(err).toContain(`Claude Desktop: ${desktop} could not be read (`);
    expect(err).toContain('); it was left as it is.');
    expect(readFileSync(desktop, 'utf8')).toBe(content);
    expect(asked[3]?.question).toContain('Claude Code');
    expect(json(code)).toMatchObject({ mcpServers: { sevdesk: codeEntry('acme') } });
    expect(profiles()).toEqual({ acme: { company: 'Acme GmbH', readonly: false } });
  },
);

test('a client config that changes while the question is open is left as it changed', async () => {
  await mock();
  const file = writeClient(desktopFile(), desktopConfig);
  const theirs = { mcpServers: { sevdesk: { command: 'theirs' } } };
  const writeTheirs = () => {
    writeClient(file, theirs);
    return 'y';
  };

  const { done, err } = await setup(['acme', TOKEN, '', writeTheirs]);

  expect(done).toBe(false);
  expect(err).toBe(`Claude Desktop: ${file} changed while you answered, so it was left as it is.`);
  expect(json(file)).toEqual(theirs);
  expect(backupsOf(file)).toEqual([]);
});

test('a cancelled client question keeps the stored profile and says the client configs are untouched', async () => {
  await mock();
  const file = writeClient(desktopFile(), desktopConfig);
  const before = readFileSync(file);

  const { done, err } = await setup(['acme', TOKEN, '', undefined]);

  expect(done).toBe(false);
  expect(err).toBe('Setup cancelled.\nClient configs not changed so far are left as they are.');
  expect(readFileSync(file)).toEqual(before);
  expect(profiles()).toEqual({ acme: { company: 'Acme GmbH', readonly: false } });
});

test('the client question is asked in German', async () => {
  await mock();
  const file = writeClient(desktopFile(), desktopConfig);

  const { done, asked, out } = await setup(['acme', TOKEN, '', 'ja'], 'de');

  expect(done).toBe(true);
  expect(asked[3]?.question).toBe(
    `Den Server in Claude Desktop als sevdesk eintragen (${file})? [J/n] `,
  );
  expect(out).toContain('Die Client-Einträge starten das veröffentlichte Paket mit npx.');
  expect(out).toContain('Claude Desktop: sevdesk ist eingetragen.');
  expect(out).toContain(`Für andere MCP-Clients nimmst du diesen Befehl: npx -y ${PACKAGE}`);
});

test('Claude Code is found in an absolute CLAUDE_CONFIG_DIR, and not at all with a relative one', async () => {
  await mock();
  const home = writeClient(join(homedir(), '.claude.json'), codeConfig);
  const before = readFileSync(home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(homedir(), '.claude-work'));
  const work = writeClient(codeFile(), codeConfig);

  const first = await setup(['acme', TOKEN, '', 'y']);

  expect(first.done).toBe(true);
  expect(first.asked[3]?.question).toContain(`(${work})`);
  expect(json(work)).toMatchObject({ mcpServers: { sevdesk: codeEntry('acme') } });
  expect(readFileSync(home)).toEqual(before);

  vi.stubEnv('CLAUDE_CONFIG_DIR', '.claude-work');
  const second = await setup(['beta', TOKEN, '']);

  expect(second.done).toBe(true);
  expect(second.asked).toHaveLength(3);
  expect(second.out).toContain('Add this command to your MCP client');
});

test.skipIf(windows)(
  'a symlinked 0600 Claude Code config stays a symlink with its mode, and so does its backup',
  async () => {
    await mock();
    const target = writeClient(join(homedir(), 'dotfiles', 'claude.json'), codeConfig);
    chmodSync(target, 0o600);
    symlinkSync(target, codeFile());

    const { done } = await setup(['acme', TOKEN, '', 'y']);

    expect(done).toBe(true);
    expect(lstatSync(codeFile()).isSymbolicLink()).toBe(true);
    expect(json(target)).toMatchObject({ mcpServers: { sevdesk: codeEntry('acme') } });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const [backup] = backupsOf(codeFile());
    expect(statSync(backup ?? '').mode & 0o777).toBe(0o600);
  },
);

test.runIf(windows)('on Windows the packaged Claude Desktop folder wins over APPDATA', async () => {
  await mock();
  const [packaged, roaming] = claudeDesktopDirs();
  mkdirSync(packaged ?? '', { recursive: true });
  mkdirSync(roaming ?? '', { recursive: true });

  const { done } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(existsSync(join(packaged ?? '', 'claude_desktop_config.json'))).toBe(true);
  expect(existsSync(join(roaming ?? '', 'claude_desktop_config.json'))).toBe(false);
});

test('setup --remove removes exactly the entries of the profile from both clients after a yes', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' }, other: { company: 'Other AG' } } });
  const desktop = writeClient(desktopFile(), {
    mcpServers: {
      'sevdesk-acme': desktopEntry('acme'),
      'sevdesk-other': desktopEntry('other'),
      files: desktopConfig.mcpServers.files,
    },
    preferences: desktopConfig.preferences,
  });
  const pinned = { type: 'stdio', command: 'npx', args: [`${PACKAGE}@0.1.0`, '--profile', 'acme'] };
  const code = writeClient(codeFile(), {
    ...codeConfig,
    mcpServers: { ...codeConfig.mcpServers, sevdesk: pinned },
  });
  const before = { desktop: readFileSync(desktop), code: readFileSync(code) };

  const { done, asked, out, err } = await remove('acme', ['y', 'y', '']);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(asked.slice(1).map(({ question }) => question)).toEqual([
    `Remove sevdesk-acme (profile acme) from Claude Desktop (${desktop})? [Y/n] `,
    `Remove sevdesk (profile acme) from Claude Code (${code})? [Y/n] `,
  ]);
  expect(json(desktop)).toEqual({
    mcpServers: { 'sevdesk-other': desktopEntry('other'), files: desktopConfig.mcpServers.files },
    preferences: desktopConfig.preferences,
  });
  expect(json(code)).toEqual(codeConfig);
  expect(readFileSync(backupsOf(desktop)[0] ?? '')).toEqual(before.desktop);
  expect(readFileSync(backupsOf(code)[0] ?? '')).toEqual(before.code);
  expect(out).toContain(
    'Claude Desktop: sevdesk-acme removed. Restart Claude Desktop for the change to apply.',
  );
  expect(out).toContain(
    'If another MCP client runs sevdesk-mcp with --profile acme, remove that entry from its config.',
  );
});

test('setup --remove after a no for the client entries leaves the client config byte-identical', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' } } });
  const desktop = writeClient(desktopFile(), { mcpServers: { sevdesk: desktopEntry('acme') } });
  const unrelated = writeClient(codeFile(), codeConfig);
  const before = { desktop: readFileSync(desktop), code: readFileSync(unrelated) };

  const { done, asked } = await remove('acme', ['y', 'n']);

  expect(done).toBe(true);
  expect(asked).toHaveLength(2);
  expect(readFileSync(desktop)).toEqual(before.desktop);
  expect(readFileSync(unrelated)).toEqual(before.code);
  expect(backupsOf(desktop)).toEqual([]);
  expect(backupsOf(unrelated)).toEqual([]);
  expect(json(configFile())).toEqual({ profiles: {} });
});
