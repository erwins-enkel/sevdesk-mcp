// Applies the patch file (spec/patches.json), which corrects known errors and omissions of the
// official sevDesk spec, to the upstream document before its `$ref`s are resolved, so a corrected
// component reaches every place that uses it. Fails closed: every change names the exact upstream
// value it expects, so a patch that no longer applies (sevDesk fixed, changed or moved the spot)
// throws and names the patch instead of being applied twice or skipped silently.
import { isDeepStrictEqual } from 'node:util';
import type { Json } from './resolve-refs.ts';

/**
 * One change of a patch: the value at `path` (a JSON Pointer) goes from `from` to `to`. Without
 * `from` nothing may be there yet; without `to` the value is removed.
 */
interface Change {
  path: string;
  from?: Json;
  to?: Json;
}

/** A patch: why the spec is wrong there (with the evidence) and the changes that correct it. */
interface Patch {
  why: string;
  changes: Change[];
}

type Container = Json[] | Record<string, Json>;
type Fail = (problem: string) => Error;

// What a pointer finds where there is no value.
const NOTHING = Symbol('nothing');
type Found = Json | typeof NOTHING;

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContainer(value: Found): value is Container {
  return value !== null && typeof value === 'object';
}

function unknownKeys(record: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(record).filter((key) => !allowed.includes(key));
}

function readChange(change: unknown, fail: Fail): Change {
  if (!isRecord(change)) throw fail('a change must be an object');
  const extra = unknownKeys(change, ['path', 'from', 'to']);
  if (extra.length > 0) throw fail(`a change has the unknown key ${extra.join(', ')}`);
  if (typeof change.path !== 'string' || !change.path.startsWith('/')) {
    throw fail('a change needs a path, a JSON Pointer starting with /');
  }
  if (!Object.hasOwn(change, 'from') && !Object.hasOwn(change, 'to')) {
    throw fail(`the change at ${change.path} needs from, to or both`);
  }
  return change as unknown as Change;
}

/** The patch file's content as patches; anything else in it fails and names the patch. */
function readPatches(patches: unknown): Patch[] {
  if (!Array.isArray(patches)) throw new Error('The spec patches must be an array of patches.');
  return patches.map((patch: unknown, index) => {
    const fail: Fail = (problem) =>
      new Error(`spec patch ${String(index + 1)} is invalid: ${problem}.`);
    if (!isRecord(patch)) throw fail('a patch must be an object');
    const extra = unknownKeys(patch, ['why', 'changes']);
    if (extra.length > 0) throw fail(`it has the unknown key ${extra.join(', ')}`);
    if (typeof patch.why !== 'string' || patch.why.trim() === '') {
      throw fail('why must say what it corrects');
    }
    if (!Array.isArray(patch.changes) || patch.changes.length === 0) {
      throw fail('changes must be a non-empty array');
    }
    return {
      why: patch.why,
      changes: patch.changes.map((change: unknown) => readChange(change, fail)),
    };
  });
}

/** The pointer's reference tokens, unescaped. */
function tokens(path: string): string[] {
  return path
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function isRef(node: Container): boolean {
  return !Array.isArray(node) && Object.hasOwn(node, '$ref');
}

function entry(node: Container, token: string): Found {
  if (!Array.isArray(node)) return Object.hasOwn(node, token) ? (node[token] as Json) : NOTHING;
  return ARRAY_INDEX.test(token) && Number(token) < node.length
    ? (node[Number(token)] as Json)
    : NOTHING;
}

/**
 * The object or array that holds the change's target. A `$ref` on the way fails: `resolveRefs`
 * drops a `$ref`'s siblings, so a change there would vanish; patch the referenced component.
 */
function parentOf(document: Json, path: string[], fail: Fail): Container {
  let node: Found = document;
  for (const token of path) {
    if (!isContainer(node)) break;
    if (isRef(node)) throw fail('it runs through a $ref; patch the referenced component instead');
    node = entry(node, token);
  }
  if (!isContainer(node)) throw fail('its parent does not exist');
  if (isRef(node)) throw fail('it runs through a $ref; patch the referenced component instead');
  return node;
}

/** The array index a token names: an existing entry or the end, where an entry can be appended. */
function arrayIndex(array: Json[], token: string, fail: Fail): number {
  if (!ARRAY_INDEX.test(token)) throw fail(`${token} is not an array index`);
  const index = Number(token);
  if (index > array.length) throw fail(`the array has only ${String(array.length)} entries`);
  return index;
}

function describe(found: Found): string {
  if (found === NOTHING) return 'nothing';
  const json = JSON.stringify(found);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

/** Sets or removes the target of `change` in `array`; it may only append or remove the last entry. */
function changeArray(array: Json[], index: number, change: Change, fail: Fail): void {
  if (Object.hasOwn(change, 'to')) {
    array[index] = structuredClone(change.to as Json);
    return;
  }
  if (index !== array.length - 1) throw fail('only the last entry of an array can be removed');
  array.pop();
}

/** Fails unless the change's target holds its `from` (nothing, when it has no `from`). */
function expectFrom(found: Found, change: Change, fail: Fail): void {
  const expected = Object.hasOwn(change, 'from') ? (change.from as Json) : NOTHING;
  if (!isDeepStrictEqual(found, expected)) {
    throw fail(`found ${describe(found)}, expected ${describe(expected)}`);
  }
}

function applyChange(document: Json, change: Change, fail: Fail): void {
  const path = tokens(change.path);
  const token = path.pop() ?? '';
  const parent = parentOf(document, path, fail);
  if (Array.isArray(parent)) {
    const index = arrayIndex(parent, token, fail);
    expectFrom(entry(parent, token), change, fail);
    changeArray(parent, index, change, fail);
  } else {
    expectFrom(entry(parent, token), change, fail);
    if (Object.hasOwn(change, 'to')) parent[token] = structuredClone(change.to as Json);
    else Reflect.deleteProperty(parent, token);
  }
}

/**
 * Returns a copy of `document` with every change of `patches` (the parsed patch file) applied in
 * order. Throws, naming the patch, its path and its reason, when the file is malformed or a change
 * no longer applies: the value there is not its `from`, something is there although it has no
 * `from`, its parent is gone, or its path runs through a `$ref`.
 */
export function applyPatches(document: Json, patches: unknown): Json {
  const patched = structuredClone(document);
  for (const [index, patch] of readPatches(patches).entries()) {
    for (const change of patch.changes) {
      applyChange(
        patched,
        change,
        (problem) =>
          new Error(
            `spec patch ${String(index + 1)} no longer applies at ${change.path}: ${problem}. It corrects: ${patch.why}`,
          ),
      );
    }
  }
  return patched;
}
