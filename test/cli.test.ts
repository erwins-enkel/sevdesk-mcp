import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from 'vitest';

// Runs the real entry point through Node's type stripping, so no build is needed.
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const pkg = createRequire(import.meta.url)('../package.json') as { name: string; version: string };

// The exit-code contract the usage text documents.
const USAGE_ERROR = 2;
const FAILURE = 1;

function run(args: string[], locale: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, LC_ALL: locale },
    encoding: 'utf8',
  });
}

test('serves MCP over stdio when started without a command', async () => {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli] }));

  expect(client.getServerVersion()?.name).toBe(pkg.name);
  await client.close();
});

test('--version prints exactly the package version and exits zero', () => {
  const result = run(['--version'], 'en_US.UTF-8');

  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${pkg.version}\n`);
  expect(result.stderr).toBe('');
});

test('setup fails closed with the runtime-failure code, not the usage-error code', () => {
  const result = run(['setup'], 'de_DE.UTF-8');

  expect(result.status).toBe(FAILURE);
  expect(result.status).not.toBe(USAGE_ERROR);
  expect(result.stderr).toContain('Der Setup-Assistent ist noch nicht implementiert.');
});

test('an unknown command is a usage error and prints the usage', () => {
  const result = run(['nope'], 'en_US.UTF-8');

  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stderr).toContain('Unknown command: nope');
  expect(result.stderr).toContain('Usage: sevdesk-mcp');
});

test('an unknown option is a usage error', () => {
  const result = run(['--nope'], 'en_US.UTF-8');

  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stderr).toContain('Unknown option: --nope');
  expect(result.stderr).toContain('Usage: sevdesk-mcp');
});

test('an argument after --version is a usage error', () => {
  const result = run(['--version', 'extra'], 'en_US.UTF-8');

  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Unexpected argument: extra');
});

test('--help documents --version and the exit codes and exits zero', () => {
  const result = run(['--help'], 'en_US.UTF-8');

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: sevdesk-mcp');
  expect(result.stdout).toContain('--version  Show the version');
  expect(result.stdout).toContain('  0  Success');
  expect(result.stdout).toContain(`  ${String(FAILURE)}  Error while running`);
  expect(result.stdout).toContain(`  ${String(USAGE_ERROR)}  Usage error`);
  expect(result.stdout).not.toContain('{');
});

test('--help in German documents --version and the exit codes', () => {
  const result = run(['--help'], 'de_DE.UTF-8');

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--version  Version anzeigen');
  expect(result.stdout).toContain('Exit-Codes:');
  expect(result.stdout).toContain('  0  Erfolg');
  expect(result.stdout).toContain(`  ${String(FAILURE)}  Fehler bei der Ausführung`);
  expect(result.stdout).toContain(`  ${String(USAGE_ERROR)}  Falscher Aufruf`);
  expect(result.stdout).not.toContain('{');
});
