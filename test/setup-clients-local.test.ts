import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { parse as parseJsonc } from 'jsonc-parser';
import { expect, test } from 'vitest';
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

// `setup` run from a local checkout registers that checkout's build in the clients (the local beta,
// issue #22): no mock of src/manifest.ts, so these tests run from this very checkout, as `node
// dist/cli.js setup` would. Fake client configs in the temporary home of test/setup.ts, a scripted
// prompter, the fake keychain and a mock sevDesk.

const checkout = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;
const cli = join(checkout, 'dist', 'cli.js');

/** The command line of a local-build entry for `profile`. */
const argv = (profile: string) => [node, cli, '--profile', profile];

/** The entry setup writes into Claude Desktop's and Codex's configs for `profile`. */
function plainEntry(profile: string) {
  const [command, ...args] = argv(profile);
  return { command, args };
}

/** `path`, which a client location in the temporary home always has. */
function known(path: string | undefined): string {
  if (path === undefined) throw new Error('unknown client location');
  return path;
}

const desktopFile = () => join(known(claudeDesktopDirs().at(-1)), 'claude_desktop_config.json');
const codexFile = () => join(known(codexHome()), 'config.toml');
const openCodeFile = () => join(known(openCodeDir()), 'opencode.jsonc');
const text = (file: string) => readFileSync(file, 'utf8');

test('run from a local checkout, setup registers its build with the absolute Node path in all four clients', async () => {
  await mock();
  const desktop = desktopFile();
  const code = writeClient(known(claudeCodeFile()), {});
  for (const file of [desktop, codexFile(), openCodeFile()]) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const { done, asked, out, err } = await setup(['acme', TOKEN, '', '', '', '', '']);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(asked).toHaveLength(7);
  expect(isAbsolute(node)).toBe(true);
  expect(json(desktop)).toEqual({ mcpServers: { sevdesk: plainEntry('acme') } });
  // No `cmd /c` on any platform: node.exe needs no shell, unlike npx on Windows.
  expect(json(code)).toEqual({ mcpServers: { sevdesk: { type: 'stdio', ...plainEntry('acme') } } });
  expect(parseToml(text(codexFile()))).toEqual({ mcp_servers: { sevdesk: plainEntry('acme') } });
  expect(parseJsonc(text(openCodeFile()))).toEqual({
    mcp: { sevdesk: { type: 'local', command: argv('acme') } },
  });
  expect(out).toContain(
    `Running from the local checkout ${checkout}: the client entries start its build with this Node.js, not the published package. After every update, run bun run build there again.`,
  );
  expect(out).toContain(`For other MCP clients, use this command: ${argv('acme').join(' ')}`);
  expect(out).not.toContain('npx');
  expect(filesHolding(TOKEN)).toEqual([]);
});

test('without an installed client, setup says in German that it runs from the local checkout and shows its command', async () => {
  await mock();

  const { done, out } = await setup(['acme', TOKEN, ''], 'de');

  expect(done).toBe(true);
  expect(out).toContain(
    `Läuft aus dem lokalen Checkout ${checkout}: Die Client-Einträge starten dessen Build mit diesem Node.js, nicht das veröffentlichte Paket.`,
  );
  expect(out).toContain(`Trag diesen Befehl in deinen MCP-Client ein: ${argv('acme').join(' ')}`);
});

test('setup --remove run from the checkout removes the local-build entries of the profile', async () => {
  writeConfig({ profiles: { acme: { company: 'Acme GmbH' }, other: { company: 'Other AG' } } });
  const files = { command: 'files-mcp', args: ['/data'] };
  const content = {
    mcpServers: {
      'sevdesk-acme': plainEntry('acme'),
      'sevdesk-other': plainEntry('other'),
      files,
    },
  };
  const file = writeClient(desktopFile(), content);

  const { done, asked } = await remove('acme', ['y', 'y']);

  expect(done).toBe(true);
  expect(asked[1]?.question).toBe(
    `Remove sevdesk-acme (profile acme) from Claude Desktop (${file})? [Y/n] `,
  );
  expect(json(file)).toEqual({ mcpServers: { 'sevdesk-other': plainEntry('other'), files } });
  expect(backupsOf(file).map((backup) => json(backup))).toEqual([content]);
});
