import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { fakeKeychain } from './fake-keychain.ts';

// The OS keychain library is replaced by an in-memory fake in every test file, so no test reaches
// the real keychain (foundation decision 7). Spawned servers are not covered: they must never read
// a keychain token.
vi.mock('@napi-rs/keyring', () => import('./fake-keychain.ts'));

// Runs before every test (vitest `setupFiles`): a fresh temporary home, with every variable the
// local directories derive from pointing into it, so no test reads or writes the user's real
// config, state or Downloads folder (foundation decision 7). The XDG and AppData values equal
// their home-based fallbacks, so a spawned server that inherits only HOME (POSIX) or USERPROFILE,
// APPDATA and LOCALAPPDATA (Windows), as the MCP SDK's stdio client passes them, resolves the
// same paths.
// A sevDesk token and read-only switch from the developer's shell are unset, and the fake keychain
// starts empty.
let home: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('XDG_STATE_HOME', join(home, '.local', 'state'));
  vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'));
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'));
  vi.stubEnv('SEVDESK_API_TOKEN', undefined);
  vi.stubEnv('SEVDESK_PROFILE', undefined);
  vi.stubEnv('SEVDESK_READONLY', undefined);
  fakeKeychain.tokens.clear();
  fakeKeychain.accesses.length = 0;
  fakeKeychain.unavailable = false;
});

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});
