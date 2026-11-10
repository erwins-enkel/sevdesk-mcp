#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { runConfig } from './config-menu.ts';
import { isProfileName } from './config.ts';
import { type MessageKey, resolveLocale, t } from './i18n/index.ts';
import { version } from './manifest.ts';
import { createPrompter } from './prompt.ts';
import { createServer } from './server.ts';
import { runList, runRemove, runSetup, type SetupIO, type SetupOutput } from './setup.ts';

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

/** Serves MCP on stdio; `serveStdio` builds one server per connection. */
function serve(pinnedProfile?: string): void {
  serveStdio(() => createServer({ pinnedProfile }));
}

/** Sets the exit code from a command's outcome: success when it is done, else failure. */
function exitWith(done: boolean): void {
  process.exitCode = done ? exitCodes.success : exitCodes.failure;
}

/** Where `setup` and `config` write: lines on stdout, errors on stderr. */
const output: SetupOutput = {
  print: (text) => {
    console.log(text);
  },
  fail: (text) => {
    console.error(text);
  },
};

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
 * The profile name after `option` (`--profile <name>`, `setup --remove <name>`). A missing or invalid
 * name and an argument after it are reported as a usage error, and the result is undefined.
 */
function profileOperand(option: string, [profile, extra]: string[]): string | undefined {
  if (profile === undefined) {
    usageError(t(locale, 'cli.missingProfileName', { option }));
  } else if (!isProfileName(profile)) {
    usageError(t(locale, 'cli.invalidProfileName', { profile }));
  } else if (extra !== undefined) {
    usageError(t(locale, 'cli.unexpectedArgument', { argument: extra }));
  } else {
    return profile;
  }
  return undefined;
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
    serve();
    break;
  case '--profile': {
    const profile = profileOperand(command, rest);
    if (profile !== undefined) serve(profile);
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
      await interactive('config.noTty', (io) => runConfig(locale, io));
    }
    break;
  default:
    usageError(
      command.startsWith('-')
        ? t(locale, 'cli.unknownOption', { option: command })
        : t(locale, 'cli.unknownCommand', { command }),
    );
}
