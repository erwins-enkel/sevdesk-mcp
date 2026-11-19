import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { v0_3 } from '@anthropic-ai/mcpb/schemas';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildMcpb, MCPB_FILE, mcpbManifest, readPackage } from '../scripts/mcpb.ts';

const require = createRequire(import.meta.url);
const pkg = readPackage();
const manifest = mcpbManifest(pkg);
const entry = 'node_modules/@erwins-enkel/sevdesk-mcp/dist/cli.js';

describe('the manifest of the Claude Desktop extension', () => {
  test('is a valid MCPB 0.3 manifest', () => {
    const parsed = v0_3.McpbManifestSchema.safeParse(manifest);

    expect(parsed.error?.issues).toBeUndefined();
    expect(manifest.manifest_version).toBe('0.3');
  });

  test('takes version and Node range from package.json', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
  });

  test('starts the package installed under node_modules, so it runs as an installed package', () => {
    expect(manifest.server).toEqual({
      type: 'node',
      entry_point: entry,
      mcp_config: {
        command: 'node',
        args: [`\${__dirname}/${entry}`],
        env: {
          SEVDESK_API_TOKEN: '${user_config.api_token}',
          SEVDESK_READONLY: '${user_config.read_only}',
          SEVDESK_PROFILE: 'claude-desktop',
        },
      },
    });
  });

  test('asks for the token as a required secret and for read-only, off by default', () => {
    expect(Object.keys(manifest.user_config)).toEqual(['api_token', 'read_only']);
    expect(manifest.user_config.api_token).toMatchObject({
      type: 'string',
      sensitive: true,
      required: true,
    });
    expect(manifest.user_config.read_only).toMatchObject({ type: 'boolean', default: false });
  });
});

// Builds the real bundle once, unpacks it with the mcpb CLI and starts the server from there, as
// Claude Desktop does: Node runs the entry with the manifest's environment.
describe('the built Claude Desktop extension', () => {
  let dir: string;
  let unpacked: string;
  let packageDir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-mcpb-'));
    const file = await buildMcpb(dir);
    expect(file).toBe(join(dir, MCPB_FILE));

    unpacked = join(dir, 'unpacked');
    const mcpbCli = join(dirname(require.resolve('@anthropic-ai/mcpb/cli')), 'cli', 'cli.js');
    const unpack = spawnSync(process.execPath, [mcpbCli, 'unpack', file, unpacked], {
      encoding: 'utf8',
    });
    expect(unpack.status, unpack.stderr).toBe(0);
    packageDir = join(unpacked, 'node_modules', '@erwins-enkel', 'sevdesk-mcp');
  }, 300_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The manifest's environment as Claude Desktop fills it: a token, read-only off. */
  function serverEnv(): Record<string, string> {
    const filled = Object.entries(manifest.server.mcp_config.env).map(
      ([key, value]): [string, string] => [
        key,
        value
          .replace('${user_config.api_token}', 'test-token')
          .replace('${user_config.read_only}', 'false'),
      ],
    );
    return { ...getDefaultEnvironment(), ...Object.fromEntries(filled) };
  }

  test('carries the manifest it was built with', () => {
    expect(JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'))).toEqual(manifest);
  });

  test('serves exactly search and execute, and search reads the embedded spec', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(unpacked, ...entry.split('/'))],
        env: serverEnv(),
      }),
    );

    const { tools } = await client.listTools();
    const result = await client.callTool({
      name: 'search',
      arguments: { code: "return Object.keys(spec.paths).includes('/Contact')" },
    });
    await client.close();

    expect(tools.map((tool) => tool.name)).toEqual(['search', 'execute']);
    const [block] = result.content as [{ type: 'text'; text: string }];
    expect(JSON.parse(block.text)).toMatchObject({ result: true });
  });

  test('reports the package version', () => {
    const run = spawnSync(process.execPath, [join(unpacked, ...entry.split('/')), '--version'], {
      encoding: 'utf8',
    });

    expect(run.stdout.trim()).toBe(pkg.version);
  });

  test('ships the licence and the spec attribution but no native keychain binary', () => {
    expect(existsSync(join(packageDir, 'LICENSE'))).toBe(true);
    expect(existsSync(join(packageDir, 'spec', 'README.md'))).toBe(true);
    expect(readdirSync(join(packageDir, 'node_modules', '@napi-rs'))).toEqual(['keyring']);
  });
});
