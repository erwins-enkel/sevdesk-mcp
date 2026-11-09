#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { isProfileName } from './config.ts';
import { resolveLocale, t } from './i18n/index.ts';
import { version } from './manifest.ts';
import { createPrompter } from './prompt.ts';
import { createServer } from './server.ts';
import { runSetup } from './setup.ts';

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

/** Serves MCP on stdio; `serveStdio` builds one server per connection. */
function serve(pinnedProfile?: string): void {
  serveStdio(() => createServer({ pinnedProfile }));
}

/**
 * `setup [--add]`: adds a profile interactively. Without a terminal on stdin and stdout it stops at
 * once with the `SEVDESK_API_TOKEN` hint (decision 19), before anything else is touched.
 */
async function setup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(t(locale, 'setup.noTty'));
    process.exitCode = exitCodes.failure;
    return;
  }
  const prompter = createPrompter(process.stdin, process.stdout);
  try {
    const done = await runSetup(locale, {
      prompter,
      print: (text) => {
        console.log(text);
      },
      fail: (text) => {
        console.error(text);
      },
    });
    process.exitCode = done ? exitCodes.success : exitCodes.failure;
  } finally {
    prompter.close();
  }
}

switch (command) {
  case undefined:
    serve();
    break;
  case '--profile': {
    const [profile, extra] = rest;
    if (profile === undefined) {
      usageError(t(locale, 'cli.missingProfileName'));
    } else if (!isProfileName(profile)) {
      usageError(t(locale, 'cli.invalidProfileName', { profile }));
    } else if (extra !== undefined) {
      usageError(t(locale, 'cli.unexpectedArgument', { argument: extra }));
    } else {
      serve(profile);
    }
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
  case 'setup': {
    // `setup` and `setup --add` both add a profile.
    const [option, extra] = rest;
    if (option !== undefined && option !== '--add') {
      usageError(
        option.startsWith('-')
          ? t(locale, 'cli.unknownOption', { option })
          : t(locale, 'cli.unexpectedArgument', { argument: option }),
      );
    } else if (extra !== undefined) {
      usageError(t(locale, 'cli.unexpectedArgument', { argument: extra }));
    } else {
      await setup();
    }
    break;
  }
  default:
    usageError(
      command.startsWith('-')
        ? t(locale, 'cli.unknownOption', { option: command })
        : t(locale, 'cli.unknownCommand', { command }),
    );
}
