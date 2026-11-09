#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveLocale, t } from './i18n/index.ts';
import { createServer } from './server.ts';

const locale = resolveLocale();
const command = process.argv[2];

switch (command) {
  case undefined:
    serveStdio(createServer);
    break;
  case '--help':
  case '-h':
    console.log(t(locale, 'cli.usage'));
    break;
  case 'setup':
    console.error(t(locale, 'setup.notImplemented'));
    process.exitCode = 1;
    break;
  default:
    console.error(t(locale, 'cli.unknownCommand', { command }));
    console.error(t(locale, 'cli.usage'));
    process.exitCode = 1;
}
