import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, test } from 'vitest';
import { createServer } from '../src/server.ts';
import { connect } from './connect.ts';

const pkg = createRequire(import.meta.url)('../package.json') as { name: string; version: string };

test('completes the MCP handshake and reports the package name and version', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  expect(client.getServerVersion()).toMatchObject({ name: pkg.name, version: pkg.version });
  await client.close();
});

test('without a local checkout the server offers exactly search and execute', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();

  expect(tools.map((tool) => tool.name)).toEqual(['search', 'execute']);
});
