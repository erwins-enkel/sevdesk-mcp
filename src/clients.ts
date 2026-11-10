import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CLAUDE_JSON,
  CODEX_TOML,
  type ConfigFormat,
  OPENCODE_JSONC,
  type Servers,
} from './client-formats.ts';
import { isRecord, readTextFile, type TextFile, writeTextFile } from './json-file.ts';
import { name as packageName, root } from './manifest.ts';
import { claudeCodeFile, claudeDesktopDirs, codexHome, openCodeDir } from './paths.ts';

/** An MCP client `setup` registers the server in (PRD §7 step 3, decision 18). */
interface McpClient {
  /** The client's name in setup's messages. */
  name: string;
  /** Its config file when the client is installed on this machine, else undefined. */
  configFile(): string | undefined;
  /** How that file holds the servers by name. */
  format: ConfigFormat;
  /** The entry that starts the command line `argv` in this client's config. */
  entry(argv: string[]): Record<string, unknown>;
}

/** An installed client with its config file, which need not exist yet. */
export interface InstalledClient {
  client: McpClient;
  file: string;
}

const OPENCODE_FILES = ['opencode.jsonc', 'opencode.json', 'config.json'];

const CLIENTS: McpClient[] = [
  {
    name: 'Claude Desktop',
    // Installed once its config directory exists; the file appears only once something is set.
    configFile() {
      const dir = claudeDesktopDirs().find((candidate) => existsSync(candidate));
      return dir === undefined ? undefined : join(dir, 'claude_desktop_config.json');
    },
    format: CLAUDE_JSON,
    entry: ([command, ...args]) => ({ command, args }),
  },
  {
    name: 'Claude Code',
    // Installed once Claude Code has created its global config, which it does on its first run.
    configFile() {
      const file = claudeCodeFile();
      return file !== undefined && existsSync(file) ? file : undefined;
    },
    format: CLAUDE_JSON,
    // On native Windows Claude Code cannot start npx (a .cmd script) without a shell; the local
    // build's node.exe needs none.
    entry(argv) {
      const shell = process.platform === 'win32' && argv[0] === 'npx';
      const [command, ...args] = shell ? ['cmd', '/c', ...argv] : argv;
      return { type: 'stdio', command, args };
    },
  },
  {
    // One client row: ChatGPT Desktop and the Codex CLI share the Codex home's config.toml.
    name: 'ChatGPT Desktop / Codex',
    // Installed once the Codex home exists; the file appears only once something is set.
    configFile() {
      const dir = codexHome();
      return dir !== undefined && existsSync(dir) ? join(dir, 'config.toml') : undefined;
    },
    format: CODEX_TOML,
    // Codex finds npx.cmd on Windows by itself.
    entry: ([command, ...args]) => ({ command, args }),
  },
  {
    name: 'OpenCode',
    // Installed once its global config directory exists, which OpenCode creates on every start.
    // Its global config is the first of these files that exists, the one that takes precedence,
    // else opencode.jsonc, the file OpenCode creates itself.
    configFile() {
      const dir = openCodeDir();
      if (dir === undefined || !existsSync(dir)) return undefined;
      const files = OPENCODE_FILES.map((name) => join(dir, name));
      return files.find((file) => existsSync(file)) ?? files[0];
    },
    format: OPENCODE_JSONC,
    entry: (argv) => ({ type: 'local', command: argv }),
  },
];

/** The MCP clients installed on this machine, in a fixed order. */
export function installedClients(): InstalledClient[] {
  return CLIENTS.flatMap((client) => {
    const file = client.configFile();
    return file === undefined ? [] : [{ client, file }];
  });
}

// The built CLI entry of the package root (package.json `bin`).
const BUILT_CLI = join(root, 'dist', 'cli.js');

/**
 * The kind of client entry `setup` writes: `npx` when it runs from an installed package (its root
 * lies under a `node_modules` folder, as with npx or a global install; decision 18), else `local`:
 * it runs from a local checkout, whose build the entry starts (the local beta, issue #22).
 */
export function launchKind(): 'npx' | 'local' {
  return root.split(/[\\/]/).includes('node_modules') ? 'npx' : 'local';
}

/**
 * The command line a client entry runs for `profile`; it never holds a token. An installed package
 * runs `npx -y <package>` (decision 18); a local checkout runs its build with the absolute path of
 * the running Node, since GUI clients often lack the user's PATH, and with `--reload`, so a new
 * build serves the next call without a client restart.
 */
export function launchArgv(profile: string): string[] {
  return launchKind() === 'npx'
    ? ['npx', '-y', packageName, '--profile', profile]
    : [process.execPath, BUILT_CLI, '--profile', profile, '--reload'];
}

/** The entry name for `profile`: `sevdesk`, or `sevdesk-<profile>` when there are several profiles. */
export function entryName(profile: string, profileCount: number): string {
  return profileCount > 1 ? `sevdesk-${profile}` : 'sevdesk';
}

/**
 * The servers of an installed client's config with the file as read (undefined when there is none
 * yet). Throws when the file cannot be read or its format does not hold servers.
 */
export function readServers({ client, file: path }: InstalledClient): {
  file?: TextFile;
  servers: Servers;
} {
  const file = readTextFile(path);
  return { file, servers: client.format.servers(file?.text, path) };
}

/** `value` when it is a list of strings, else undefined. */
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined;
}

/**
 * The command line an entry starts, or undefined when it has none: `command` and `args`, or
 * OpenCode's `command` that holds the whole command line.
 */
function commandLine(entry: unknown): string[] | undefined {
  if (!isRecord(entry)) return undefined;
  if (Array.isArray(entry.command)) return strings(entry.command);
  if (typeof entry.command !== 'string') return undefined;
  const args = strings(entry.args ?? []);
  return args === undefined ? undefined : [entry.command, ...args];
}

/**
 * How the entry `name` of `servers` relates to `entry`: there is none, it starts the same command
 * line, or it is a different one.
 */
export function entryState(
  servers: Servers,
  name: string,
  entry: Record<string, unknown>,
): 'absent' | 'same' | 'different' {
  if (!Object.hasOwn(servers, name)) return 'absent';
  const current = commandLine(servers[name]);
  return current !== undefined && isDeepStrictEqual(current, commandLine(entry))
    ? 'same'
    : 'different';
}

/**
 * The entries of `servers` that use `profile`, by name, with the kind of launch they run: they
 * start this package (any version) with npx, or the build of this package root (`local`), with
 * `--profile <profile>`.
 */
export function profileEntries(
  servers: Servers,
  profile: string,
): { name: string; kind: 'npx' | 'local' }[] {
  return Object.entries(servers).flatMap(([name, entry]) => {
    const argv = commandLine(entry) ?? [];
    const runsPackage = argv.some(
      (arg) => arg === packageName || arg.startsWith(`${packageName}@`),
    );
    const kind = runsPackage ? 'npx' : argv.includes(BUILT_CLI) ? 'local' : undefined;
    const forProfile = argv.some((arg, at) => arg === '--profile' && argv[at + 1] === profile);
    return kind !== undefined && forProfile ? [{ name, kind }] : [];
  });
}

/**
 * The names of the entries of `servers` that use `profile`: they start this package (any version)
 * or the build of this package root with `--profile <profile>`.
 */
export function entriesUsing(servers: Servers, profile: string): string[] {
  return profileEntries(servers, profile).map(({ name }) => name);
}

/**
 * Writes `bytes`, the content of `path` as read, as its backup next to it:
 * `<file>.sevdesk-mcp-<UTC time>.bak` with the file's permissions, never replacing a file. Returns
 * the backup's path.
 */
function backUp(path: string, bytes: Buffer): string {
  const backup = `${path}.sevdesk-mcp-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  const mode = statSync(path).mode & 0o777;
  writeFileSync(backup, bytes, { flag: 'wx', mode });
  chmodSync(backup, mode);
  return backup;
}

/**
 * Changes the servers of an installed client's config (decision 18): reads the file afresh and
 * passes its servers to `edit`, which returns the new ones, or undefined when the file is no longer
 * as the user was asked about. Then it backs the bytes it read up next to the file and writes the
 * file in its format with everything else kept. Returns whether it wrote and the backup's path
 * (undefined when there was no file yet). Throws when the file cannot be read, edited in its
 * format, backed up or written; the file is then as it was.
 */
export function rewriteServers(
  installed: InstalledClient,
  edit: (servers: Servers) => Servers | undefined,
): { written: false } | { written: true; backup: string | undefined } {
  const { client, file: path } = installed;
  const { file, servers } = readServers(installed);
  const changed = edit(servers);
  if (changed === undefined) return { written: false };
  const text = client.format.write(file?.text, changed, path);
  const backup = file === undefined ? undefined : backUp(path, file.bytes);
  writeTextFile(path, text);
  return { written: true, backup };
}
