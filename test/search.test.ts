import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, expect, test, vi } from 'vitest';
import { GUIDES } from '../src/guides.ts';
import { connect, envelopeOf } from './connect.ts';

const pkg = createRequire(import.meta.url)('../package.json') as { files: string[] };

async function search(code: string) {
  const client = await connect();
  const result = await client.callTool({ name: 'search', arguments: { code } });
  await client.close();
  return { isError: result.isError === true, envelope: envelopeOf(result) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('search is registered with the read-only annotation', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();

  expect(tools.find((tool) => tool.name === 'search')?.annotations?.readOnlyHint).toBe(true);
});

test('the description points the model to the guides', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();

  expect(tools.find((tool) => tool.name === 'search')?.description).toContain('`guides`');
});

test('a snippet lists the guide titles and returns a guide text', async () => {
  const titles = await search(
    'return Object.entries(guides).map(([id, guide]) => ({ id, title: guide.title }))',
  );
  const text = await search('return guides.offer.text');

  expect(titles.isError).toBe(false);
  expect(titles.envelope.result).toEqual(
    Object.entries(GUIDES).map(([id, { title }]) => ({ id, title })),
  );
  expect(text.envelope.result).toBe(GUIDES.offer?.text);
});

test('the offer guide names saveOrder, every required field of the patched spec and orderType AN', async () => {
  const { isError, envelope } = await search(`
    const text = guides.offer.text;
    const { Model_Order, Model_OrderPos } = spec.components.schemas;
    const required = [...Model_Order.required, ...Model_OrderPos.required];
    return {
      required: required.length,
      missing: required.filter((field) => !text.includes(field)),
      saveOrder: text.includes('POST /Order/Factory/saveOrder'),
      offerType: text.includes('"orderType": "AN"'),
    };`);

  const result = envelope.result as { required: number };
  expect(isError).toBe(false);
  expect(result).toMatchObject({ missing: [], saveOrder: true, offerType: true });
  expect(result.required).toBeGreaterThan(0);
});

test('a guide covers the date formats and the time zone of sevDesk documents', async () => {
  const { envelope } = await search('return guides.dates');

  expect(envelope.result).toEqual({
    title: 'Date formats and time zone',
    text: expect.stringContaining('Europe/Berlin') as string,
  });
  for (const fact of ['dd.mm.yyyy', 'ISO 8601', '+01:00', '+02:00', 'Unix timestamps in seconds']) {
    expect(GUIDES.dates?.text).toContain(fact);
  }
});

test('a snippet reading a $ref-backed schema sees it resolved', async () => {
  const { isError, envelope } = await search(`
    const items = spec.paths['/Contact'].get.responses['200'].content['application/json']
      .schema.properties.objects.items;
    return {
      hasRef: '$ref' in items,
      sameAsComponent: JSON.stringify(items) === JSON.stringify(spec.components.schemas.Model_ContactResponse),
      refsLeft: JSON.stringify(spec).includes('"$ref"'),
    };`);

  expect(isError).toBe(false);
  expect(envelope.result).toEqual({ hasRef: false, sameAsComponent: true, refsLeft: false });
});

test('console.log comes back in the result and never reaches stdout', async () => {
  const stdout = vi.spyOn(process.stdout, 'write');

  const { envelope } = await search('console.log("marker", { a: 1 }); return "done"');

  expect(envelope).toEqual({ result: 'done', console: ['marker {"a":1}'] });
  expect(stdout).not.toHaveBeenCalled();
});

test('an undefined return yields an explicit "no return value" note', async () => {
  const { isError, envelope } = await search('const x = 1;');

  expect(isError).toBe(false);
  expect(envelope).not.toHaveProperty('result');
  expect(envelope.notes).toEqual([expect.stringContaining('No return value') as string]);
});

test('a result over the limit is cut with a hint to filter more narrowly', async () => {
  const { isError, envelope } = await search('return "x".repeat(30000)');

  expect(isError).toBe(false);
  expect(envelope.result).toHaveLength(20_000);
  expect(envelope.notes).toEqual([
    'Result cut to 20000 of 30002 characters. Filter or map it more narrowly in the code.',
  ]);
});

test('an uncaught error returns isError with the agreed error shape', async () => {
  const { isError, envelope } = await search('console.log("before"); throw new TypeError("boom")');

  expect(isError).toBe(true);
  expect(envelope).toEqual({
    error: { kind: 'snippet_error', message: 'TypeError: boom' },
    console: ['before'],
  });
});

test('a memory hog is stopped at the default memory limit', { timeout: 30_000 }, async () => {
  const { isError, envelope } = await search(
    'const a = []; while (true) a.push({ x: "y".repeat(100) + a.length });',
  );

  expect(isError).toBe(true);
  expect(envelope.error).toEqual({
    kind: 'memory_limit',
    message: 'The code exceeded the 64 MB memory limit.',
    hint: 'Work on less data at once.',
  });
});

test('the published package ships the embedded spec', () => {
  const spec = readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8');

  expect(pkg.files).toContain('spec');
  expect(spec.length).toBeGreaterThan(0);
});
