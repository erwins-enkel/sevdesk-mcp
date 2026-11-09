import { homedir, tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { localDirs } from '../src/paths.ts';

const unset = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA'] as const;

/** Clears every variable the directories derive from, then sets `env`. */
function stubEnv(env: Partial<Record<(typeof unset)[number], string>> = {}): void {
  for (const name of unset) vi.stubEnv(name, env[name]);
}

test('Linux uses ~/.config and ~/.local/state without XDG variables', () => {
  stubEnv();

  expect(localDirs('linux', '/home/kai')).toEqual({
    config: '/home/kai/.config/sevdesk-mcp',
    state: '/home/kai/.local/state/sevdesk-mcp',
  });
});

test('Linux honours absolute XDG_CONFIG_HOME and XDG_STATE_HOME', () => {
  stubEnv({ XDG_CONFIG_HOME: '/srv/config', XDG_STATE_HOME: '/srv/state' });

  expect(localDirs('linux', '/home/kai')).toEqual({
    config: '/srv/config/sevdesk-mcp',
    state: '/srv/state/sevdesk-mcp',
  });
});

test('Linux ignores empty and relative XDG values, as the XDG spec requires', () => {
  stubEnv({ XDG_CONFIG_HOME: 'relative/config', XDG_STATE_HOME: '' });

  expect(localDirs('linux', '/home/kai')).toEqual({
    config: '/home/kai/.config/sevdesk-mcp',
    state: '/home/kai/.local/state/sevdesk-mcp',
  });
});

test('other Unix systems follow XDG like Linux', () => {
  stubEnv({ XDG_CONFIG_HOME: '/usr/home/kai/cfg' });

  expect(localDirs('freebsd', '/usr/home/kai')).toEqual({
    config: '/usr/home/kai/cfg/sevdesk-mcp',
    state: '/usr/home/kai/.local/state/sevdesk-mcp',
  });
});

test('macOS uses Application Support for config and state and ignores XDG', () => {
  stubEnv({ XDG_CONFIG_HOME: '/Users/kai/.config', XDG_STATE_HOME: '/Users/kai/.state' });

  expect(localDirs('darwin', '/Users/kai')).toEqual({
    config: '/Users/kai/Library/Application Support/sevdesk-mcp',
    state: '/Users/kai/Library/Application Support/sevdesk-mcp',
  });
});

test('Windows uses APPDATA for config and LOCALAPPDATA for state', () => {
  stubEnv({ APPDATA: 'D:\\Profiles\\kai\\Roaming', LOCALAPPDATA: 'D:\\Profiles\\kai\\Local' });

  expect(localDirs('win32', 'C:\\Users\\kai')).toEqual({
    config: 'D:\\Profiles\\kai\\Roaming\\sevdesk-mcp',
    state: 'D:\\Profiles\\kai\\Local\\sevdesk-mcp',
  });
});

test('Windows falls back to AppData under the profile when the variables are unset or relative', () => {
  stubEnv({ APPDATA: 'Roaming', XDG_CONFIG_HOME: '/home/kai/.config' });

  expect(localDirs('win32', 'C:\\Users\\kai')).toEqual({
    config: 'C:\\Users\\kai\\AppData\\Roaming\\sevdesk-mcp',
    state: 'C:\\Users\\kai\\AppData\\Local\\sevdesk-mcp',
  });
});

// Two tests in a row: each must get its own temporary directories, never the user's real ones.
const seen: string[] = [];
for (const run of [1, 2]) {
  test(`in tests the local directories lie in a fresh temporary home (${String(run)})`, () => {
    const { config, state } = localDirs();

    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(config.startsWith(homedir())).toBe(true);
    expect(state.startsWith(homedir())).toBe(true);
    expect(seen).not.toContain(homedir());
    seen.push(homedir());
  });
}
