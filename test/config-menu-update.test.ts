import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runConfig } from '../src/config-menu.ts';
import type { Locale } from '../src/i18n/index.ts';
import { version } from '../src/manifest.ts';
import { commit, fixture, git, pushUpstream } from './git-fixture.ts';
import { BACK, setup } from './setup-dialogue.ts';

// `config` run from a local checkout: the version and updates rows and the update item, driven
// through the scripted prompter against the real git repositories of test/git-fixture.ts. Nothing
// touches this repository.

// Every test spawns git (and bun) several times, which takes a while on Windows.
vi.setConfig({ testTimeout: 60_000 });

/** Runs `config` for `checkout` in `locale` with `answers` given in turn. */
function config(checkout: string, answers: Parameters<typeof setup>[0], locale: Locale = 'en') {
  return setup(answers, locale, (language, io) => runConfig(language, io, checkout));
}

/** The version row of `checkout` on branch main as the overview shows it. */
function versionRow(checkout: string): string {
  const head = git(checkout, 'rev-parse', '--short', 'HEAD');
  const date = git(checkout, 'log', '-1', '--format=%cI').slice(0, 10);
  return `Version      ${version} (main @ ${head}, ${date})`;
}

test('an up-to-date checkout shows its version and that it is up to date, and offers no update', async () => {
  const { checkout } = fixture();

  const { done, asked, out, err } = await config(checkout, [BACK]);

  expect(done).toBe(true);
  expect(err).toBe('');
  expect(out).toContain('Checking for updates …');
  expect(out).toContain(versionRow(checkout));
  expect(out).toContain('Updates      up to date with origin/main');
  expect(asked[0]?.items?.some((item) => item.startsWith('Update to'))).toBe(false);
});

test('waiting commits are offered first; a yes updates, builds and ends config', async () => {
  const { checkout, other } = fixture();
  const tip = pushUpstream(other, 'feat: one', 'fix: two');
  const short = tip.slice(0, 7);

  const { done, asked, out, successes, err } = await config(checkout, ['Update to', 'y']);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(out).toContain('Updates      2 commits waiting on origin/main');
  expect(asked[0]?.items?.[0]).toBe(`Update to ${short} (2 commits)`);
  expect(out).toContain('2 commits waiting on origin/main, newest first:');
  expect(out).toMatch(/fix: two[\s\S]*feat: one/);
  expect(asked[1]?.question).toBe('Update this checkout and build it? [Y/n] ');
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(tip);
  expect(readFileSync(join(checkout, 'dist', 'built.txt'), 'utf8')).toBe('fix: two');
  expect(successes).toBe(`Updated by 2 commits to ${short} and built.`);
  expect(out).toContain('Run sevdesk-mcp config again to see the new version.');
  // config ended after the update: no menu came again.
  expect(asked).toHaveLength(2);
});

test('a no to the update changes nothing and goes back to the menu', async () => {
  const { checkout, other } = fixture();
  pushUpstream(other, 'feat: one');
  const head = git(checkout, 'rev-parse', 'HEAD');

  const { done, asked, out, err } = await config(checkout, ['Update to', 'n', BACK]);

  expect(err).toBe('');
  expect(done).toBe(true);
  expect(out).toContain('Nothing was changed.');
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(asked).toHaveLength(3);
  expect(asked[2]?.items?.[0]).toContain('Update to');
});

test('commits of its own keep the update from being offered', async () => {
  const { checkout, other } = fixture();
  pushUpstream(other, 'feat: upstream');
  commit(checkout, 'feat: local', { 'local.txt': 'local' });

  const { asked, out } = await config(checkout, [BACK]);

  expect(out).toContain(
    'Updates      1 commit waiting on origin/main, but main has 1 commit of its own; update it by hand',
  );
  expect(asked[0]?.items?.some((item) => item.startsWith('Update to'))).toBe(false);
});

test('uncommitted changes to tracked files keep the update from being offered', async () => {
  const { checkout, other } = fixture();
  pushUpstream(other, 'feat: one');
  writeFileSync(join(checkout, 'VERSION'), 'edited');

  const { asked, out } = await config(checkout, [BACK]);

  expect(out).toContain('1 commit waiting on origin/main, but tracked files have uncommitted');
  expect(asked[0]?.items?.some((item) => item.startsWith('Update to'))).toBe(false);
});

test('a failed fetch shows the updates as unknown, never as up to date', async () => {
  const { checkout, origin } = fixture();
  rmSync(origin, { recursive: true, force: true });

  const { done, asked, out } = await config(checkout, [BACK]);

  expect(done).toBe(true);
  expect(out).toContain(versionRow(checkout));
  expect(out).toMatch(/Updates {6}unknown \(Fetching origin\/main failed/);
  expect(out).not.toContain('up to date');
  expect(asked[0]?.items?.some((item) => item.startsWith('Update to'))).toBe(false);
});

test('the rows speak German in a German locale', async () => {
  const { checkout, other } = fixture();
  pushUpstream(other, 'feat: one');

  const { asked, out } = await config(checkout, [BACK], 'de');

  expect(out).toContain('Suche nach Updates …');
  expect(out).toContain('1 Commit auf origin/main verfügbar');
  expect(asked[0]?.items?.[0]).toMatch(/^Auf [0-9a-f]{7} aktualisieren \(1 Commit\)$/);
});
