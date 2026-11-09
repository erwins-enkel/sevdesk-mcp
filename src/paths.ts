import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

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
    const roaming = absolute(process.env.APPDATA, win32) ?? win32.join(home, 'AppData', 'Roaming');
    const local = absolute(process.env.LOCALAPPDATA, win32) ?? win32.join(home, 'AppData', 'Local');
    return { config: win32.join(roaming, APP), state: win32.join(local, APP) };
  }
  const config = absolute(process.env.XDG_CONFIG_HOME, posix) ?? posix.join(home, '.config');
  const state = absolute(process.env.XDG_STATE_HOME, posix) ?? posix.join(home, '.local', 'state');
  return { config: posix.join(config, APP), state: posix.join(state, APP) };
}
