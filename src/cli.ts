#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { launchKind } from './clients.ts';
import { runConfig } from './config-menu.ts';
import { isProfileName } from './config.ts';
import { type MessageKey, resolveLocale, t } from './i18n/index.ts';
import { root, version } from './manifest.ts';
import { createPrompter } from './prompt.ts';
import { serveWithReload } from './reload.ts';
import { createServer } from './server.ts';
import { runList, runRemove, runSetup, type SetupIO, type SetupOutput } from './setup.ts';
import { createOutput } from './terminal.ts';

// The exit-code contract (POSIX convention). The usage text documents it from these values.
const exitCodes = { success: 0, failure: 1, usage: 2 } as const;

const locale = resolveLocale();
const [command, ...rest] = process.argv.slice(2);
const usage = t(locale, 'cli.usage', {
  success: String(exitCodes.success),
  failure: String(exitCodes.failure),
  usage: String(exitCodes.usage),
});

/** Reports a wrong invocation on stderr, followed by the usage, and sets the usage exit code. */
function usageError(message: string): void {
  console.error(message);
  console.error(usage);
  process.exitCode = exitCodes.usage;
}

/** Reports `argument`, which the command does not take, as an unknown option or argument. */
function strayArgument(argument: string): void {
  usageError(
    argument.startsWith('-')
      ? t(locale, 'cli.unknownOption', { option: argument })
      : t(locale, 'cli.unexpectedArgument', { argument }),
  );
}

/** How the server is served: pinned to a profile (`--profile <name>`), and with `--reload`. */
interface ServeOptions {
  profile?: string;
  reload: boolean;
}

/**
 * Serves MCP on stdio; `serveStdio` builds one server per connection, with the `version` tool when
 * it runs from a local checkout. With `reload`, this process serves through a child running this
 * same CLI without `--reload`, and starts a new child once the build next to this file (or the spec)
 * changed; it settles when the client is gone.
 */
async function serve({ profile, reload }: ServeOptions): Promise<void> {
  const pin = profile === undefined ? [] : ['--profile', profile];
  if (!reload) {
    const checkout = launchKind() === 'local' ? root : undefined;
    serveStdio(() => createServer({ pinnedProfile: profile, checkout }));
    return;
  }
  const cli = fileURLToPath(import.meta.url);
  await serveWithReload({
    command: [process.execPath, ...process.execArgv, cli, ...pin],
    watch: [dirname(cli), join(root, 'spec')],
    onRestart: () => {
      console.error(t(locale, 'reload.restarted'));
    },
  });
}

/**
 * The options of a serving start, `[--profile <name>] [--reload]`, each at most once and in either
 * order. A missing or invalid name, a repeated option and any other argument are reported as a usage
 * error, and the result is undefined.
 */
function serveOptions(args: string[]): ServeOptions | undefined {
  const options: ServeOptions = { reload: false };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? '';
    if (arg === '--reload' && !options.reload) {
      options.reload = true;
    } else if (arg === '--profile' && options.profile === undefined) {
      at += 1;
      options.profile = profileName(arg, args[at]);
      if (options.profile === undefined) return undefined;
    } else {
      rejectServeArgument(arg);
      return undefined;
    }
  }
  return options;
}

/** Reports `arg` as a usage error of a serving start; a repeated option is known, not unknown. */
function rejectServeArgument(arg: string): void {
  if (arg === '--reload' || arg === '--profile') {
    usageError(t(locale, 'cli.unexpectedArgument', { argument: arg }));
  } else {
    strayArgument(arg);
  }
}

/** Sets the exit code from a command's outcome: success when it is done, else failure. */
function exitWith(done: boolean): void {
  process.exitCode = done ? exitCodes.success : exitCodes.failure;
}

/** Where `setup` and `config` write: lines on stdout, errors on stderr, styled for the terminal. */
const output: SetupOutput = createOutput(process.stdout, process.stderr);

/**
 * Runs an interactive command (`setup`, `config`): `run` asks its questions on the terminal and its outcome sets
 * the exit code. Without a terminal on stdin and stdout it stops at once with the `noTty` message
 * (decision 19), before anything else is touched.
 */
async function interactive(
  noTty: MessageKey,
  run: (io: SetupIO) => Promise<boolean>,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(t(locale, noTty));
    process.exitCode = exitCodes.failure;
    return;
  }
  const prompter = createPrompter(process.stdin, process.stdout);
  try {
    exitWith(await run({ prompter, ...output }));
  } finally {
    prompter.close();
  }
}

/**
 * `profile`, the name after `option` (`--profile <name>`, `setup --remove <name>`). A missing or
 * invalid name is reported as a usage error, and the result is undefined.
 */
function profileName(option: string, profile: string | undefined): string | undefined {
  if (profile === undefined) {
    usageError(t(locale, 'cli.missingProfileName', { option }));
  } else if (!isProfileName(profile)) {
    usageError(t(locale, 'cli.invalidProfileName', { profile }));
  } else {
    return profile;
  }
  return undefined;
}

/**
 * The profile name after `option` with nothing after it (`setup --remove <name>`). A missing or
 * invalid name and an argument after it are reported as a usage error, and the result is undefined.
 */
function profileOperand(option: string, [profile, extra]: string[]): string | undefined {
  const name = profileName(option, profile);
  if (name !== undefined && extra !== undefined) {
    usageError(t(locale, 'cli.unexpectedArgument', { argument: extra }));
    return undefined;
  }
  return name;
}

/** `setup --remove <name>`: removes the profile after a yes on the terminal. */
async function remove(operands: string[]): Promise<void> {
  const profile = profileOperand('--remove', operands);
  if (profile !== undefined) {
    await interactive('setup.removeNoTty', (io) => runRemove(locale, io, profile));
  }
}

// The options of `setup` that take no argument.
const SETUP_FLAGS = new Set(['--add', '--list']);

/**
 * `setup [--add | --list | --remove <name>]`: adds a profile (also without an option), lists the
 * profiles, or removes one. Adding and removing ask on a terminal; listing asks nothing and needs
 * none.
 */
async function setup([option = '--add', ...operands]: string[]): Promise<void> {
  if (option === '--remove') {
    await remove(operands);
  } else if (!SETUP_FLAGS.has(option)) {
    strayArgument(option);
  } else if (operands[0] !== undefined) {
    usageError(t(locale, 'cli.unexpectedArgument', { argument: operands[0] }));
  } else if (option === '--list') {
    exitWith(runList(locale, output));
  } else {
    await interactive('setup.noTty', (io) => runSetup(locale, io));
  }
}

switch (command) {
  case undefined:
  case '--profile':
  case '--reload': {
    const options = serveOptions(process.argv.slice(2));
    if (options !== undefined) await serve(options);
    break;
  }
  case '--help':
  case '-h':
  case '--version':
    if (rest[0] !== undefined) {
      usageError(t(locale, 'cli.unexpectedArgument', { argument: rest[0] }));
    } else {
      console.log(command === '--version' ? version : usage);
    }
    break;
  case 'setup':
    await setup(rest);
    break;
  case 'config':
    // `config` takes no option: the menu does everything.
    if (rest[0] !== undefined) {
      strayArgument(rest[0]);
    } else {
      // A local checkout also shows and offers its updates; an installed package only its version.
      const checkout = launchKind() === 'local' ? root : undefined;
      await interactive('config.noTty', (io) => runConfig(locale, io, checkout));
    }
    break;
  default:
    usageError(
      command.startsWith('-')
        ? t(locale, 'cli.unknownOption', { option: command })
        : t(locale, 'cli.unknownCommand', { command }),
    );
}
