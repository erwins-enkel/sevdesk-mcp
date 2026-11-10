import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';

/** Limits of one sandbox run (PRD §5.3). The config file overrides the defaults (`src/config.ts`). */
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

/**
 * A run that ended in an error, in the error shape of the tool results (decision 11). The sandbox
 * raises `timeout`, `memory_limit` and `snippet_error`; host functions raise their own kinds.
 */
export interface SnippetError {
  kind: string;
  message: string;
  status?: number;
  method?: string;
  path?: string;
  sevdeskMessage?: string;
  hint?: string;
}

/**
 * What a host function throws or rejects with. Inside the snippet it is an `Error` with `message`
 * and the other fields of `error` as properties; uncaught, the run ends with `error` as it is. A
 * `fatal` one ends the run at once and cannot be caught.
 */
export class HostError extends Error {
  readonly error: SnippetError;
  readonly fatal: boolean;

  constructor(error: SnippetError, fatal = false) {
    super(error.message);
    this.error = error;
    this.fatal = fatal;
  }
}

/**
 * A function the code can call. It gets the code's arguments as JSON values and a signal that
 * aborts when the run ends, and returns a promise of a JSON value. It may throw a `HostError`
 * right away (a fatal one then stops the code at once) or reject with one.
 */
export type HostFunction = (args: unknown[], signal: AbortSignal) => Promise<unknown>;

/** Host functions by global object, e.g. `{ sevdesk: { request } }` for `sevdesk.request`. */
export type Host = Record<string, Record<string, HostFunction>>;

/** What a run produced: the return value as JSON text (`undefined` when there is none) or an error. */
export type SandboxOutcome = { console: string[]; consoleCut: boolean } & (
  { ok: true; json: string | undefined } | { ok: false; error: SnippetError }
);

type Completion =
  | { ok: true; json: string | undefined }
  | { ok: false; message: string }
  | { ok: false; error: SnippetError };
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

/**
 * Sets `console.log` (a capture) and each entry of `globals` (parsed from JSON text) on `vm`.
 * Returns the VM's `JSON.parse`, captured before the code runs.
 */
function installGlobals(
  vm: QuickJSContext,
  globals: Record<string, string>,
  capture: ReturnType<typeof consoleCapture>,
  keep: Keep,
  render: Render,
): QuickJSHandle {
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
  return parse;
}

type Settlement = { ok: true; value: unknown } | { ok: false; error: unknown };

/** One call of a host function by the code. */
interface HostCall {
  /** The promise the code got back. */
  deferred: QuickJSDeferredPromise;
  /** Resolves once `settlement` is set; never rejects. */
  done: Promise<void>;
  settlement?: Settlement;
  /** Whether the settlement was handed to the code (or ended the run). */
  delivered: boolean;
}

/** The host side of one run: its host calls, the errors thrown into the code, a fatal stop. */
interface HostCalls {
  list: HostCall[];
  /** Each `HostError` thrown into the code, to recognise it when it ends the run uncaught. */
  thrown: { handle: QuickJSHandle; error: SnippetError }[];
  /** Set by a fatal `HostError`: the run ends with it. */
  stopped: SnippetError | undefined;
  /** Aborts when the run ends. */
  signal: AbortSignal;
}

/** Records a call by the code and starts its host function; a fatal error stops the run at once. */
function startCall(
  vm: QuickJSContext,
  calls: HostCalls,
  fn: HostFunction,
  args: unknown[],
): HostCall {
  const call: HostCall = { deferred: vm.newPromise(), done: Promise.resolve(), delivered: false };
  calls.list.push(call);
  // After a fatal error the code runs only until the interrupt handler stops it: start nothing.
  if (calls.stopped) return call;
  try {
    call.done = fn(args, calls.signal).then(
      (value) => {
        call.settlement = { ok: true, value };
      },
      (error: unknown) => {
        call.settlement = { ok: false, error };
      },
    );
  } catch (error) {
    if (error instanceof HostError && error.fatal) calls.stopped ??= error.error;
    call.settlement = { ok: false, error };
  }
  return call;
}

/** Sets each object of `host` on `vm`, with its host functions as methods returning promises. */
function installHost(vm: QuickJSContext, host: Host, calls: HostCalls, keep: Keep): void {
  for (const [objectName, functions] of Object.entries(host)) {
    const object = keep(vm.newObject());
    for (const [name, fn] of Object.entries(functions)) {
      const method = vm.newFunction(name, (...args) => {
        const call = startCall(
          vm,
          calls,
          fn,
          args.map((arg) => vm.dump(arg) as unknown),
        );
        return call.deferred.handle;
      });
      vm.setProp(object, name, keep(method));
    }
    vm.setProp(vm.global, objectName, object);
  }
}

/** Creates the code's `Error` for a `HostError`: `message` plus the other fields as properties. */
function newHostError(vm: QuickJSContext, error: SnippetError, keep: Keep): QuickJSHandle {
  const handle = keep(vm.newError(error.message));
  for (const [key, value] of Object.entries(error)) {
    if (key === 'message' || value === undefined) continue;
    vm.setProp(
      handle,
      key,
      keep(typeof value === 'number' ? vm.newNumber(value) : vm.newString(String(value))),
    );
  }
  return handle;
}

/** What handing host results to the code needs. */
interface Delivery {
  vm: QuickJSContext;
  calls: HostCalls;
  keep: Keep;
  /** The VM's `JSON.parse`, captured before the code ran. */
  parse: QuickJSHandle;
}

/**
 * Hands a settled host call to the code: a value enters through the VM's `JSON.parse`, a
 * `HostError` as the code's `Error`. A fatal one stops the run instead; any other error is a bug
 * in the host function and is rethrown.
 */
function deliver(
  call: HostCall,
  settlement: Settlement,
  { vm, calls, keep, parse }: Delivery,
): void {
  call.delivered = true;
  if (settlement.ok) {
    if (settlement.value === undefined) {
      call.deferred.resolve();
      return;
    }
    const text = keep(vm.newString(JSON.stringify(settlement.value)));
    const parsed = vm.callFunction(parse, vm.undefined, text);
    if (parsed.error) call.deferred.reject(keep(parsed.error));
    else call.deferred.resolve(keep(parsed.value));
    return;
  }
  if (!(settlement.error instanceof HostError)) throw settlement.error;
  if (settlement.error.fatal) {
    calls.stopped ??= settlement.error.error;
    return;
  }
  const handle = newHostError(vm, settlement.error.error, keep);
  calls.thrown.push({ handle, error: settlement.error.error });
  call.deferred.reject(handle);
}

/**
 * Waits until a host call the code has not got yet settles, or the run's time is up, then hands
 * every settled call to the code. Returns false when the time is up.
 */
async function deliverNext(
  waiting: HostCall[],
  delivery: Delivery,
  expired: Promise<void>,
): Promise<boolean> {
  const woke = await Promise.race([
    Promise.race(waiting.map((call) => call.done)).then(() => 'settled' as const),
    expired.then(() => 'expired' as const),
  ]);
  if (woke === 'expired') return false;
  for (const call of waiting) {
    if (call.settlement !== undefined) deliver(call, call.settlement, delivery);
  }
  return true;
}

/** Compiles `code` as the body of an async function and calls it: its promise, or the error. */
function start(
  vm: QuickJSContext,
  code: string,
  keep: Keep,
): { promise: QuickJSHandle } | { error: QuickJSHandle } {
  // The VM's AsyncFunction constructor compiles the code as a function body, so `return` and
  // `await` work. Whatever the code does, it stays inside the VM.
  const asyncFunction = keep(vm.unwrapResult(vm.evalCode('(async () => {}).constructor')));
  const compiled = vm.callFunction(asyncFunction, vm.undefined, keep(vm.newString(code)));
  if (compiled.error) return { error: compiled.error };
  const called = vm.callFunction(keep(compiled.value), vm.undefined);
  if (called.error) return { error: called.error };
  return { promise: keep(called.value) };
}

/**
 * The completion of the code's promise, or undefined while it is pending. An uncaught `HostError`
 * ends the run with its host-side error, so a rethrown API error keeps the agreed shape.
 */
function settle(
  promise: QuickJSHandle,
  { vm, calls, keep }: Delivery,
  fail: (error: QuickJSHandle) => Completion,
): Completion | undefined {
  const state = vm.getPromiseState(promise);
  if (state.type === 'pending') return undefined;
  if (state.type === 'fulfilled') return stringify(vm, keep(state.value), keep, fail);
  const error = keep(state.error);
  const thrown = calls.thrown.find(({ handle }) => vm.sameValue(handle, error));
  return thrown ? { ok: false, error: thrown.error } : fail(error);
}

/**
 * Runs `code` as the body of an async function in `vm` and returns its value as JSON text. While
 * the code awaits host calls, their results are handed to it as they settle, until `expired`.
 */
async function evaluate(
  code: string,
  render: Render,
  delivery: Delivery,
  expired: Promise<void>,
): Promise<Completion> {
  const { vm, calls, keep } = delivery;
  // A fatal host error ends the run, whatever the code did after it. Host calls set it while the
  // VM runs, behind the compiler's narrowing, so it is read through a function.
  const stopped = (): Completion | undefined =>
    calls.stopped && { ok: false, error: calls.stopped };
  const fail = (error: QuickJSHandle): Completion => {
    keep(error);
    return stopped() ?? { ok: false, message: render(error) };
  };

  const started = start(vm, code, keep);
  if ('error' in started) return fail(started.error);
  for (;;) {
    const jobs = vm.runtime.executePendingJobs();
    if (jobs.error) return fail(jobs.error);
    const completion = stopped() ?? settle(started.promise, delivery, fail);
    if (completion) return completion;
    const waiting = calls.list.filter((call) => !call.delivered);
    if (waiting.length === 0) {
      return { ok: false, message: 'The code awaited a promise that never settles.' };
    }
    // QuickJS reports an interrupted run this way; with the time up it becomes the timeout error.
    if (!(await deliverNext(waiting, delivery, expired))) {
      return { ok: false, message: 'InternalError: interrupted' };
    }
  }
}

/** The code's return value as JSON text (`undefined` when JSON cannot represent it). */
function stringify(
  vm: QuickJSContext,
  value: QuickJSHandle,
  keep: Keep,
  fail: (error: QuickJSHandle) => Completion,
): Completion {
  const json = keep(vm.getProp(vm.global, 'JSON'));
  const jsonStringify = keep(vm.getProp(json, 'stringify'));
  const stringified = vm.callFunction(jsonStringify, vm.undefined, value);
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
 * from JSON text), the objects of `host` with their host functions, and `console.log`; there is no
 * file system, environment, network or `process` besides what a host function does. Only the
 * return value (as JSON text) and the captured console output come back.
 */
export async function runSnippet(
  code: string,
  globals: Record<string, string>,
  limits: SandboxLimits = DEFAULT_LIMITS,
  host: Host = {},
): Promise<SandboxOutcome> {
  // A fresh WebAssembly module per run (~2 ms): nothing leaks between runs, and a module left
  // corrupt by a host stack overflow is simply dropped.
  const module = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(STACK_BYTES);
  const controller = new AbortController();
  const calls: HostCalls = { list: [], thrown: [], stopped: undefined, signal: controller.signal };
  const deadline = Date.now() + limits.timeoutMs;
  let timedOut = false;
  runtime.setInterruptHandler(
    () => (timedOut ||= Date.now() >= deadline) || calls.stopped !== undefined,
  );
  // The interrupt handler only runs while the code does; a timer ends a wait on host calls.
  const expiry = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    timedOut = true;
    expiry.resolve(undefined);
  }, limits.timeoutMs);
  const vm = runtime.newContext();
  const capture = consoleCapture(limits.outputChars);
  const handles: QuickJSHandle[] = [];
  const keep: Keep = (handle) => (handles.push(handle), handle);

  let completion: Completion;
  let corrupt = false;
  try {
    const render = renderer(vm, keep);
    const parse = installGlobals(vm, globals, capture, keep, render);
    installHost(vm, host, calls, keep);
    completion = await evaluate(code, render, { vm, calls, keep, parse }, expiry.promise);
  } catch (error) {
    // Recursion inside the VM's C code (e.g. the parser) can overflow the host's stack before
    // QuickJS notices. The module is corrupt then and disposing it would abort: drop it as is.
    if (!(error instanceof RangeError)) throw error;
    completion = { ok: false, message: `${error.name}: ${error.message}` };
    corrupt = true;
  } finally {
    clearTimeout(timer);
    // Host calls still in flight (never awaited, or cut off by the end of the run) are cancelled.
    controller.abort();
  }
  if (!corrupt) {
    for (const call of calls.list) call.deferred.dispose();
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    vm.dispose();
    runtime.dispose();
  }

  const output = { console: capture.lines, consoleCut: capture.isCut() };
  if (completion.ok) return { ...output, ok: true, json: completion.json };
  const error =
    'error' in completion ? completion.error : toSnippetError(completion.message, timedOut, limits);
  return { ...output, ok: false, error };
}
