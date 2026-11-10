import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

// Real git repositories in a temporary directory for the tests of a local checkout's updates: a bare
// `origin`, the `checkout` the code under test runs on, and an `other` clone that pushes new commits.
// The checkout is a tiny package whose build copies VERSION into dist/built.txt and whose postinstall
// writes installed.txt, so a test sees which steps ran. Nothing touches this repository.

export const PACKAGE = {
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
export function git(dir: string, ...args: string[]): string {
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
export function commit(repo: string, subject: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', subject);
}

export interface Fixture {
  dir: string;
  origin: string;
  checkout: string;
  other: string;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new empty temporary directory, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-version-'));
  fixtures.push(dir);
  return dir;
}

/** A bare origin on `main`, the checkout with one commit pushed to it, and a second clone. */
export function fixture(): Fixture {
  const dir = tempDir();
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
export function pushUpstream(other: string, ...subjects: string[]): string {
  for (const subject of subjects) commit(other, subject, { VERSION: subject });
  git(other, 'push', '--quiet');
  return git(other, 'rev-parse', 'HEAD');
}
