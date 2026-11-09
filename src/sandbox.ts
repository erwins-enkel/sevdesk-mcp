import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';

/** Limits of one sandbox run (PRD §5.3). The config file will override the defaults. */
export interface SandboxLimits {
  /** Wall-clock budget of the run. */
  timeoutMs: number;
  /** Memory limit of the QuickJS runtime. */
  memoryBytes: number;
  /** Characters of console output kept (line breaks included) and of the return value shown. */
  outputChars: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  outputChars: 20_000,
};

// The QuickJS build (release, sync). Imported dynamically because, under `nodenext`, the package's
// CommonJS typings mistype a static default import; the promise form is what the loader expects.
const variant = import('@jitl/quickjs-wasmfile-release-sync');

// QuickJS's own stack limit. Recursion deeper than this fails inside QuickJS as a clean
// "stack overflow"; with a larger limit the host's stack overflows first (see runSnippet).
const STACK_BYTES = 128 * 1024;

/** A run that ended in an error, in the `{ kind, message, hint? }` shape of the tool results. */
export interface SnippetError {
  kind: 'timeout' | 'memory_limit' | 'snippet_error';
  message: string;
  hint?: string;
}

/** What a run produced: the return value as JSON text (`undefined` when there is none) or an error. */
export type SandboxOutcome = { console: string[]; consoleCut: boolean } & (
  { ok: true; json: string | undefined } | { ok: false; error: SnippetError }
);

type Completion = { ok: true; json: string | undefined } | { ok: false; message: string };
type Keep = (handle: QuickJSHandle) => QuickJSHandle;
type Render = (handle: QuickJSHandle) => string;

/**
 * Collects `console.log` lines up to `limit` characters in total, each line break counting as one
 * (so empty lines cannot pile up without bound); the rest is cut.
 */
function consoleCapture(limit: number) {
  const lines: string[] = [];
  let used = 0;
  let cut = false;
  return {
    lines,
    isCut: () => cut,
    add(line: string) {
      if (used + line.length + 1 <= limit) {
        lines.push(line);
        used += line.length + 1;
        return;
      }
      if (used < limit) lines.push(line.slice(0, limit - used));
      used = limit;
      cut = true;
    },
  };
}

/**
 * Returns how console output and error messages show a VM value: a string as it is, an `Error`
 * instance as `Name: message`, anything else as JSON. Whether a value is an `Error` is decided
 * inside the VM, never by its keys, so a plain object with a `message` stays data.
 */
function renderer(vm: QuickJSContext, keep: Keep): Render {
  // Captures the VM's own Error before the code runs, so reassigning the global changes nothing.
  const isError = keep(
    vm.unwrapResult(vm.evalCode('((E) => (value) => value instanceof E)(Error)')),
  );
  return (handle) => {
    if (vm.typeof(handle) === 'string') return vm.getString(handle);
    const check = vm.callFunction(isError, vm.undefined, handle);
    let errorInstance = false;
    if (check.error) {
      check.error.dispose();
    } else {
      errorInstance = vm.dump(check.value) === true;
      check.value.dispose();
    }
    if (errorInstance) {
      const { name, message } = vm.dump(handle) as { name: unknown; message: unknown };
      return `${String(name)}: ${String(message)}`;
    }
    const value: unknown = vm.dump(handle);
    // JSON.stringify returns undefined for undefined and functions, despite its declared type.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? String(value);
  };
}

/** Sets `console.log` (a capture) and each entry of `globals` (parsed from JSON text) on `vm`. */
function installGlobals(
  vm: QuickJSContext,
  globals: Record<string, string>,
  capture: ReturnType<typeof consoleCapture>,
  keep: Keep,
  render: Render,
): void {
  const log = keep(
    vm.newFunction('log', (...args) => {
      if (capture.isCut()) return;
      capture.add(args.map(render).join(' '));
    }),
  );
  const consoleObject = keep(vm.newObject());
  vm.setProp(consoleObject, 'log', log);
  vm.setProp(vm.global, 'console', consoleObject);

  const parse = keep(vm.getProp(keep(vm.getProp(vm.global, 'JSON')), 'parse'));
  for (const [name, text] of Object.entries(globals)) {
    const parsed = vm.callFunction(parse, vm.undefined, keep(vm.newString(text)));
    vm.setProp(vm.global, name, keep(vm.unwrapResult(parsed)));
  }
}

/** Runs `code` as the body of an async function in `vm` and returns its value as JSON text. */
function evaluate(vm: QuickJSContext, code: string, keep: Keep, render: Render): Completion {
  const fail = (error: QuickJSHandle): Completion => ({ ok: false, message: render(keep(error)) });

  // The VM's AsyncFunction constructor compiles the code as a function body, so `return` and
  // `await` work. Whatever the code does, it stays inside the VM.
  const asyncFunction = keep(vm.unwrapResult(vm.evalCode('(async () => {}).constructor')));
  const compiled = vm.callFunction(asyncFunction, vm.undefined, keep(vm.newString(code)));
  if (compiled.error) return fail(compiled.error);
  const called = vm.callFunction(keep(compiled.value), vm.undefined);
  if (called.error) return fail(called.error);
  const promise = keep(called.value);

  // Without host functions every job runs now. `execute` will await outstanding host calls here.
  const jobs = vm.runtime.executePendingJobs();
  if (jobs.error) return fail(jobs.error);
  const state = vm.getPromiseState(promise);
  if (state.type === 'pending') {
    return { ok: false, message: 'The code awaited a promise that never settles.' };
  }
  if (state.type === 'rejected') return fail(state.error);

  const json = keep(vm.getProp(vm.global, 'JSON'));
  const stringify = keep(vm.getProp(json, 'stringify'));
  const stringified = vm.callFunction(stringify, vm.undefined, keep(state.value));
  if (stringified.error) return fail(stringified.error);
  const text = keep(stringified.value);
  return { ok: true, json: vm.typeof(text) === 'string' ? vm.getString(text) : undefined };
}

function toSnippetError(message: string, timedOut: boolean, limits: SandboxLimits): SnippetError {
  if (timedOut) {
    return {
      kind: 'timeout',
      message: `The code ran longer than the ${String(limits.timeoutMs / 1000)} s limit.`,
      hint: 'Avoid endless loops and narrow the work.',
    };
  }
  if (message === 'InternalError: out of memory') {
    return {
      kind: 'memory_limit',
      message: `The code exceeded the ${String(limits.memoryBytes / 1024 / 1024)} MB memory limit.`,
      hint: 'Work on less data at once.',
    };
  }
  return { kind: 'snippet_error', message };
}

/**
 * Runs `code` in a fresh QuickJS sandbox. Its only non-standard globals are `globals` (each parsed
 * from JSON text) and `console.log`; there is no file system, environment, network or `process`.
 * Only the return value (as JSON text) and the captured console output come back.
 */
export async function runSnippet(
  code: string,
  globals: Record<string, string>,
  limits: SandboxLimits = DEFAULT_LIMITS,
): Promise<SandboxOutcome> {
  // A fresh WebAssembly module per run (~2 ms): nothing leaks between runs, and a module left
  // corrupt by a host stack overflow is simply dropped.
  const module = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(STACK_BYTES);
  const deadline = Date.now() + limits.timeoutMs;
  let timedOut = false;
  runtime.setInterruptHandler(() => (timedOut ||= Date.now() >= deadline));
  const vm = runtime.newContext();
  const capture = consoleCapture(limits.outputChars);
  const handles: QuickJSHandle[] = [];
  const keep: Keep = (handle) => (handles.push(handle), handle);

  let completion: Completion;
  let corrupt = false;
  try {
    const render = renderer(vm, keep);
    installGlobals(vm, globals, capture, keep, render);
    completion = evaluate(vm, code, keep, render);
  } catch (error) {
    // Recursion inside the VM's C code (e.g. the parser) can overflow the host's stack before
    // QuickJS notices. The module is corrupt then and disposing it would abort: drop it as is.
    if (!(error instanceof RangeError)) throw error;
    completion = { ok: false, message: `${error.name}: ${error.message}` };
    corrupt = true;
  }
  if (!corrupt) {
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    vm.dispose();
    runtime.dispose();
  }

  const output = { console: capture.lines, consoleCut: capture.isCut() };
  return completion.ok
    ? { ...output, ok: true, json: completion.json }
    : { ...output, ok: false, error: toSnippetError(completion.message, timedOut, limits) };
}
