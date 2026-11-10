import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { name, version } from '../src/manifest.ts';
import { connect, envelopeOf } from './connect.ts';

// `version` over an in-memory connection against real git repositories in a temporary directory:
// a bare `origin`, the `checkout` the server runs from, and an `other` clone that pushes new
// commits. The checkout is a tiny package whose build copies VERSION into dist/built.txt and whose
// postinstall writes installed.txt, so a test sees which steps ran. Nothing touches this repository.

// Every test spawns git (and bun) several times, which takes a while on Windows.
vi.setConfig({ testTimeout: 60_000 });

const PACKAGE = {
  name: 'fixture',
  private: true,
  scripts: { build: 'node build.mjs', postinstall: 'node installed.mjs' },
};

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(PACKAGE, null, 2),
  'build.mjs': `import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
copyFileSync('VERSION', 'dist/built.txt');
`,
  'installed.mjs': `import { writeFileSync } from 'node:fs';
writeFileSync('installed.txt', 'installed');
`,
  '.gitignore': 'node_modules/\ndist/\ninstalled.txt\n',
  VERSION: 'v1',
};

/** The test's environment without inherited GIT_* variables, which a git hook may set. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
}

/** Runs git in `dir` with a fixed identity and plain settings; resolves to its trimmed stdout. */
function git(dir: string, ...args: string[]): string {
  const config = [
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ].flatMap(([key, value]) => ['-c', `${String(key)}=${String(value)}`]);
  return execFileSync('git', [...config, ...args], {
    cwd: dir,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Writes `files` into `repo` and commits them as `subject`. */
function commit(repo: string, subject: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', subject);
}

interface Fixture {
  dir: string;
  origin: string;
  checkout: string;
  other: string;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bare origin on `main`, the checkout with one commit pushed to it, and a second clone. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-version-'));
  fixtures.push(dir);
  const origin = join(dir, 'origin.git');
  const checkout = join(dir, 'checkout');
  const other = join(dir, 'other');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'init', '--quiet', '-b', 'main', checkout);
  commit(checkout, 'chore: start', FILES);
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '--quiet', '-u', 'origin', 'main');
  git(dir, 'clone', '--quiet', origin, other);
  return { dir, origin, checkout, other };
}

/** Commits `subjects` in `other`, each changing VERSION to the subject, and pushes them. */
function pushUpstream(other: string, ...subjects: string[]): string {
  for (const subject of subjects) commit(other, subject, { VERSION: subject });
  git(other, 'push', '--quiet');
  return git(other, 'rev-parse', 'HEAD');
}

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
  const dir = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-version-'));
  fixtures.push(dir);

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
