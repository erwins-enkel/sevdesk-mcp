import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { claudeCodeFile, claudeDesktopDirs, defaultDownloadDir, localDirs } from '../src/paths.ts';

const unset = [
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'CLAUDE_CONFIG_DIR',
] as const;

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

test('Claude Desktop keeps its config in Application Support on macOS', () => {
  stubEnv({ XDG_CONFIG_HOME: '/Users/kai/.config' });

  expect(claudeDesktopDirs('darwin', '/Users/kai')).toEqual([
    '/Users/kai/Library/Application Support/Claude',
  ]);
});

test("Claude Desktop on Windows: the packaged app's virtualised folder first, then APPDATA", () => {
  stubEnv({ APPDATA: 'D:\\Profiles\\kai\\Roaming', LOCALAPPDATA: 'D:\\Profiles\\kai\\Local' });

  expect(claudeDesktopDirs('win32', 'C:\\Users\\kai')).toEqual([
    'D:\\Profiles\\kai\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude',
    'D:\\Profiles\\kai\\Roaming\\Claude',
  ]);
});

test('Claude Desktop on Windows falls back to AppData under the profile', () => {
  stubEnv({ APPDATA: 'Roaming' });

  expect(claudeDesktopDirs('win32', 'C:\\Users\\kai')).toEqual([
    'C:\\Users\\kai\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude',
    'C:\\Users\\kai\\AppData\\Roaming\\Claude',
  ]);
});

test('Claude Desktop on Linux lives in the XDG config home', () => {
  stubEnv();
  expect(claudeDesktopDirs('linux', '/home/kai')).toEqual(['/home/kai/.config/Claude']);

  stubEnv({ XDG_CONFIG_HOME: '/srv/config' });
  expect(claudeDesktopDirs('linux', '/home/kai')).toEqual(['/srv/config/Claude']);
});

test('Claude Code keeps its config in ~/.claude.json without CLAUDE_CONFIG_DIR', () => {
  stubEnv();
  expect(claudeCodeFile('linux', '/home/kai')).toBe('/home/kai/.claude.json');
  expect(claudeCodeFile('darwin', '/Users/kai')).toBe('/Users/kai/.claude.json');
  expect(claudeCodeFile('win32', 'C:\\Users\\kai')).toBe('C:\\Users\\kai\\.claude.json');

  stubEnv({ CLAUDE_CONFIG_DIR: '' });
  expect(claudeCodeFile('linux', '/home/kai')).toBe('/home/kai/.claude.json');
});

test('Claude Code keeps its config in CLAUDE_CONFIG_DIR when set, and cannot be found when it is relative', () => {
  stubEnv({ CLAUDE_CONFIG_DIR: '/home/kai/.claude-work' });
  expect(claudeCodeFile('linux', '/home/kai')).toBe('/home/kai/.claude-work/.claude.json');

  stubEnv({ CLAUDE_CONFIG_DIR: 'D:\\claude' });
  expect(claudeCodeFile('win32', 'C:\\Users\\kai')).toBe('D:\\claude\\.claude.json');

  stubEnv({ CLAUDE_CONFIG_DIR: '.claude-work' });
  expect(claudeCodeFile('linux', '/home/kai')).toBeUndefined();
});

test('a profile downloads into ~/Downloads/sevdesk/<profile>, inside the temporary home in tests', () => {
  expect(defaultDownloadDir('mcp-test', join('home', 'kai'))).toBe(
    join('home', 'kai', 'Downloads', 'sevdesk', 'mcp-test'),
  );
  expect(defaultDownloadDir('env')).toBe(join(homedir(), 'Downloads', 'sevdesk', 'env'));
  expect(homedir().startsWith(tmpdir())).toBe(true);
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
