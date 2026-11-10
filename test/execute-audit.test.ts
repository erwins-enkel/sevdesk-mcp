import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { localDirs } from '../src/paths.ts';
import { writeConfig } from './config-file.ts';
import { connect, envelopeOf } from './connect.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// The audit log (PRD §6, decision 16): every write call `execute` handles leaves one line in the
// month's JSONL file in the state directory (executed, held, confirmed or rejected), plain reads
// none, and no line holds a body or the token. A log that cannot be written fails the call.

const TOKEN = 'token-audit-4b9e2c71';
const CHECK = '/Tools/bookkeepingSystemVersion';
const SEND = '/Order/42/sendViaEmail';
const PDF = '/Order/42/getPdf';
// In every request body, so a test can tell that no body reached the log.
const MARKER = 'body-marker-8d3f1a';
const CONTACT = { name: `MCP Test GmbH ${MARKER}` };
const MAIL = { toEmail: 'max@example.com', subject: `Angebot ${MARKER}`, text: MARKER };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const closers: (() => Promise<void>)[] = [];

const routes: MockRoutes = {
  'GET /Contact': () => ({ json: { objects: [{ id: '7', objectName: 'Contact' }] } }),
  'POST /Contact': () => ({ status: 201, json: { objects: { id: '7', objectName: 'Contact' } } }),
  'GET /Order/42': () => ({
    json: { objects: [{ id: '42', objectName: 'Order', orderType: 'AN', orderNumber: 'AN-1042' }] },
  }),
  [`POST ${SEND}`]: () => ({ status: 201, json: { objects: { id: '9', objectName: 'Email' } } }),
  [`GET ${PDF}`]: () => ({ json: { objects: { base64Encoded: true, content: 'JVBERi0xLjQ=' } } }),
};

beforeEach(() => {
  vi.stubEnv('SEVDESK_API_TOKEN', TOKEN);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk for this test; `afterEach` closes it. */
async function mock(overrides: MockRoutes = {}) {
  const sevdesk = await startMockSevdesk({ ...routes, ...overrides });
  closers.push(sevdesk.close);
  return sevdesk;
}

/** Connects a client to a fresh server for this test; `afterEach` closes it. */
async function open(): Promise<Client> {
  const client = await connect();
  closers.push(() => client.close());
  return client;
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'execute', arguments: args });
  return { isError: result.isError === true, envelope: envelopeOf(result) };
}

/** The calls the code and the confirmation sent, without the bookkeeping-system check. */
function snippetCalls(requests: MockRequest[]): string[] {
  return requests
    .filter((request) => request.path !== CHECK)
    .map((request) => `${request.method} ${request.path}`);
}

/** The body of the first `POST path` the mock received, as it was sent. */
function sentBody(requests: MockRequest[], path: string): string {
  const request = requests.find((sent) => sent.method === 'POST' && sent.path === path);
  if (request === undefined) throw new Error(`POST ${path} was not sent`);
  return request.body;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const auditDir = () => join(localDirs().state, 'audit');

/**
 * Every line of the audit log, parsed, in order. Each file must end with a line break and be named
 * after the UTC month of its lines.
 */
function auditLines(): Record<string, unknown>[] {
  if (!existsSync(auditDir())) return [];
  return readdirSync(auditDir())
    .sort()
    .flatMap((name) => {
      const text = readFileSync(join(auditDir(), name), 'utf8');
      expect(text === '' || text.endsWith('\n')).toBe(true);
      const lines = text
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const { time } of lines) expect(name).toBe(`${String(time).slice(0, 7)}.jsonl`);
      return lines;
    });
}

/** No request body and no token in any audit file. */
function expectNoBodyOrToken(): void {
  for (const name of readdirSync(auditDir())) {
    const text = readFileSync(join(auditDir(), name), 'utf8');
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(TOKEN);
  }
}

/** An audit line with the time and the environment profile. */
function line(fields: Record<string, unknown>) {
  return { time: expect.stringMatching(ISO) as unknown, profile: 'env', ...fields };
}

/** Makes the audit log unwritable: a file where its directory belongs (also for root). */
function breakLog(): void {
  rmSync(auditDir(), { recursive: true, force: true });
  mkdirSync(localDirs().state, { recursive: true });
  writeFileSync(auditDir(), '');
}

test('executed, held and confirmed write calls each leave one line; reads leave none', async () => {
  const sevdesk = await mock();
  const client = await open();

  const ran = await call(client, {
    code: `
      await sevdesk.request('GET', '/Contact');
      const contact = await sevdesk.request('POST', '/Contact', { body: ${JSON.stringify(CONTACT)} });
      await sevdesk.request('POST', '${SEND}', { body: ${JSON.stringify(MAIL)} });
      await sevdesk.request('GET', '${PDF}', { query: { download: true } });
      return contact.objects.id;`,
  });
  expect(ran.isError).toBe(false);
  const { token } = ran.envelope.confirmation as { token: string };
  const confirmed = await call(client, { confirm: token });

  expect(confirmed.isError).toBe(false);
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'GET /Contact',
    'POST /Contact',
    'GET /Order/42',
    `POST ${SEND}`,
    `GET ${PDF}`,
  ]);
  const contactHash = sha256(sentBody(sevdesk.requests, '/Contact'));
  const mailHash = sha256(sentBody(sevdesk.requests, SEND));
  const download = { download: 'true' };
  expect(auditLines()).toEqual([
    line({
      method: 'POST',
      path: '/Contact',
      status: 201,
      objectId: '7',
      bodyHash: contactHash,
      outcome: 'executed',
    }),
    line({ method: 'POST', path: SEND, bodyHash: mailHash, outcome: 'held' }),
    line({ method: 'GET', path: PDF, query: download, outcome: 'held' }),
    line({
      method: 'POST',
      path: SEND,
      status: 201,
      objectId: '9',
      bodyHash: mailHash,
      outcome: 'confirmed',
    }),
    line({ method: 'GET', path: PDF, query: download, status: 200, outcome: 'confirmed' }),
  ]);
  expectNoBodyOrToken();
  if (process.platform !== 'win32') {
    const [file = ''] = readdirSync(auditDir());
    expect(statSync(join(auditDir(), file)).mode & 0o777).toBe(0o600);
  }
});

test('calls read-only mode or the gate rejects leave a rejected line each; reads leave none', async () => {
  vi.stubEnv('SEVDESK_READONLY', 'true');
  const sevdesk = await mock();
  const readOnly = await call(await open(), {
    code: `
      const rejected = [];
      const calls = [['POST', '/Contact', { body: ${JSON.stringify(CONTACT)} }], ['GET', '${PDF}']];
      for (const args of calls) {
        try { await sevdesk.request(...args); } catch (e) { rejected.push(e.kind); }
      }
      await sevdesk.request('GET', '/Contact');
      return rejected;`,
  });
  // SEVDESK_READONLY is read once per server.
  vi.stubEnv('SEVDESK_READONLY', undefined);
  const gated = await call(await open(), {
    code: `try { await sevdesk.paginate('${PDF}'); } catch (e) { return e.kind; }`,
  });

  expect(readOnly.envelope.result).toEqual(['read_only', 'read_only']);
  expect(gated.envelope.result).toBe('needs_confirmation');
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Contact']);
  expect(auditLines()).toEqual([
    line({
      method: 'POST',
      path: '/Contact',
      bodyHash: sha256(JSON.stringify(CONTACT)),
      outcome: 'rejected',
    }),
    line({ method: 'GET', path: PDF, outcome: 'rejected' }),
    line({ method: 'GET', path: PDF, outcome: 'rejected' }),
  ]);
  expectNoBodyOrToken();
});

test('with "audit": false no audit file is written', async () => {
  writeConfig({ audit: false });
  const sevdesk = await mock();
  const client = await open();

  const ran = await call(client, {
    code: `
      await sevdesk.request('POST', '/Contact', { body: ${JSON.stringify(CONTACT)} });
      await sevdesk.request('POST', '${SEND}', { body: ${JSON.stringify(MAIL)} });
      try { await sevdesk.paginate('${PDF}'); } catch (e) { return e.kind; }`,
  });
  const { token } = ran.envelope.confirmation as { token: string };
  const confirmed = await call(client, { confirm: token });

  expect(ran.envelope.result).toBe('needs_confirmation');
  expect(confirmed.isError).toBe(false);
  expect(snippetCalls(sevdesk.requests)).toEqual([
    'POST /Contact',
    'GET /Order/42',
    `POST ${SEND}`,
  ]);
  expect(existsSync(auditDir())).toBe(false);
});

test.each([
  {
    name: 'a write is not sent',
    readOnly: false,
    code: `await sevdesk.request('POST', '/Contact', { body: ${JSON.stringify(CONTACT)} });`,
    state: 'nothing was sent',
  },
  {
    name: 'an irreversible call is not held',
    readOnly: false,
    code: `await sevdesk.request('POST', '${SEND}', { body: ${JSON.stringify(MAIL)} });`,
    state: `POST ${SEND} was neither held nor sent`,
  },
  {
    name: 'a rejected call fails with audit_error',
    readOnly: true,
    code: `await sevdesk.request('POST', '/Contact', { body: ${JSON.stringify(CONTACT)} });`,
    state: 'POST /Contact was rejected and not sent',
  },
])('with an unwritable audit log $name, even when the code catches it', async (setup) => {
  if (setup.readOnly) vi.stubEnv('SEVDESK_READONLY', 'true');
  breakLog();
  const sevdesk = await mock();

  const { isError, envelope } = await call(await open(), {
    code: `try { ${setup.code} } catch (e) { return e.kind; } return 'done';`,
  });

  expect(isError).toBe(true);
  expect(envelope.error).toMatchObject({
    kind: 'audit_error',
    message: expect.stringMatching(
      new RegExp(`could not be written \\(\\w+\\): ${setup.state}\\.$`),
    ) as unknown,
  });
  expect(envelope).not.toHaveProperty('writes');
  expect(envelope).not.toHaveProperty('confirmation');
  expect(snippetCalls(sevdesk.requests)).toEqual([]);
});

test('a line that cannot be written after the write was sent fails the run, even when caught', async () => {
  const sevdesk = await mock({
    'POST /Contact': () => {
      breakLog();
      return { status: 201, json: { objects: { id: '7', objectName: 'Contact' } } };
    },
  });

  const { isError, envelope } = await call(await open(), {
    code: `
      try { await sevdesk.request('POST', '/Contact', { body: ${JSON.stringify(CONTACT)} }); } catch {}
      await sevdesk.request('POST', '${SEND}', { body: ${JSON.stringify(MAIL)} });
      return 'ok';`,
  });

  expect(isError).toBe(true);
  expect(envelope.error).toMatchObject({
    kind: 'audit_error',
    message: expect.stringMatching(/: POST \/Contact was sent\.$/) as unknown,
  });
  expect(envelope.writes).toEqual([
    { method: 'POST', path: '/Contact', status: 201, objectId: '7' },
  ]);
  expect(envelope).not.toHaveProperty('confirmation');
  expect(snippetCalls(sevdesk.requests)).toEqual(['POST /Contact']);
});

test('a write the code does not await has its line when the result comes back', async () => {
  await mock();

  const { isError } = await call(await open(), {
    code: `sevdesk.request('POST', '/Contact', { body: ${JSON.stringify(CONTACT)} }); return 'fired';`,
  });

  expect(isError).toBe(false);
  const lines = auditLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ method: 'POST', path: '/Contact', outcome: 'executed' });
});

test('confirm with an unwritable audit log sends nothing and keeps the token valid', async () => {
  const sevdesk = await mock();
  const client = await open();
  const ran = await call(client, {
    code: `await sevdesk.request('POST', '${SEND}', { body: ${JSON.stringify(MAIL)} }); return 1;`,
  });
  const { token } = ran.envelope.confirmation as { token: string };

  breakLog();
  const refused = await call(client, { confirm: token });
  expect(refused.isError).toBe(true);
  expect(refused.envelope.error).toMatchObject({
    kind: 'audit_error',
    message: expect.stringMatching(/: nothing was sent\.$/) as unknown,
  });
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Order/42']);

  rmSync(auditDir());
  const confirmed = await call(client, { confirm: token });
  expect(confirmed.isError).toBe(false);
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Order/42', `POST ${SEND}`]);
  expect(auditLines()).toEqual([
    line({
      method: 'POST',
      path: SEND,
      status: 201,
      objectId: '9',
      bodyHash: sha256(JSON.stringify(MAIL)),
      outcome: 'confirmed',
    }),
  ]);
});

test('a confirmed call whose line cannot be written stops the replay with audit_error', async () => {
  const sevdesk = await mock({
    [`POST ${SEND}`]: () => {
      breakLog();
      return { status: 201, json: { objects: { id: '9', objectName: 'Email' } } };
    },
  });
  const client = await open();
  const ran = await call(client, {
    code: `
      await sevdesk.request('POST', '${SEND}', { body: ${JSON.stringify(MAIL)} });
      await sevdesk.request('GET', '${PDF}');
      return 1;`,
  });
  const { token } = ran.envelope.confirmation as { token: string };

  const { isError, envelope } = await call(client, { confirm: token });

  expect(isError).toBe(true);
  expect(envelope.error).toMatchObject({
    kind: 'audit_error',
    message: expect.stringMatching(new RegExp(`: POST ${SEND} was sent\\.$`)) as unknown,
  });
  expect(envelope.confirmed).toEqual([
    { method: 'POST', path: SEND, outcome: 'sent', status: 201, objectId: '9' },
    { method: 'GET', path: PDF, outcome: 'not_sent' },
  ]);
  expect(snippetCalls(sevdesk.requests)).toEqual(['GET /Order/42', `POST ${SEND}`]);
});

test('several processes appending at once leave only whole lines', async () => {
  const processes = 4;
  const lines = 250;
  const audit = new URL('../src/audit.ts', import.meta.url).href;
  // Each child writes its lines as fast as it can; long paths make torn writes likelier to show.
  const script = (child: number) => `
    import { auditLog } from ${JSON.stringify(audit)};
    const log = auditLog('mcp-test');
    const url = new URL('https://my.sevdesk.de/api/v1/Contact');
    for (let i = 0; i < ${String(lines)}; i++) {
      const path = '/P${String(child)}-' + i + '-' + 'x'.repeat(3000);
      log.write({ method: 'POST', path, url, body: '{}' }, 'executed', { status: 201 });
    }`;

  const exits = await Promise.all(
    Array.from(
      { length: processes },
      (_, child) =>
        new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const spawned = spawn(process.execPath, ['--input-type=module', '-e', script(child)], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          spawned.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
          spawned.on('error', reject);
          spawned.on('close', (code) => {
            resolve({ code, stderr });
          });
        }),
    ),
  );

  expect(exits).toEqual(exits.map(() => expect.objectContaining({ code: 0 }) as unknown));
  const written = auditLines();
  expect(written).toHaveLength(processes * lines);
  expect(new Set(written.map(({ path }) => path)).size).toBe(processes * lines);
  for (let child = 0; child < processes; child += 1) {
    const own = written.filter(({ path }) => String(path).startsWith(`/P${String(child)}-`));
    expect(own).toHaveLength(lines);
  }
});
