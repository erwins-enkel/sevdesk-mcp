import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { type CallToolResult, fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { errorResult, plainResult } from './envelope.ts';
import { name, version } from './manifest.ts';
import type { SnippetError } from './sandbox.ts';

// `version`, the tool of a server that runs from a local checkout (decision 18, addendum on
// `version`): this server's version and the checkout's git state, with the commits waiting
// upstream, and, after the user's yes, the update to them. The published package never registers
// it, so it keeps its two tools.

/** For git and `bun --version`. */
const QUICK_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 120_000;
/** The most incoming commits a state lists, newest first. */
const INCOMING_LIMIT = 20;
/** The most output a command may write before it is stopped. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** How much of a failed step's output, from its end, an error carries. */
const OUTPUT_TAIL_CHARS = 2_000;
/** A commit SHA, abbreviated or full; nothing else reaches git as `update`. */
const SHA = /^[0-9a-f]{7,64}$/i;

const description =
  "This server's version and its local checkout's git state, with the commits waiting upstream (fetched now). When some are, result.update.to offers them: ask the user, and only after their yes call version again with update set to it. That fast-forwards the checkout to exactly that commit, runs bun install if dependencies changed, and builds.";

const RESTART_NOTE =
  'With --reload in the client entry the next call runs the new build; without it, restart the client. New tool names, input schemas, descriptions or instructions, and changes to src/reload.ts or src/cli.ts, need a client restart either way.';

/** What became of a command: whether it exited with 0, its exit code, stdout, and all it said. */
interface Ran {
  ok: boolean;
  /** The exit code; undefined when the command did not start or was stopped. */
  code?: number;
  /** Whether the command was not found. */
  missing: boolean;
  stdout: string;
  /** stdout and stderr together, and why the command did not start or finish. */
  output: string;
}

/**
 * The environment of every command: the server's own, without inherited `GIT_*` variables (a git
 * hook's `GIT_DIR` would point git at another repository), with git never prompting for
 * credentials and speaking English, and with the running Node's directory first on the PATH, since
 * GUI clients often start the server with a bare PATH.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  // Windows spells it `Path`; a second `PATH` key would make the lookup ambiguous.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter);
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

/**
 * Runs `command` with `args` in `cwd` without a shell, collecting its output (nothing reaches this
 * server's stdout, which belongs to MCP), and stops it after `timeout` milliseconds.
 */
function run(command: string, args: string[], cwd: string, timeout: number): Promise<Ran> {
  const options = { cwd, env: childEnv(), timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true };
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const said = `${stdout}${stderr}`.trim();
      if (error === null) {
        resolve({ ok: true, code: 0, missing: false, stdout, output: said });
        return;
      }
      const code = typeof error.code === 'number' ? error.code : undefined;
      let why: string | undefined;
      if (error.killed === true) why = `stopped after ${String(timeout / 1000)} s`;
      else if (code === undefined) why = error.message;
      const output = [said, why].filter(Boolean).join('\n');
      resolve({ ok: false, code, missing: error.code === 'ENOENT', stdout, output });
    });
  });
}

const git = (checkout: string, ...args: string[]) => run('git', args, checkout, QUICK_TIMEOUT_MS);

/** A commit as a state shows it: the short SHA, the committer date (ISO 8601) and the subject. */
interface Commit {
  commit: string;
  date: string;
  subject: string;
}

/** The `git log` format `commitsOf()` reads. */
const COMMIT_FORMAT = '--format=%h%x00%cI%x00%s';

/** The commits of `git log` output in `COMMIT_FORMAT`, in its order. */
function commitsOf(stdout: string): Commit[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [commit = '', date = '', subject = ''] = line.split('\0');
      return { commit, date, subject };
    });
}

/** The checkout's own repository: HEAD, its branch and upstream, and uncommitted tracked changes. */
interface Repo {
  /** HEAD's full SHA. */
  sha: string;
  head: Commit;
  /** Undefined when HEAD is detached. */
  branch?: string;
  /** The branch's upstream, e.g. `origin/main`; undefined when it has none. */
  upstream?: string;
  changed: boolean;
}

/** Why `checkout` is not the top of a git checkout of its own (or git is missing), if it is not. */
async function notOwnCheckout(checkout: string): Promise<string | undefined> {
  const top = await git(checkout, 'rev-parse', '--show-cdup');
  if (top.missing) return 'git was not found on the PATH this server got';
  // A folder inside another repository is not a checkout of its own.
  if (!top.ok || top.stdout.trim() !== '') return `${checkout} is not the top of a git checkout`;
  return undefined;
}

/** HEAD's branch and that branch's upstream, each undefined when there is none. */
async function branchOf(checkout: string): Promise<{ branch?: string; upstream?: string }> {
  const branch = await git(checkout, 'symbolic-ref', '--short', '-q', 'HEAD');
  if (!branch.ok) return {};
  const upstream = await git(checkout, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  return {
    branch: branch.stdout.trim(),
    upstream: upstream.ok ? upstream.stdout.trim() : undefined,
  };
}

/** The repository of `checkout`, or why there is none (`notOwnCheckout()`, an unreadable state). */
async function repoOf(
  checkout: string,
): Promise<{ ok: true; repo: Repo } | { ok: false; reason: string }> {
  const notOwn = await notOwnCheckout(checkout);
  if (notOwn !== undefined) return { ok: false, reason: notOwn };
  const log = await git(checkout, 'log', '-1', '--format=%H%x00%h%x00%cI%x00%s');
  const status = await git(checkout, 'status', '--porcelain', '--untracked-files=no');
  const failed = [log, status].find((ran) => !ran.ok);
  if (failed !== undefined) {
    return { ok: false, reason: `its state cannot be read: ${failed.output}` };
  }
  const [sha = '', commit = '', date = '', subject = ''] = log.stdout.trim().split('\0');
  const head = { commit, date, subject };
  const changed = status.stdout.trim() !== '';
  return { ok: true, repo: { sha, head, ...(await branchOf(checkout)), changed } };
}

/** Why `repo` cannot be compared with an upstream: its HEAD is detached, or its branch has none. */
function uncomparable({ branch }: Repo): string {
  return branch === undefined
    ? 'HEAD is detached, so there is no branch to update.'
    : `Branch ${branch} has no upstream, so whether commits are waiting is unknown.`;
}

/** How HEAD and its upstream compare after a fetch: the counts, the newest incoming, the tip. */
interface Comparison {
  ahead: number;
  behind: number;
  incoming: Commit[];
  /** The upstream tip's full SHA. */
  tip: string;
}

/** Fetches the upstream of `checkout` and compares HEAD with it, or says why it cannot. */
async function compare(
  checkout: string,
  upstream: string,
): Promise<{ ok: true; comparison: Comparison } | { ok: false; reason: string }> {
  const fetched = await git(checkout, 'fetch', '--quiet');
  if (!fetched.ok) {
    return {
      ok: false,
      reason: `Fetching ${upstream} failed, so whether commits are waiting is unknown: ${fetched.output}`,
    };
  }
  const counts = await git(checkout, 'rev-list', '--left-right', '--count', 'HEAD...@{u}');
  const log = await git(
    checkout,
    'log',
    COMMIT_FORMAT,
    `-n${String(INCOMING_LIMIT)}`,
    'HEAD..@{u}',
  );
  const tip = await git(checkout, 'rev-parse', '@{u}');
  const failed = [counts, log, tip].find((ran) => !ran.ok);
  if (failed !== undefined) {
    return { ok: false, reason: `Comparing HEAD with ${upstream} failed: ${failed.output}` };
  }
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(Number);
  return {
    ok: true,
    comparison: { ahead, behind, incoming: commitsOf(log.stdout), tip: tip.stdout.trim() },
  };
}

/** The notes on a comparison: a cut list of incoming commits, and why an update is offered or not. */
function comparisonNotes(repo: Repo, { ahead, behind, incoming }: Comparison): string[] {
  const notes: string[] = [];
  if (behind > incoming.length) {
    notes.push(
      `Only the newest ${String(incoming.length)} of ${String(behind)} incoming commits are listed.`,
    );
  }
  if (behind === 0) return notes;
  const waiting = `${String(behind)} commit${behind === 1 ? ' is' : 's are'} waiting upstream`;
  if (ahead > 0) {
    notes.push(
      `${waiting}, but ${repo.branch ?? 'HEAD'} also has ${String(ahead)} commit${ahead === 1 ? '' : 's'} of its own, so it cannot be fast-forwarded; update it by hand.`,
    );
  } else if (repo.changed) {
    notes.push(
      `${waiting}, but tracked files have uncommitted changes; they have to be committed or discarded before an update.`,
    );
  } else {
    notes.push(
      `${waiting}. Ask the user whether to update; only after their yes call version with update set to result.update.to.`,
    );
  }
  return notes;
}

/**
 * The state `version` reports: name and version, the checkout's branch, HEAD and uncommitted
 * tracked changes, and after a fetch how it compares with its upstream. `update.to` is offered only
 * when commits are waiting, the branch has none of its own and nothing tracked is changed. Whatever
 * cannot be checked is said in the notes, never reported as up to date.
 */
async function stateOf(checkout: string): Promise<CallToolResult> {
  const about = { name, version, checkout };
  const found = await repoOf(checkout);
  if (!found.ok) return plainResult(about, [`Updates cannot be checked: ${found.reason}.`]);
  const { repo } = found;
  const state = {
    ...about,
    branch: repo.branch,
    ...repo.head,
    changed: repo.changed,
    upstream: repo.upstream,
  };
  if (repo.branch === undefined || repo.upstream === undefined) {
    return plainResult(state, [uncomparable(repo)]);
  }
  const compared = await compare(checkout, repo.upstream);
  if (!compared.ok) return plainResult(state, [compared.reason]);
  const { ahead, behind, incoming, tip } = compared.comparison;
  const offer = behind > 0 && ahead === 0 && !repo.changed;
  return plainResult(
    { ...state, ahead, behind, incoming, ...(offer ? { update: { to: tip } } : {}) },
    comparisonNotes(repo, compared.comparison),
  );
}

/** What an update does: fast-forward HEAD (`from`) to `to`, `commits` commits ahead. */
interface UpdatePlan {
  from: string;
  to: string;
  commits: number;
}

/** Why `repo` cannot be updated: no branch or no upstream, or uncommitted tracked changes. */
function blocker(repo: Repo): string | undefined {
  if (repo.branch === undefined || repo.upstream === undefined) return uncomparable(repo);
  return repo.changed
    ? 'tracked files have uncommitted changes; commit or discard them first.'
    : undefined;
}

/** Why HEAD cannot be fast-forwarded to `to`: it is not ahead of HEAD, or not on the upstream. */
async function offTrack(
  checkout: string,
  { sha, upstream }: Repo,
  to: string,
): Promise<string | undefined> {
  if (!(await git(checkout, 'merge-base', '--is-ancestor', 'HEAD', to)).ok) {
    return `${to} is not ahead of HEAD (${sha}).`;
  }
  if (!(await git(checkout, 'merge-base', '--is-ancestor', to, '@{u}')).ok) {
    return `${to} is not on ${upstream ?? 'the upstream'}.`;
  }
  return undefined;
}

/**
 * Checks that `checkout` may be fast-forwarded to `requested`: a commit SHA, on a branch with an
 * upstream and without uncommitted tracked changes, ahead of HEAD (or HEAD itself) and on the
 * upstream as last fetched (no new fetch, so the update does exactly what was offered). Resolves to
 * the plan, or to why the update is refused.
 */
async function planUpdate(checkout: string, requested: string): Promise<UpdatePlan | string> {
  if (!SHA.test(requested)) {
    return `${JSON.stringify(requested)} is not a commit SHA; pass result.update.to of a version call.`;
  }
  const found = await repoOf(checkout);
  if (!found.ok) return `${found.reason}.`;
  const { repo } = found;
  const blocked = blocker(repo);
  if (blocked !== undefined) return blocked;
  const resolved = await git(checkout, 'rev-parse', '--verify', '--quiet', `${requested}^{commit}`);
  if (!resolved.ok) return `${requested} is not a commit in this checkout; call version again.`;
  const to = resolved.stdout.trim();
  if (to === repo.sha) return { from: to, to, commits: 0 };
  const off = await offTrack(checkout, repo, to);
  if (off !== undefined) return off;
  const count = await git(checkout, 'rev-list', '--count', `HEAD..${to}`);
  if (!count.ok) return `counting the commits up to ${to} failed: ${count.output}`;
  return { from: repo.sha, to, commits: Number(count.stdout.trim()) };
}

/** An update refused before anything changed. */
function refused(reason: string, hint?: string): CallToolResult {
  const error: SnippetError = { kind: 'update_refused', message: `Nothing was changed: ${reason}` };
  return errorResult(hint === undefined ? error : { ...error, hint });
}

/** An update whose `step` failed after the checkout was fast-forwarded to `to`. */
function failed(step: string, to: string, checkout: string, ran: Ran): CallToolResult {
  return errorResult({
    kind: 'update_failed',
    message: `The checkout was fast-forwarded to ${to}, but ${step} failed, so the build in dist/ may be old or incomplete: ${ran.output.slice(-OUTPUT_TAIL_CHARS)}`,
    hint: `Run bun install && bun run build in ${checkout}.`,
  });
}

/** The bun to install and build with: on the PATH, else bun's own install folder; or undefined. */
async function findBun(checkout: string): Promise<string | undefined> {
  if ((await run('bun', ['--version'], checkout, QUICK_TIMEOUT_MS)).ok) return 'bun';
  const installed = join(
    homedir(),
    '.bun',
    'bin',
    process.platform === 'win32' ? 'bun.exe' : 'bun',
  );
  return existsSync(installed) ? installed : undefined;
}

/**
 * Fast-forwards `checkout` along `plan`, then runs `bun install --frozen-lockfile` when `install`
 * (package.json or bun.lock changed) and `bun run build`. A step that fails after the fast-forward
 * is reported with the state it left; nothing is rolled back.
 */
async function applyUpdate(
  checkout: string,
  { from, to, commits }: UpdatePlan,
  bun: string,
  install: boolean,
): Promise<CallToolResult> {
  const merged = await git(checkout, 'merge', '--ff-only', '--quiet', to);
  if (!merged.ok) return refused(`git could not fast-forward to ${to}: ${merged.output}`);
  if (install) {
    const installed = await run(
      bun,
      ['install', '--frozen-lockfile'],
      checkout,
      INSTALL_TIMEOUT_MS,
    );
    if (!installed.ok) return failed('bun install --frozen-lockfile', to, checkout, installed);
  }
  const built = await run(bun, ['run', 'build'], checkout, BUILD_TIMEOUT_MS);
  if (!built.ok) return failed('bun run build', to, checkout, built);
  return plainResult({ updated: { from, to, commits }, installed: install, built: true }, [
    RESTART_NOTE,
  ]);
}

/**
 * Updates `checkout` to `requested` once `planUpdate()` allows it. Every check, bun included, runs
 * before the fast-forward (`applyUpdate()`), so a refusal changes nothing.
 */
async function updateTo(checkout: string, requested: string): Promise<CallToolResult> {
  const plan = await planUpdate(checkout, requested);
  if (typeof plan === 'string') return refused(plan);
  if (plan.commits === 0) {
    return plainResult({ updated: plan, installed: false, built: false }, [
      `Already at ${plan.to}: nothing changed.`,
    ]);
  }
  const lock = await git(
    checkout,
    'diff',
    '--quiet',
    plan.from,
    plan.to,
    '--',
    'package.json',
    'bun.lock',
  );
  // `git diff --quiet` exits with 1 when they differ; anything else but 0 is a failure.
  if (lock.code !== 0 && lock.code !== 1) {
    return refused(`comparing package.json and bun.lock failed: ${lock.output}`);
  }
  const bun = await findBun(checkout);
  if (bun === undefined) {
    return refused(
      'bun was found neither on the PATH this server got nor in ~/.bun/bin.',
      `Run git merge --ff-only ${plan.to}, bun install and bun run build in ${checkout}.`,
    );
  }
  return applyUpdate(checkout, plan, bun, lock.code === 1);
}

/**
 * Registers `version` for the local checkout `checkout`, the package root this server runs from
 * (decision 18): without `update` it reports this server's version and the checkout's state and
 * offers the commits waiting upstream; with `update`, the offered commit, it updates the checkout
 * to it and builds.
 */
export function registerVersionTool(server: McpServer, checkout: string): void {
  server.registerTool(
    'version',
    {
      description,
      inputSchema: fromJsonSchema<{ update?: string }>({
        type: 'object',
        properties: {
          update: {
            type: 'string',
            description: 'result.update.to of an earlier call: the commit to update to.',
          },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ update }) => (update === undefined ? stateOf(checkout) : updateTo(checkout, update)),
  );
}
