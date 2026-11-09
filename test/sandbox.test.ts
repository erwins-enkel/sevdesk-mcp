import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { expect, test } from 'vitest';
import {
  DEFAULT_LIMITS,
  type HostFunction,
  HostError,
  runSnippet,
  type SnippetError,
} from '../src/sandbox.ts';

const shortTimeout = { ...DEFAULT_LIMITS, timeoutMs: 200 };

/** The global names a plain QuickJS context has before the sandbox adds anything. */
async function bareGlobalNames(): Promise<string[]> {
  const variant = import('@jitl/quickjs-wasmfile-release-sync');
  const vm = (await newQuickJSWASMModuleFromVariant(variant)).newContext();
  const names = vm.unwrapResult(vm.evalCode('Object.getOwnPropertyNames(globalThis)'));
  const list = vm.dump(names) as string[];
  names.dispose();
  vm.dispose();
  return list;
}

test('only the provided globals and console are added to a plain QuickJS context', async () => {
  const outcome = await runSnippet('return Object.getOwnPropertyNames(globalThis)', {
    data: '{"a":1}',
  });

  expect(outcome.ok).toBe(true);
  const names = JSON.parse(outcome.ok ? (outcome.json ?? '[]') : '[]') as string[];
  const bare = await bareGlobalNames();
  expect(names.filter((name) => !bare.includes(name)).sort()).toEqual(['console', 'data']);
});

test('the code cannot reach the file system, environment, network or process', async () => {
  const hostApis = [
    'process',
    'require',
    'module',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'setTimeout',
    'Buffer',
    'std',
    'os',
    'Deno',
    'Bun',
  ];
  const outcome = await runSnippet(
    `const types = ${JSON.stringify(hostApis)}.map((name) => typeof globalThis[name]);
     let imported;
     try { await import('fs'); imported = 'imported'; } catch { imported = 'blocked'; }
     return { types, imported, viaFunction: typeof Function('return this')().process };`,
    {},
  );

  expect(outcome).toMatchObject({
    ok: true,
    json: JSON.stringify({
      types: hostApis.map(() => 'undefined'),
      imported: 'blocked',
      viaFunction: 'undefined',
    }),
  });
});

test('a runaway loop is stopped at the time limit, even inside try/catch', async () => {
  const outcome = await runSnippet(
    'for (;;) { try { while (true) {} } catch { /* swallow */ } }',
    {},
    shortTimeout,
  );

  expect(outcome).toMatchObject({
    ok: false,
    error: {
      kind: 'timeout',
      message: 'The code ran longer than the 0.2 s limit.',
      hint: expect.any(String) as string,
    },
  });
});

test('deep recursion fails as a snippet error and the next run still works', async () => {
  const recursion = await runSnippet('function f() { return f() } return f()', {});
  // Parser recursion can overflow the host's stack before QuickJS notices.
  const nesting = await runSnippet('return eval("(".repeat(1e5) + "1" + ")".repeat(1e5))', {});
  const next = await runSnippet('return 40 + 2', {});

  expect(recursion).toMatchObject({ ok: false, error: { kind: 'snippet_error' } });
  expect(nesting).toMatchObject({ ok: false, error: { kind: 'snippet_error' } });
  expect(next).toMatchObject({ ok: true, json: '42' });
});

test('a promise that never settles is an error, not a silent success', async () => {
  const outcome = await runSnippet('await new Promise(() => {})', {});

  expect(outcome).toMatchObject({
    ok: false,
    error: { kind: 'snippet_error', message: 'The code awaited a promise that never settles.' },
  });
});

test('console.log is captured and cut at the output limit', async () => {
  const logged = await runSnippet('console.log("a", 1, { b: [2] }, null); console.log("c")', {});
  const flood = await runSnippet(
    'for (let i = 0; i < 100; i++) console.log("x".repeat(100))',
    {},
    {
      ...DEFAULT_LIMITS,
      outputChars: 250,
    },
  );

  expect(logged).toMatchObject({ console: ['a 1 {"b":[2]} null', 'c'], consoleCut: false });
  // Line breaks count toward the limit, so empty lines cannot pile up without bound.
  expect(flood.console.join('\n')).toHaveLength(250);
  expect(flood.consoleCut).toBe(true);
});

test('only Error instances render as "Name: message"; objects with a message key stay data', async () => {
  const logged = await runSnippet(
    'console.log({ message: "hi", code: 1 }, new RangeError("r"), { name: "X", message: { a: 1 } })',
    {},
  );
  const thrownObject = await runSnippet('throw { message: "not an Error" }', {});
  // The check uses the VM's own Error, captured before the code ran.
  const reassigned = await runSnippet(
    'globalThis.Error = function () {}; throw new TypeError("t")',
    {},
  );

  expect(logged.console).toEqual([
    '{"message":"hi","code":1} RangeError: r {"name":"X","message":{"a":1}}',
  ]);
  expect(thrownObject).toMatchObject({
    ok: false,
    error: { kind: 'snippet_error', message: '{"message":"not an Error"}' },
  });
  expect(reassigned).toMatchObject({
    ok: false,
    error: { kind: 'snippet_error', message: 'TypeError: t' },
  });
});

const notFound: SnippetError = {
  kind: 'api_error',
  message: 'GET /x returned HTTP 404.',
  status: 404,
  method: 'GET',
  path: '/x',
};
const stop: SnippetError = { kind: 'call_budget', message: 'Too many calls.' };

/** Runs `code` with `get` as the host function `api.get`. */
function runWithApi(code: string, get: HostFunction, limits = DEFAULT_LIMITS) {
  return runSnippet(code, {}, limits, { api: { get } });
}

test('a host object is the only global added besides console and the provided ones', async () => {
  const outcome = await runWithApi('return Object.getOwnPropertyNames(globalThis)', () =>
    Promise.resolve(),
  );

  const names = JSON.parse(outcome.ok ? (outcome.json ?? '[]') : '[]') as string[];
  const bare = await bareGlobalNames();
  expect(names.filter((name) => !bare.includes(name)).sort()).toEqual(['api', 'console']);
});

test('a host function gets the arguments as JSON values and its result reaches the code', async () => {
  const seen: unknown[][] = [];
  const outcome = await runWithApi(
    'const first = await api.get("/x", { query: { a: 1 } }); const none = await api.get(); return { first, none }',
    (args) => {
      seen.push(args);
      return Promise.resolve(seen.length === 1 ? { objects: [1, 2] } : undefined);
    },
  );

  expect(seen).toEqual([['/x', { query: { a: 1 } }], []]);
  expect(outcome).toMatchObject({ ok: true, json: JSON.stringify({ first: { objects: [1, 2] } }) });
});

test('a HostError is catchable with its fields and, uncaught or rethrown, ends the run as it is', async () => {
  const rejects: HostFunction = () => Promise.reject(new HostError(notFound));
  const throwsAtOnce: HostFunction = () => {
    throw new HostError(notFound);
  };
  const catchIt =
    'try { await api.get() } catch (e) { return [e instanceof Error, e.message, e.kind, e.status, e.method, e.path, "hint" in e] }';

  const caught = await runWithApi(catchIt, rejects);
  const caughtAtOnce = await runWithApi(catchIt, throwsAtOnce);
  const uncaught = await runWithApi('console.log("before"); await api.get()', rejects);
  const rethrown = await runWithApi(
    'try { await api.get() } catch (e) { e.message = "changed"; throw e }',
    rejects,
  );
  const wrapped = await runWithApi(
    'try { await api.get() } catch (e) { throw new Error("wrapped: " + e.message) }',
    rejects,
  );

  const fields = JSON.stringify([true, notFound.message, 'api_error', 404, 'GET', '/x', false]);
  expect(caught).toMatchObject({ ok: true, json: fields });
  expect(caughtAtOnce).toMatchObject({ ok: true, json: fields });
  expect(uncaught).toEqual({ ok: false, error: notFound, console: ['before'], consoleCut: false });
  expect(rethrown).toMatchObject({ ok: false, error: notFound });
  expect(wrapped).toMatchObject({
    ok: false,
    error: { kind: 'snippet_error', message: `Error: wrapped: ${notFound.message}` },
  });
});

test('a fatal HostError ends the run even when caught and starts no further host calls', async () => {
  let started = 0;
  const thirdIsFatal: HostFunction = () => {
    started += 1;
    if (started === 3) throw new HostError(stop, true);
    return Promise.resolve(started);
  };

  const awaited = await runWithApi(
    'for (let i = 0; i < 5; i++) { try { await api.get() } catch { /* swallow */ } } return "done"',
    thirdIsFatal,
  );
  const startedAwaited = started;
  started = 0;
  const unawaited = await runWithApi(
    'for (let i = 0; i < 5; i++) api.get(); return "done"',
    thirdIsFatal,
  );
  const rejected = await runWithApi(
    'try { await api.get() } catch { /* swallow */ } return "done"',
    () => Promise.reject(new HostError(stop, true)),
  );

  expect(awaited).toMatchObject({ ok: false, error: stop });
  expect(startedAwaited).toBe(3);
  expect(unawaited).toMatchObject({ ok: false, error: stop });
  expect(started).toBe(3);
  expect(rejected).toMatchObject({ ok: false, error: stop });
});

test('a host call still pending at the time limit ends the run as a timeout and is aborted', async () => {
  const signals: AbortSignal[] = [];
  const outcome = await runWithApi(
    'await api.get()',
    (_args, signal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    },
    shortTimeout,
  );

  expect(outcome).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('a host call the code never awaited is aborted when the run ends', async () => {
  const signals: AbortSignal[] = [];
  const outcome = await runWithApi('api.get(); return 1', (_args, signal) => {
    signals.push(signal);
    return new Promise(() => undefined);
  });

  expect(outcome).toMatchObject({ ok: true, json: '1' });
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('an error other than HostError from a host function is a host bug and is rethrown', async () => {
  await expect(
    runWithApi('await api.get()', () => Promise.reject(new TypeError('bug'))),
  ).rejects.toThrow('bug');
});
