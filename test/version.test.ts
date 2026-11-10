import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { name, version } from '../src/manifest.ts';
import { connect, envelopeOf } from './connect.ts';
import { commit, fixture, git, PACKAGE, pushUpstream, tempDir } from './git-fixture.ts';

// `version` over an in-memory connection against the real git repositories of test/git-fixture.ts:
// a bare `origin`, the `checkout` the server runs from, and an `other` clone that pushes new
// commits. Nothing touches this repository.

// Every test spawns git (and bun) several times, which takes a while on Windows.
vi.setConfig({ testTimeout: 60_000 });

/** Calls `version` on a server for `checkout` and returns the result with its parsed envelope. */
async function callVersion(checkout: string, args: Record<string, string> = {}) {
  const client = await connect({ checkout });
  const result = await client.callTool({ name: 'version', arguments: args });
  await client.close();
  return { isError: result.isError === true, ...envelopeOf(result) } as {
    isError: boolean;
    result?: Record<string, unknown>;
    notes?: string[];
    error?: { kind: string; message: string; hint?: string };
  };
}

/** Calls `version` on `checkout`, as the model does first, and returns the commit it offers. */
async function offeredUpdate(checkout: string): Promise<string> {
  const { result } = await callVersion(checkout);
  return (result?.update as { to: string }).to;
}

test('an up-to-date checkout reports its version, branch and HEAD, and offers no update', async () => {
  const { checkout } = fixture();

  const { isError, result, notes } = await callVersion(checkout);

  expect(isError).toBe(false);
  expect(result).toMatchObject({
    name,
    version,
    checkout,
    branch: 'main',
    commit: git(checkout, 'rev-parse', '--short', 'HEAD'),
    subject: 'chore: start',
    date: git(checkout, 'log', '-1', '--format=%cI'),
    changed: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    incoming: [],
  });
  expect(result).not.toHaveProperty('update');
  expect(notes).toBeUndefined();
});

test('commits waiting upstream are listed newest first and offered as an update', async () => {
  const { checkout, other } = fixture();
  const tip = pushUpstream(other, 'feat: one', 'fix: two');

  const { result, notes } = await callVersion(checkout);

  expect(result).toMatchObject({ ahead: 0, behind: 2, update: { to: tip } });
  expect((result?.incoming as { subject: string }[]).map(({ subject }) => subject)).toEqual([
    'fix: two',
    'feat: one',
  ]);
  expect(notes).toEqual([
    '2 commits are waiting upstream. Ask the user whether to update; only after their yes call version with update set to result.update.to.',
  ]);
  // Only fetched: the checkout itself is where it was.
  expect(readFileSync(join(checkout, 'VERSION'), 'utf8')).toBe('v1');
});

test('uncommitted changes to tracked files keep the update from being offered', async () => {
  const { checkout, other } = fixture();
  pushUpstream(other, 'feat: one');
  writeFileSync(join(checkout, 'VERSION'), 'edited');

  const { result, notes } = await callVersion(checkout);

  expect(result).toMatchObject({ changed: true, behind: 1 });
  expect(result).not.toHaveProperty('update');
  expect(notes?.[0]).toContain('uncommitted changes');
});

test('a branch with commits of its own and upstream commits is not offered an update', async () => {
  const { checkout, other } = fixture();
  pushUpstream(other, 'feat: upstream');
  commit(checkout, 'feat: local', { 'local.txt': 'local' });

  const { result, notes } = await callVersion(checkout);

  expect(result).toMatchObject({ ahead: 1, behind: 1 });
  expect(result).not.toHaveProperty('update');
  expect(notes?.[0]).toContain('cannot be fast-forwarded');
});

test('a failed fetch reports the version but never claims the checkout is up to date', async () => {
  const { checkout, origin } = fixture();
  rmSync(origin, { recursive: true, force: true });

  const { isError, result, notes } = await callVersion(checkout);

  expect(isError).toBe(false);
  expect(result).toMatchObject({ name, version, branch: 'main', upstream: 'origin/main' });
  for (const key of ['ahead', 'behind', 'incoming', 'update'])
    expect(result).not.toHaveProperty(key);
  expect(notes?.[0]).toMatch(/^Fetching origin\/main failed/);
});

test('a branch without an upstream reports its HEAD and says why it cannot compare', async () => {
  const { checkout } = fixture();
  git(checkout, 'checkout', '--quiet', '-b', 'topic');

  const { result, notes } = await callVersion(checkout);

  expect(result).toMatchObject({ branch: 'topic', subject: 'chore: start' });
  expect(result).not.toHaveProperty('behind');
  expect(notes).toEqual([
    'Branch topic has no upstream, so whether commits are waiting is unknown.',
  ]);
});

test('a folder that is no git checkout of its own reports the version and no git state', async () => {
  const dir = tempDir();

  const { isError, result, notes } = await callVersion(dir);

  expect(isError).toBe(false);
  expect(result).toEqual({ name, version, checkout: dir });
  expect(notes?.[0]).toMatch(/^Updates cannot be checked: .* is not the top of a git checkout\.$/);
  expect(existsSync(join(dir, '.git'))).toBe(false);
});

test('an update fast-forwards to the offered commit and builds it, without an install', async () => {
  const { checkout, other } = fixture();
  const from = git(checkout, 'rev-parse', 'HEAD');
  const tip = pushUpstream(other, 'feat: one', 'v3');
  const to = await offeredUpdate(checkout);

  const { isError, result, notes } = await callVersion(checkout, { update: to });

  expect(isError).toBe(false);
  expect(to).toBe(tip);
  expect(result).toEqual({ updated: { from, to, commits: 2 }, installed: false, built: true });
  expect(notes?.[0]).toContain(
    'With --reload in the client entry the next call runs the new build',
  );
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(to);
  expect(readFileSync(join(checkout, 'dist', 'built.txt'), 'utf8')).toBe('v3');
  expect(existsSync(join(checkout, 'installed.txt'))).toBe(false);
});

test('an update whose package.json changed installs before it builds', async () => {
  const { checkout, other } = fixture();
  commit(other, 'build(deps): describe', {
    'package.json': JSON.stringify({ ...PACKAGE, description: 'changed' }, null, 2),
  });
  pushUpstream(other, 'v2');
  const to = await offeredUpdate(checkout);

  const { isError, result } = await callVersion(checkout, { update: to });

  expect(isError).toBe(false);
  expect(result).toMatchObject({ installed: true, built: true });
  expect(readFileSync(join(checkout, 'installed.txt'), 'utf8')).toBe('installed');
  expect(readFileSync(join(checkout, 'dist', 'built.txt'), 'utf8')).toBe('v2');
});

test('an update of a checkout with uncommitted tracked changes is refused and changes nothing', async () => {
  const { checkout, other } = fixture();
  const head = git(checkout, 'rev-parse', 'HEAD');
  const to = pushUpstream(other, 'v2');
  // Fetched first, as version does, so only the uncommitted change stands in the way.
  await callVersion(checkout);
  writeFileSync(join(checkout, 'VERSION'), 'edited');

  const { isError, error } = await callVersion(checkout, { update: to });

  expect(isError).toBe(true);
  expect(error).toMatchObject({ kind: 'update_refused' });
  expect(error?.message).toContain('uncommitted changes');
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(checkout, 'VERSION'), 'utf8')).toBe('edited');
  expect(existsSync(join(checkout, 'dist'))).toBe(false);
});

test('an update to a commit that is not ahead of HEAD on the upstream is refused', async () => {
  const { checkout } = fixture();
  const first = git(checkout, 'rev-parse', 'HEAD');
  commit(checkout, 'feat: second', { VERSION: 'v2' });
  git(checkout, 'push', '--quiet');
  const head = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '--quiet', '-b', 'side', first);
  commit(checkout, 'feat: side', { VERSION: 'side' });
  const side = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '--quiet', 'main');

  for (const [update, reason] of [
    [first, 'is not ahead of HEAD'],
    [side, 'is not ahead of HEAD'],
    ['deadbeefdeadbeef', 'is not a commit in this checkout'],
    ['--upload-pack=touch', 'is not a commit SHA'],
  ] as const) {
    const { isError, error } = await callVersion(checkout, { update });

    expect(isError).toBe(true);
    expect(error?.kind).toBe('update_refused');
    expect(error?.message).toContain(reason);
  }
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(join(checkout, 'dist'))).toBe(false);
});

test('an update to a commit ahead of HEAD but not on the upstream is refused', async () => {
  const { checkout } = fixture();
  const head = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '--quiet', '-b', 'ahead');
  commit(checkout, 'feat: not pushed', { VERSION: 'local' });
  const ahead = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '--quiet', 'main');

  const { error } = await callVersion(checkout, { update: ahead });

  expect(error).toMatchObject({ kind: 'update_refused' });
  expect(error?.message).toContain('is not on origin/main');
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
});

test('an update to HEAD itself changes nothing', async () => {
  const { checkout } = fixture();
  const head = git(checkout, 'rev-parse', 'HEAD');

  const { isError, result, notes } = await callVersion(checkout, { update: head });

  expect(isError).toBe(false);
  expect(result).toEqual({
    updated: { from: head, to: head, commits: 0 },
    installed: false,
    built: false,
  });
  expect(notes).toEqual([`Already at ${head}: nothing changed.`]);
  expect(existsSync(join(checkout, 'dist'))).toBe(false);
});

test('a failing build is reported with the commit the checkout is now at', async () => {
  const { checkout, other } = fixture();
  commit(other, 'fix: break the build', { 'build.mjs': 'process.exit(1);\n' });
  pushUpstream(other, 'v2');
  const to = await offeredUpdate(checkout);

  const { isError, error } = await callVersion(checkout, { update: to });

  expect(isError).toBe(true);
  expect(error?.kind).toBe('update_failed');
  expect(error?.message).toContain(`fast-forwarded to ${to}, but bun run build failed`);
  expect(error?.hint).toBe(`Run bun install && bun run build in ${checkout}.`);
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(to);
});

test('version stays lean and is not annotated read-only or destructive', async () => {
  const client = await connect({ checkout: tmpdir() });
  const { tools } = await client.listTools();
  await client.close();

  const tool = tools.find((item) => item.name === 'version');
  expect(tool?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
  const chars =
    'version'.length + (tool?.description ?? '').length + JSON.stringify(tool?.inputSchema).length;
  expect(chars).toBeLessThan(600);
});
