import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.ts';

/** Connects a test client to a fresh `createServer(options)` over an in-memory transport. */
export async function connect(options?: Parameters<typeof createServer>[0]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await createServer(options).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** The parsed JSON envelope of a tool result's single text block. */
export function envelopeOf(result: { content?: unknown }): Record<string, unknown> {
  const [block] = result.content as [{ type: 'text'; text: string }];
  return JSON.parse(block.text) as Record<string, unknown>;
}
