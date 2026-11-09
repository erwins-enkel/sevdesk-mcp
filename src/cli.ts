#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { isProfileName } from './config.ts';
import { resolveLocale, t } from './i18n/index.ts';
import { version } from './manifest.ts';
import { createServer } from './server.ts';

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
  case 'setup':
    console.error(t(locale, 'setup.notImplemented'));
    process.exitCode = exitCodes.failure;
    break;
  default:
    usageError(
      command.startsWith('-')
        ? t(locale, 'cli.unknownOption', { option: command })
        : t(locale, 'cli.unknownCommand', { command }),
    );
}
