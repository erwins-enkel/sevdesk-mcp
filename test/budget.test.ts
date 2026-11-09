import { expect, test } from 'vitest';
import { writeConfig } from './config-file.ts';
import { connect } from './connect.ts';

// PRD §10: all tool descriptions together, MCP instructions included, under 1,500 tokens.
const BUDGET_TOKENS = 1500;
// A conservative estimate without a tokenizer: Claude's and OpenAI's tokenizers both average more
// than three characters per token on English prose and JSON Schema.
const CHARS_PER_TOKEN = 3;

// Profiles put their names and companies into `execute`'s `account` enum and description, so the
// budget is measured with several, named like real companies.
const PROFILES = {
  'mcp-test': { company: 'MCP Test GmbH' },
  'beispiel-handel': { company: 'Beispiel Handels GmbH & Co. KG' },
  'muster-beratung': { company: 'Muster Beratung UG (haftungsbeschränkt)' },
};

test('instructions plus all tool descriptions and input schemas stay within the token budget', async () => {
  writeConfig({ profiles: PROFILES });
  const client = await connect();
  const instructions = client.getInstructions() ?? '';
  const { tools } = await client.listTools();
  await client.close();

  const chars =
    instructions.length +
    tools.reduce(
      (sum, tool) =>
        sum +
        tool.name.length +
        (tool.description ?? '').length +
        JSON.stringify(tool.inputSchema).length,
      0,
    );

  expect(instructions).toContain('search');
  expect(instructions).toContain('execute');
  expect(tools.length).toBeGreaterThan(0);
  expect(tools.find((tool) => tool.name === 'execute')?.inputSchema.properties).toHaveProperty(
    'account.enum',
    Object.keys(PROFILES),
  );
  expect(Math.ceil(chars / CHARS_PER_TOKEN)).toBeLessThanOrEqual(BUDGET_TOKENS);
});
