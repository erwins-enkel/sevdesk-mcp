import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isRecord, type JsonFile, readJsonFile, writeJsonFile } from './json-file.ts';
import { name as packageName } from './manifest.ts';
import { claudeCodeFile, claudeDesktopDirs } from './paths.ts';

/**
 * An MCP client `setup` registers the server in (PRD §7 step 3, decision 18). Its config file is
 * JSON with the servers by name under `mcpServers`; a client with another key or file format
 * (OpenCode, Codex) adds that here along with its row in `CLIENTS`.
 */
interface McpClient {
  /** The client's name in setup's messages. */
  name: string;
  /** Its config file when the client is installed on this machine, else undefined. */
  configFile(): string | undefined;
  /** The entry that starts the command line `argv` in this client's config. */
  entry(argv: string[]): Record<string, unknown>;
}

/** An installed client with its config file, which need not exist yet. */
export interface InstalledClient {
  client: McpClient;
  file: string;
}

/** A client config's servers by name. */
type Servers = Record<string, unknown>;

const SERVERS = 'mcpServers';

const CLIENTS: McpClient[] = [
  {
    name: 'Claude Desktop',
    // Installed once its config directory exists; the file appears only once something is set.
    configFile() {
      const dir = claudeDesktopDirs().find((candidate) => existsSync(candidate));
      return dir === undefined ? undefined : join(dir, 'claude_desktop_config.json');
    },
    entry: ([command, ...args]) => ({ command, args }),
  },
  {
    name: 'Claude Code',
    // Installed once Claude Code has created its global config, which it does on its first run.
    configFile() {
      const file = claudeCodeFile();
      return file !== undefined && existsSync(file) ? file : undefined;
    },
    // On native Windows Claude Code cannot start npx (a .cmd script) without a shell.
    entry(argv) {
      const [command, ...args] = process.platform === 'win32' ? ['cmd', '/c', ...argv] : argv;
      return { type: 'stdio', command, args };
    },
  },
];

/** The MCP clients installed on this machine, in a fixed order. */
export function installedClients(): InstalledClient[] {
  return CLIENTS.flatMap((client) => {
    const file = client.configFile();
    return file === undefined ? [] : [{ client, file }];
  });
}

/** The command line a client entry runs for `profile` (decision 18); it never holds a token. */
export function launchArgv(profile: string): string[] {
  return ['npx', '-y', packageName, '--profile', profile];
}

/** The entry name for `profile`: `sevdesk`, or `sevdesk-<profile>` when there are several profiles. */
export function entryName(profile: string, profileCount: number): string {
  return profileCount > 1 ? `sevdesk-${profile}` : 'sevdesk';
}

/**
 * The servers of the client config `path` with the file as read (undefined when there is none yet).
 * Throws when the file cannot be read, is not a JSON object, or its `mcpServers` is not one.
 */
export function readServers(path: string): { file?: JsonFile; servers: Servers } {
  const file = readJsonFile(path);
  const value = file?.json[SERVERS];
  const servers = value === undefined ? {} : value;
  if (!isRecord(servers)) throw new Error(`${SERVERS} in ${path} is not a JSON object`);
  return { file, servers };
}

/** The command line an entry starts (`command` and `args`), or undefined when it has none. */
function commandLine(entry: unknown): string[] | undefined {
  if (!isRecord(entry) || typeof entry.command !== 'string') return undefined;
  const args = entry.args ?? [];
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) {
    return undefined;
  }
  return [entry.command, ...args];
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
 * The names of the entries of `servers` that use `profile`: they start this package (any version)
 * with `--profile <profile>`.
 */
export function entriesUsing(servers: Servers, profile: string): string[] {
  return Object.entries(servers)
    .filter(([, entry]) => {
      const argv = commandLine(entry) ?? [];
      const runsPackage = argv.some(
        (arg) => arg === packageName || arg.startsWith(`${packageName}@`),
      );
      return runsPackage && argv.some((arg, at) => arg === '--profile' && argv[at + 1] === profile);
    })
    .map(([name]) => name);
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
 * Changes the servers of the client config `path` (decision 18): reads the file afresh and passes
 * its servers to `edit`, which returns the new ones, or undefined when the file is no longer as the
 * user was asked about. Then it backs the bytes it read up next to the file and writes the file with
 * every other key as it was. Returns whether it wrote and the backup's path (undefined when there was
 * no file yet). Throws when the file cannot be read, backed up or written; the file is then as it
 * was.
 */
export function rewriteServers(
  path: string,
  edit: (servers: Servers) => Servers | undefined,
): { written: false } | { written: true; backup: string | undefined } {
  const { file, servers } = readServers(path);
  const changed = edit(servers);
  if (changed === undefined) return { written: false };
  const backup = file === undefined ? undefined : backUp(path, file.bytes);
  writeJsonFile(path, { ...file?.json, [SERVERS]: changed });
  return { written: true, backup };
}
