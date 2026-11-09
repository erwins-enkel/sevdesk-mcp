import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

// Runs before every test (vitest `setupFiles`): a fresh temporary home, with every variable the
// local directories derive from pointing into it, so no test reads or writes the user's real
// config or state (foundation decision 7). The XDG and AppData values equal their home-based
// fallbacks, so a spawned server that inherits only HOME (POSIX) or USERPROFILE, APPDATA and
// LOCALAPPDATA (Windows), as the MCP SDK's stdio client passes them, resolves the same paths.
let home: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('XDG_STATE_HOME', join(home, '.local', 'state'));
  vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'));
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'));
});

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});
