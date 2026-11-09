import { type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from 'vitest';
import { writeConfig } from './config-file.ts';

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

test("a spawned server reads the config from the test's temporary directory", async () => {
  writeConfig({ limits: { outputChars: 10 } });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  // The SDK's default environment passes only HOME (POSIX) or the profile variables (Windows).
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli] }));

  const result = await client.callTool({
    name: 'search',
    arguments: { code: 'return "abcdefghijklmnop"' },
  });
  await client.close();

  const [block] = result.content as [{ type: 'text'; text: string }];
  expect(JSON.parse(block.text)).toMatchObject({ result: '"abcdefghi' });
});

/**
 * A stdio client transport that also records every raw line the server writes to stdout. The SDK's
 * own transport silently skips non-JSON lines, so it could not show stray output.
 */
function recordingStdioTransport(): { transport: Transport; lines: string[] } {
  const lines: string[] = [];
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let pending = '';
  const transport: Transport = {
    start() {
      child = spawn(process.execPath, [cli], { stdio: ['pipe', 'pipe', 'inherit'] });
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        const parts = (pending + chunk).split('\n');
        pending = parts.pop() ?? '';
        for (const line of parts) {
          lines.push(line);
          if (isJson(line)) transport.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        }
      });
      child.on('close', () => transport.onclose?.());
      return Promise.resolve();
    },
    send(message) {
      child?.stdin.write(`${JSON.stringify(message)}\n`);
      return Promise.resolve();
    },
    close() {
      child?.kill();
      return Promise.resolve();
    },
  };
  return { transport, lines };
}

function isJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

test('search over stdio counts the embedded spec paths and keeps console output off stdout', async () => {
  const spec = JSON.parse(
    readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8'),
  ) as { paths: Record<string, unknown> };
  const { transport, lines } = recordingStdioTransport();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);

  const result = await client.callTool({
    name: 'search',
    arguments: { code: 'console.log("stdout-guard"); return Object.keys(spec.paths).length' },
  });
  await client.close();

  const [block] = result.content as [{ type: 'text'; text: string }];
  expect(JSON.parse(block.text)).toEqual({
    result: Object.keys(spec.paths).length,
    console: ['stdout-guard'],
  });
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((line) => !isJson(line))).toEqual([]);
});

test('--profile pins a spawned server: execute offers only that account', async () => {
  writeConfig({ profiles: { a: { company: 'Company A' }, b: { company: 'Company B' } } });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  // Only the tools are listed: a spawned server uses the real keychain, so no test may read a token.
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [cli, '--profile', 'a'] }),
  );

  const { tools } = await client.listTools();
  await client.close();

  const execute = tools.find((tool) => tool.name === 'execute');
  expect(execute?.inputSchema.properties).toHaveProperty('account.enum', ['a']);
});

test.each([
  [['--profile'], '--profile needs a profile name'],
  [
    ['--profile', 'Bad_Name'],
    'Invalid profile name: Bad_Name (1 to 32 characters: a-z, 0-9 and -)',
  ],
  [['--profile', 'a', 'extra'], 'Unexpected argument: extra'],
])('%j is a usage error and starts no server', (args, message) => {
  const result = run(args, 'en_US.UTF-8');

  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(message);
  expect(result.stderr).toContain('Usage: sevdesk-mcp');
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

test('--help documents --profile, --version and the exit codes and exits zero', () => {
  const result = run(['--help'], 'en_US.UTF-8');

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: sevdesk-mcp');
  expect(result.stdout).toContain('--version  Show the version');
  expect(result.stdout).toContain(
    '--profile <name>  Use only this profile; execute rejects any other account',
  );
  expect(result.stdout).toContain('  0  Success');
  expect(result.stdout).toContain(`  ${String(FAILURE)}  Error while running`);
  expect(result.stdout).toContain(`  ${String(USAGE_ERROR)}  Usage error`);
  expect(result.stdout).not.toContain('{');
});

test('--help in German documents --profile, --version and the exit codes', () => {
  const result = run(['--help'], 'de_DE.UTF-8');

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--version  Version anzeigen');
  expect(result.stdout).toContain(
    '--profile <name>  Nur dieses Profil verwenden; execute lehnt jedes andere Konto ab',
  );
  expect(result.stdout).toContain('Exit-Codes:');
  expect(result.stdout).toContain('  0  Erfolg');
  expect(result.stdout).toContain(`  ${String(FAILURE)}  Fehler bei der Ausführung`);
  expect(result.stdout).toContain(`  ${String(USAGE_ERROR)}  Falscher Aufruf`);
  expect(result.stdout).not.toContain('{');
});
