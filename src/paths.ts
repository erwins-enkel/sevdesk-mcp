import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** The local directories (decision 13), each already ending in the app's own folder. */
export interface LocalDirs {
  /** Holds the config file. */
  config: string;
  /** Data and state: for the audit log and the update-check cache. */
  state: string;
}

const APP = 'sevdesk-mcp';

/**
 * A directory from an environment variable, or undefined when it is unset, empty or relative: the
 * XDG spec says to ignore a relative value, and the same rule applies on Windows.
 */
function absolute(value: string | undefined, path: typeof posix): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

/** Unix: the XDG config home, `XDG_CONFIG_HOME` or `~/.config`. */
function xdgConfigHome(home: string): string {
  return absolute(process.env.XDG_CONFIG_HOME, posix) ?? posix.join(home, '.config');
}

/** Windows: the roaming application data folder, `APPDATA` or `AppData\Roaming` in the profile. */
function roamingAppData(home: string): string {
  return absolute(process.env.APPDATA, win32) ?? win32.join(home, 'AppData', 'Roaming');
}

/** Windows: the local application data folder, `LOCALAPPDATA` or `AppData\Local` in the profile. */
function localAppData(home: string): string {
  return absolute(process.env.LOCALAPPDATA, win32) ?? win32.join(home, 'AppData', 'Local');
}

/**
 * Where local files live on `platform` (decision 13): XDG on Linux and other Unix systems,
 * `~/Library/Application Support` on macOS (both directories), and the roaming (config) and local
 * (state) application data folders on Windows. Tests redirect these through the environment and
 * the home directory (`test/setup.ts`).
 */
export function localDirs(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): LocalDirs {
  if (platform === 'darwin') {
    const dir = posix.join(home, 'Library', 'Application Support', APP);
    return { config: dir, state: dir };
  }
  if (platform === 'win32') {
    return {
      config: win32.join(roamingAppData(home), APP),
      state: win32.join(localAppData(home), APP),
    };
  }
  const state = absolute(process.env.XDG_STATE_HOME, posix) ?? posix.join(home, '.local', 'state');
  return { config: posix.join(xdgConfigHome(home), APP), state: posix.join(state, APP) };
}

// Where the packaged (MSIX) Claude Desktop, which its current Windows installers set up, keeps its
// virtualised copy of AppData\Roaming; it reads its config there, not in the real folder.
const CLAUDE_MSIX_ROAMING = ['Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming'];

/**
 * The directories where Claude Desktop keeps `claude_desktop_config.json` on `platform`, the one it
 * reads listed first: `~/Library/Application Support/Claude` on macOS; on Windows the packaged
 * app's virtualised roaming folder, then `%APPDATA%\Claude` of older installs; the XDG config home
 * on Linux (Electron's `appData`).
 */
export function claudeDesktopDirs(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string[] {
  if (platform === 'darwin') return [posix.join(home, 'Library', 'Application Support', 'Claude')];
  if (platform === 'win32') {
    return [
      win32.join(localAppData(home), ...CLAUDE_MSIX_ROAMING, 'Claude'),
      win32.join(roamingAppData(home), 'Claude'),
    ];
  }
  return [posix.join(xdgConfigHome(home), 'Claude')];
}

/**
 * A client's directory from the environment variable value `dir`: `fallback` when it is unset or
 * empty, the value when it is absolute, and undefined when it is relative: the client would resolve
 * it against whatever directory it starts in, so the directory cannot be known.
 */
function clientDir(
  dir: string | undefined,
  path: typeof posix,
  fallback: string,
): string | undefined {
  if (dir === undefined || dir === '') return fallback;
  return path.isAbsolute(dir) ? dir : undefined;
}

/** The path functions of `platform`. */
function pathOf(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Claude Code's global config file, which holds its user-scope MCP servers: `.claude.json` in
 * `CLAUDE_CONFIG_DIR` when that is set, else in the home directory. Undefined when
 * `CLAUDE_CONFIG_DIR` is relative.
 */
export function claudeCodeFile(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string | undefined {
  const path = pathOf(platform);
  const dir = clientDir(process.env.CLAUDE_CONFIG_DIR, path, home);
  return dir === undefined ? undefined : path.join(dir, '.claude.json');
}

/**
 * The Codex home, whose `config.toml` ChatGPT Desktop and the Codex CLI share: `CODEX_HOME` when
 * that is set, else `~/.codex` (on Windows in the user profile). Undefined when `CODEX_HOME` is
 * relative.
 */
export function codexHome(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string | undefined {
  const path = pathOf(platform);
  return clientDir(process.env.CODEX_HOME, path, path.join(home, '.codex'));
}

/**
 * OpenCode's global config directory: `opencode` in `XDG_CONFIG_HOME`, else in `~/.config`, on
 * every platform (OpenCode follows XDG on macOS and Windows too). Undefined when `XDG_CONFIG_HOME`
 * is relative, which OpenCode, unlike the XDG spec, does not ignore.
 */
export function openCodeDir(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string | undefined {
  const path = pathOf(platform);
  const config = clientDir(process.env.XDG_CONFIG_HOME, path, path.join(home, '.config'));
  return config === undefined ? undefined : path.join(config, 'opencode');
}

/**
 * The default download directory of `profile` (decision 14): `~/Downloads/sevdesk/<profile>`, where
 * `savePdf` and the non-JSON responses of `sevdesk.request` land unless the profile configures its
 * own `downloadDir`. Tests redirect the home directory (`test/setup.ts`).
 */
export function defaultDownloadDir(profile: string, home = homedir()): string {
  return join(home, 'Downloads', 'sevdesk', profile);
}
