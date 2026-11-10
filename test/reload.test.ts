import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { serveWithReload } from '../src/reload.ts';

// `serveWithReload` in-process over streams, with a fake MCP server as the child. The fake is a
// script in a temporary build directory, the only watched one; "rebuilding" rewrites it with a new
// version and a later mtime. Each child logs every line it receives to `received-<pid>.log` next to
// that directory (outside it, so logging never counts as a build). Nothing in the repo is written.

/** The fake server: answers each request with its version, pid and the method; a few test methods. */
const fakeServer = (version: string) => `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = new URL('../received-' + process.pid + '.log', import.meta.url);
let held;
const answer = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
    result: { version: ${JSON.stringify(version)}, pid: process.pid, method: message.method } }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(log, line + '\\n');
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write('echo:' + line + '\\n'); return; }
  if (message.method === 'release') answer(held);
  if (message.id === undefined || message.method === undefined) return;
  if (message.method === 'hang') return;
  if (message.method === 'hold') { held = message; return; }
  if (message.method === 'exit') process.exit(3);
  answer(message);
});
`;

interface Result {
  version: string;
  pid: number;
  method: string;
}

interface Harness {
  dir: string;
  /** Rewrites the fake as `version` with a modification time later than any before. */
  rebuild(version: string): void;
  /** Writes `line` to the supervisor's input. */
  write(line: string): void;
  /** Resolves to the message of the response line for `id` once it arrives. */
  response(id: number): Promise<Record<string, unknown>>;
  /** Sends a request and resolves to its response's message. */
  request(id: number, method: string, params?: object): Promise<Record<string, unknown>>;
  /** Sends a request and resolves to its result. */
  call(id: number, method: string): Promise<Result>;
  /** Every line the supervisor wrote to its output. */
  lines: string[];
  /** The lines the child `pid` received. */
  received(pid: number): string[];
  /** Resolves once the child `pid` received `count` lines. */
  reached(pid: number, count: number): Promise<void>;
  restarts: number;
  done: Promise<void>;
  end(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.end();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function start(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-reload-'));
  const build = join(dir, 'build');
  const script = join(build, 'server.mjs');
  mkdirSync(build);
  writeFileSync(script, fakeServer('v1'));
  let stamp = Date.now() / 1000;
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  createInterface({ input: output }).on('line', (line) => lines.push(line));
  const harness: Harness = {
    dir,
    rebuild(version) {
      writeFileSync(script, fakeServer(version));
      stamp += 10;
      utimesSync(script, stamp, stamp);
    },
    write(line) {
      input.write(`${line}\n`);
    },
    response: (id) =>
      vi.waitFor(() => {
        const found = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((message) => message.id === id);
        if (found === undefined) throw new Error(`no response to ${String(id)}`);
        return found;
      }),
    request(id, method, params) {
      harness.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return harness.response(id);
    },
    async call(id, method) {
      return (await harness.request(id, method)).result as Result;
    },
    lines,
    received: (pid) =>
      readFileSync(join(dir, `received-${String(pid)}.log`), 'utf8')
        .split('\n')
        .slice(0, -1),
    reached: (pid, count) =>
      vi.waitFor(() => {
        expect(harness.received(pid)).toHaveLength(count);
      }),
    restarts: 0,
    done: Promise.resolve(),
    async end() {
      input.end();
      await harness.done;
    },
  };
  harness.done = serveWithReload({
    command: [process.execPath, script],
    watch: [build],
    input,
    output,
    onRestart: () => {
      harness.restarts += 1;
    },
  });
  harnesses.push(harness);
  return harness;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('passes lines through unchanged in both directions, JSON or not', async () => {
  const harness = start();
  const raw = '{ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }';
  harness.write(raw);
  harness.write('not json');
  await vi.waitFor(() => {
    expect(harness.lines).toHaveLength(2);
  });

  const [response] = harness.lines;
  const { pid } = (JSON.parse(response ?? '') as { result: Result }).result;
  expect(response).toBe(
    JSON.stringify({ jsonrpc: '2.0', id: 7, result: { version: 'v1', pid, method: 'tools/list' } }),
  );
  expect(harness.lines[1]).toBe('echo:not json');
  expect(harness.received(pid)).toEqual([raw, 'not json']);
});

test('after a rebuild the next request runs in a new child that got the opening replayed', async () => {
  const harness = start();
  await harness.request(0, 'initialize', INITIALIZE.params);
  harness.write(JSON.stringify(INITIALIZED));
  const before = await harness.call(1, 'tools/call');

  harness.rebuild('v2');
  const after = await harness.call(2, 'tools/call');

  expect(before.version).toBe('v1');
  expect(after.version).toBe('v2');
  expect(after.pid).not.toBe(before.pid);
  expect(harness.received(after.pid).map((line) => JSON.parse(line) as unknown)).toEqual([
    { ...INITIALIZE, id: 'sevdesk-mcp-reload' },
    INITIALIZED,
    { jsonrpc: '2.0', id: 2, method: 'tools/call' },
  ]);
  // The replay's response stays with the supervisor: the client saw one answer per request.
  expect(harness.lines.map((line) => (JSON.parse(line) as { id: unknown }).id)).toEqual([0, 1, 2]);
  expect(harness.restarts).toBe(1);
});

test('a rebuild while a request is in flight waits until nothing is in flight', async () => {
  const harness = start();
  const first = await harness.call(1, 'tools/call');
  harness.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hold' }));
  await harness.reached(first.pid, 2);
  harness.rebuild('v2');

  const during = await harness.call(3, 'tools/call');
  harness.write(JSON.stringify({ jsonrpc: '2.0', method: 'release' }));
  const held = (await harness.response(2)).result as Result;
  const after = await harness.call(4, 'tools/call');

  expect(during).toMatchObject({ version: 'v1', pid: first.pid });
  expect(held).toMatchObject({ version: 'v1', pid: first.pid, method: 'hold' });
  expect(after.version).toBe('v2');
  expect(harness.restarts).toBe(1);
});

test('a request the client cancelled no longer blocks a reload', async () => {
  const harness = start();
  const first = await harness.call(1, 'tools/call');
  harness.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hang' }));
  harness.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 2 },
    }),
  );
  await harness.reached(first.pid, 3);
  harness.rebuild('v2');

  const after = await harness.call(3, 'tools/call');

  expect(after.version).toBe('v2');
  expect(after.pid).not.toBe(first.pid);
  expect(harness.restarts).toBe(1);
});

test('without an initialize (modern opening) a restart replays nothing', async () => {
  const harness = start();
  const before = await harness.call(1, 'tools/call');
  harness.rebuild('v2');
  const after = await harness.call(2, 'tools/call');

  expect(after.version).toBe('v2');
  expect(after.pid).not.toBe(before.pid);
  expect(harness.received(after.pid)).toEqual([
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }),
  ]);
});

test('a child that exits answers its open requests with an error, and the next call starts one', async () => {
  const harness = start();
  const first = await harness.call(1, 'tools/call');
  harness.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hang' }));

  const crashed = await harness.request(3, 'exit');
  const next = await harness.call(4, 'tools/call');

  const failed = harness.lines
    .map((line) => JSON.parse(line) as { id: unknown; error?: { code: number; message: string } })
    .filter(({ error }) => error !== undefined);
  expect(failed.map(({ id }) => id).sort()).toEqual([2, 3]);
  expect(crashed.error).toEqual({
    code: -32603,
    message:
      "The sevdesk-mcp server exited (3) before answering; see the client's MCP log. The next call starts it again.",
  });
  expect(next.version).toBe('v1');
  expect(next.pid).not.toBe(first.pid);
  // Starting after a crash is no reload.
  expect(harness.restarts).toBe(0);
});

test('the end of input ends the child and settles; each reload is reported once', async () => {
  const harness = start();
  await harness.call(1, 'tools/call');
  harness.rebuild('v2');
  await harness.call(2, 'tools/call');
  harness.rebuild('v3');
  const last = await harness.call(3, 'tools/call');

  await harness.end();

  expect(last.version).toBe('v3');
  expect(harness.restarts).toBe(2);
  expect(() => process.kill(last.pid, 0)).toThrow();
});
