import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from 'vitest';

// Runs the real entry point through Node's type stripping, so no build is needed.
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const pkg = createRequire(import.meta.url)('../package.json') as { name: string };

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

test('setup fails closed until it is implemented', () => {
  const result = run(['setup'], 'de_DE.UTF-8');

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Der Setup-Assistent ist noch nicht implementiert.');
});

test('an unknown command exits non-zero and prints the usage', () => {
  const result = run(['nope'], 'en_US.UTF-8');

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unknown command: nope');
  expect(result.stderr).toContain('Usage: sevdesk-mcp');
});

test('--help prints the usage and exits zero', () => {
  const result = run(['--help'], 'en_US.UTF-8');

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: sevdesk-mcp');
});
