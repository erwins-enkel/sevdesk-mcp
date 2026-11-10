import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { parse as parseJsonc } from 'jsonc-parser';
import { expect, test, vi } from 'vitest';
import { claudeCodeFile, claudeDesktopDirs, codexHome, openCodeDir } from '../src/paths.ts';
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

// `setup` registers the server in ChatGPT Desktop / Codex (their shared config.toml) and OpenCode
// (its global JSONC config) as it does in the Claude clients (PRD §7 step 3, decision 18), keeping
// comments, and `setup --remove` offers to remove the entries again: fake client configs in the
// temporary home of test/setup.ts, a scripted prompter, the fake keychain and a mock sevDesk.

const PACKAGE = '@erwins-enkel/sevdesk-mcp';

/** The command line of an entry for `profile`. */
const argv = (profile: string) => ['npx', '-y', PACKAGE, '--profile', profile];

/** The entry setup writes into Codex's config.toml for `profile`. */
function codexEntry(profile: string) {
  const [command, ...args] = argv(profile);
  return { command, args };
}

/** The entry setup writes into OpenCode's config for `profile`. */
const openCodeEntry = (profile: string) => ({ type: 'local', command: argv(profile) });

/** Codex's config.toml in the temporary home. */
function codexFile(): string {
  const dir = codexHome();
  if (dir === undefined) throw new Error('no Codex home');
  return join(dir, 'config.toml');
}

/** OpenCode's global config `name` in the temporary home. */
function openCodeFile(name = 'opencode.jsonc'): string {
  const dir = openCodeDir();
  if (dir === undefined) throw new Error('no OpenCode directory');
  return join(dir, name);
}

const text = (file: string) => readFileSync(file, 'utf8');
const toml = (file: string): unknown => parseToml(text(file));
const jsonc = (file: string): unknown => parseJsonc(text(file), [], { allowTrailingComma: true });

/** Whether every line of `before` is still in `after`, in the same order. */
function keepsLines(before: string, after: string): boolean {
  const lines = after.split('\n');
  let at = 0;
  return before.split('\n').every((line) => {
    at = lines.indexOf(line, at) + 1;
    return at > 0;
  });
}

const codexConfig = `# Codex config, edited by hand
model = "gpt-5.5" # the model
approval_policy = "on-request"

[projects."/work/app"]
trust_level = "trusted"

# The servers I use every day
[mcp_servers.files]
command = "files-mcp"
args = ["/data"]

[mcp_servers.files.env]
LOG_LEVEL = "info"

[tui]
notifications = true
`;
const codexParsed = {
  model: 'gpt-5.5',
  approval_policy: 'on-request',
  projects: { '/work/app': { trust_level: 'trusted' } },
  mcp_servers: { files: { command: 'files-mcp', args: ['/data'], env: { LOG_LEVEL: 'info' } } },
  tui: { notifications: true },
};

const openCodeConfig = `{
  "$schema": "https://opencode.ai/config.json",
  // The model I use
  "model": "anthropic/claude-sonnet-5-5",
  "mcp": {
    // Files on the NAS
    "files": { "type": "local", "command": ["files-mcp", "/data"] },
  },
}
`;
const openCodeParsed = {
  $schema: 'https://opencode.ai/config.json',
  model: 'anthropic/claude-sonnet-5-5',
  mcp: { files: { type: 'local', command: ['files-mcp', '/data'] } },
};

test('setup adds the entry to the Codex config.toml after a yes, keeps every comment and backs the file up', async () => {
  await mock();
  const file = writeClient(codexFile(), codexConfig);

  const { done, asked, out, err } = await setup(['acme', TOKEN, '', 'y']);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(asked[3]?.question).toBe(
    `Add the server to ChatGPT Desktop / Codex as sevdesk (${file})? [Y/n] `,
  );
  expect(toml(file)).toEqual({
    ...codexParsed,
    mcp_servers: { ...codexParsed.mcp_servers, sevdesk: codexEntry('acme') },
  });
  expect(keepsLines(codexConfig, text(file))).toBe(true);
  const backups = backupsOf(file);
  expect(backups).toHaveLength(1);
  expect(text(backups[0] ?? '')).toBe(codexConfig);
  expect(out).toContain(
    'ChatGPT Desktop / Codex: sevdesk is added. Restart ChatGPT Desktop / Codex to use it.',
  );
});

test('an existing Codex home without config.toml gets one holding only the entry', async () => {
  await mock();
  const file = codexFile();
  mkdirSync(dirname(file), { recursive: true });

  const { done } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(toml(file)).toEqual({ mcp_servers: { sevdesk: codexEntry('acme') } });
  expect(text(file).endsWith(']\n')).toBe(true);
  expect(backupsOf(file)).toEqual([]);
});

const theirCodexEntry = `# mine
[mcp_servers.sevdesk]
command = "node"
args = ["/opt/sevdesk/cli.js"]
startup_timeout_sec = 20

[tui]
notifications = true
`;

test.each([['n'], [''], ['maybe']])(
  'an existing different sevdesk table in config.toml stays byte-identical after the answer %j',
  async (answer) => {
    await mock();
    const file = writeClient(codexFile(), theirCodexEntry);

    const { done, asked, out } = await setup(['acme', TOKEN, '', answer]);

    expect(done).toBe(true);
    expect(asked[3]?.question).toBe(
      `ChatGPT Desktop / Codex already has an MCP server named sevdesk (${file}). Replace it? [y/N] `,
    );
    expect(text(file)).toBe(theirCodexEntry);
    expect(backupsOf(file)).toEqual([]);
    expect(out).toContain(`ChatGPT Desktop / Codex (${file}) was left as it is.`);
  },
);

test('an existing different sevdesk table in config.toml is replaced after an explicit yes', async () => {
  await mock();
  const file = writeClient(codexFile(), theirCodexEntry);

  const { done } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(toml(file)).toEqual({
    mcp_servers: { sevdesk: codexEntry('acme') },
    tui: { notifications: true },
  });
  expect(text(file)).toContain('# mine');
  expect(backupsOf(file)).toHaveLength(1);
});

test('a Codex entry that already starts the profile is left alone without a question', async () => {
  await mock();
  const same = `[mcp_servers.sevdesk]\ncommand = "npx"\nargs = ["-y", "${PACKAGE}", "--profile", "acme"]\nenv = { DEBUG = "1" }\n`;
  const file = writeClient(codexFile(), same);

  const { done, asked, out } = await setup(['acme', TOKEN, '']);

  expect(done).toBe(true);
  expect(asked).toHaveLength(3);
  expect(out).toContain('ChatGPT Desktop / Codex already starts this profile as sevdesk.');
  expect(text(file)).toBe(same);
});

test('Codex is found in an absolute CODEX_HOME, and not at all with a relative one', async () => {
  await mock();
  const home = writeClient(join(homedir(), '.codex', 'config.toml'), codexConfig);
  vi.stubEnv('CODEX_HOME', join(homedir(), 'codex-work'));
  const work = writeClient(codexFile(), codexConfig);

  const first = await setup(['acme', TOKEN, '', 'y']);

  expect(first.done).toBe(true);
  expect(first.asked[3]?.question).toContain(`(${work})`);
  expect(toml(work)).toMatchObject({ mcp_servers: { sevdesk: codexEntry('acme') } });
  expect(text(home)).toBe(codexConfig);

  vi.stubEnv('CODEX_HOME', 'codex-work');
  const second = await setup(['beta', TOKEN, '']);

  expect(second.done).toBe(true);
  expect(second.asked).toHaveLength(3);
  expect(second.out).toContain('Add this command to your MCP client');
});

test.each([
  ['a = [', 'Error parsing TOML (1, 5): Expected "]"'],
  ['mcp_servers = 1\n', 'mcp_servers in'],
  ['[[mcp_servers]]\ncommand = "x"\n', 'mcp_servers in'],
])(
  'a config.toml %j that cannot be used is reported and left alone; OpenCode still is asked',
  async (content, reason) => {
    await mock();
    const file = writeClient(codexFile(), content);
    mkdirSync(dirname(openCodeFile()), { recursive: true });

    const { done, asked, err } = await setup(['acme', TOKEN, '', 'y']);

    expect(done).toBe(false);
    expect(err).toContain(`ChatGPT Desktop / Codex: ${file} could not be read (${reason}`);
    expect(err).toContain('); it was left as it is.');
    expect(text(file)).toBe(content);
    expect(asked[3]?.question).toBe(
      `Add the server to OpenCode as sevdesk (${openCodeFile()})? [Y/n] `,
    );
    expect(jsonc(openCodeFile())).toEqual({ mcp: { sevdesk: openCodeEntry('acme') } });
  },
);

test('setup --remove removes exactly the entries of the profile from config.toml after a yes, keeping comments', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' }, other: { company: 'Other AG' } } });
  const content = `${codexConfig}
# Both sevDesk accounts
[mcp_servers.sevdesk-acme]
command = "npx"
args = ["-y", "${PACKAGE}", "--profile", "acme"]

[mcp_servers.sevdesk-other]
command = "npx"
args = ["-y", "${PACKAGE}", "--profile", "other"]
`;
  const file = writeClient(codexFile(), content);

  const { done, asked, out } = await remove('acme', ['y', 'y']);

  expect(done).toBe(true);
  expect(asked[1]?.question).toBe(
    `Remove sevdesk-acme (profile acme) from ChatGPT Desktop / Codex (${file})? [Y/n] `,
  );
  expect(toml(file)).toEqual({
    ...codexParsed,
    mcp_servers: { ...codexParsed.mcp_servers, 'sevdesk-other': codexEntry('other') },
  });
  expect(keepsLines(codexConfig, text(file))).toBe(true);
  expect(text(backupsOf(file)[0] ?? '')).toBe(content);
  expect(out).toContain('ChatGPT Desktop / Codex: sevdesk-acme removed.');
});

test('setup adds the entry to the mcp section of OpenCode after a yes, keeps comments and backs the file up', async () => {
  await mock();
  const file = writeClient(openCodeFile(), openCodeConfig);

  const { done, asked, out, err } = await setup(['acme', TOKEN, '', 'y']);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(asked[3]?.question).toBe(`Add the server to OpenCode as sevdesk (${file})? [Y/n] `);
  expect(jsonc(file)).toEqual({
    ...openCodeParsed,
    mcp: { ...openCodeParsed.mcp, sevdesk: openCodeEntry('acme') },
  });
  expect(text(file)).toContain('// The model I use');
  expect(text(file)).toContain('// Files on the NAS');
  expect(text(backupsOf(file)[0] ?? '')).toBe(openCodeConfig);
  expect(out).toContain('OpenCode: sevdesk is added. Restart OpenCode to use it.');
});

test('OpenCode: opencode.json is used when it is the only global config', async () => {
  await mock();
  const config = { $schema: 'https://opencode.ai/config.json', model: 'm' };
  const file = writeClient(openCodeFile('opencode.json'), config);

  const { done, asked } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(asked[3]?.question).toContain(`(${file})`);
  expect(json(file)).toEqual({ ...config, mcp: { sevdesk: openCodeEntry('acme') } });
});

test('OpenCode: opencode.jsonc wins over opencode.json, which stays byte-identical', async () => {
  await mock();
  const plainFile = writeClient(openCodeFile('opencode.json'), { model: 'm' });
  const before = text(plainFile);
  const file = writeClient(openCodeFile('opencode.jsonc'), openCodeConfig);

  const { done } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(jsonc(file)).toMatchObject({ mcp: { sevdesk: openCodeEntry('acme') } });
  expect(text(plainFile)).toBe(before);
});

test('OpenCode without a global config gets an opencode.jsonc holding only the entry', async () => {
  await mock();
  const file = openCodeFile();
  mkdirSync(dirname(file), { recursive: true });

  const { done } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(jsonc(file)).toEqual({ mcp: { sevdesk: openCodeEntry('acme') } });
  expect(backupsOf(file)).toEqual([]);
});

test('an existing different sevdesk entry in OpenCode stays after the default answer and is replaced after a yes', async () => {
  await mock();
  const theirs = `{\n  // mine\n  "mcp": { "sevdesk": { "type": "local", "command": ["node", "/opt/sevdesk/cli.js"] } }\n}\n`;
  const file = writeClient(openCodeFile(), theirs);

  const first = await setup(['acme', TOKEN, '', '']);

  expect(first.done).toBe(true);
  expect(first.asked[3]?.question).toBe(
    `OpenCode already has an MCP server named sevdesk (${file}). Replace it? [y/N] `,
  );
  expect(text(file)).toBe(theirs);
  expect(backupsOf(file)).toEqual([]);

  // The profile exists now, so setup first asks whether to replace it.
  const second = await setup(['acme', 'y', TOKEN, '', 'y']);

  expect(second.done).toBe(true);
  expect(second.asked[4]?.question).toContain('Replace it? [y/N]');
  expect(jsonc(file)).toEqual({ mcp: { sevdesk: openCodeEntry('acme') } });
  expect(text(file)).toContain('// mine');
  expect(backupsOf(file)).toHaveLength(1);
});

test.each([
  ['{ "mcp": ', 'ValueExpected in line 1'],
  ['{ "mcp": [] }', 'mcp in'],
  [
    '{ "mcp": { "servers": { "files": { "type": "local", "command": ["files-mcp"] } } } }',
    'mcp.servers in',
  ],
])(
  'an OpenCode config %j that cannot be used is reported and left alone',
  async (content, reason) => {
    await mock();
    const file = writeClient(openCodeFile(), content);

    const { done, err } = await setup(['acme', TOKEN, '']);

    expect(done).toBe(false);
    expect(err).toContain(`OpenCode: ${file} could not be read (${reason}`);
    expect(text(file)).toBe(content);
    expect(backupsOf(file)).toEqual([]);
  },
);

test('an OpenCode server named servers is a server, not the layout of OpenCode 2', async () => {
  await mock();
  const servers = { type: 'local', command: ['servers-mcp'] };
  const file = writeClient(openCodeFile(), { mcp: { servers } });

  const { done } = await setup(['acme', TOKEN, '', 'y']);

  expect(done).toBe(true);
  expect(jsonc(file)).toEqual({ mcp: { servers, sevdesk: openCodeEntry('acme') } });
});

test('OpenCode is not asked with a relative XDG_CONFIG_HOME', async () => {
  await mock();
  mkdirSync(join(homedir(), '.config', 'opencode'), { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', '.config');

  const { done, asked, out } = await setup(['acme', TOKEN, '']);

  expect(done).toBe(true);
  expect(asked).toHaveLength(3);
  expect(out).toContain('Add this command to your MCP client');
});

test('setup --remove removes exactly the entries of the profile from OpenCode, and a no leaves it byte-identical', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' }, other: { company: 'Other AG' } } });
  const content = `{
  // Both sevDesk accounts
  "mcp": {
    "sevdesk-acme": { "type": "local", "command": ["npx", "-y", "${PACKAGE}", "--profile", "acme"] },
    "sevdesk-other": { "type": "local", "command": ["npx", "-y", "${PACKAGE}", "--profile", "other"] },
  },
}
`;
  const file = writeClient(openCodeFile(), content);

  const { done, asked } = await remove('acme', ['y', 'y']);

  expect(done).toBe(true);
  expect(asked[1]?.question).toBe(
    `Remove sevdesk-acme (profile acme) from OpenCode (${file})? [Y/n] `,
  );
  expect(jsonc(file)).toEqual({ mcp: { 'sevdesk-other': openCodeEntry('other') } });
  expect(text(file)).toContain('// Both sevDesk accounts');
  expect(text(backupsOf(file)[0] ?? '')).toBe(content);
  const before = text(file);

  const kept = await remove('other', ['y', 'n']);

  expect(kept.done).toBe(true);
  expect(text(file)).toBe(before);
  expect(backupsOf(file)).toHaveLength(1);
});

test('all four clients are asked in turn, an empty answer adds, and no written file holds the token', async () => {
  await mock();
  const desktopDir = claudeDesktopDirs().at(-1) ?? '';
  mkdirSync(desktopDir, { recursive: true });
  const code = writeClient(claudeCodeFile() ?? '', { numStartups: 1 });
  const codex = writeClient(codexFile(), codexConfig);
  const openCode = writeClient(openCodeFile(), openCodeConfig);

  const { done, asked } = await setup(['acme', TOKEN, '', '', '', '', '']);

  expect(done).toBe(true);
  expect(asked.slice(3).map(({ question }) => question.split(' as ')[0])).toEqual([
    'Add the server to Claude Desktop',
    'Add the server to Claude Code',
    'Add the server to ChatGPT Desktop / Codex',
    'Add the server to OpenCode',
  ]);
  expect(json(join(desktopDir, 'claude_desktop_config.json'))).toMatchObject({
    mcpServers: { sevdesk: { args: argv('acme').slice(1) } },
  });
  expect(json(code)).toMatchObject({ mcpServers: { sevdesk: { type: 'stdio' } } });
  expect(toml(codex)).toMatchObject({ mcp_servers: { sevdesk: codexEntry('acme') } });
  expect(jsonc(openCode)).toMatchObject({ mcp: { sevdesk: openCodeEntry('acme') } });
  expect(filesHolding(TOKEN)).toEqual([]);
});
