import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { expect, test } from 'vitest';
import { DEFAULT_LIMITS, runSnippet } from '../src/sandbox.ts';

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
  expect(flood.console.join('')).toHaveLength(250);
  expect(flood.consoleCut).toBe(true);
});
