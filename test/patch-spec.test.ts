import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { applyPatches } from '../scripts/patch-spec.ts';
import { resolveRefs, type Json } from '../scripts/resolve-refs.ts';

interface Change {
  path: string;
  from?: Json;
  to?: Json;
}

const read = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));

/** A small upstream document in the shape of the sevDesk spec, before `$ref` resolution. */
function upstream() {
  return {
    paths: {
      '/Order/{orderId}': { get: { parameters: [{ name: 'orderId' }] } },
      '/Order/Factory/saveOrder': {
        post: { schema: { $ref: '#/components/schemas/saveOrder' } },
      },
    },
    components: {
      schemas: {
        saveOrder: {
          required: ['order', 'orderPos'],
          properties: { orderPosSave: { type: 'array' }, legacy: { type: 'string' } },
        },
      },
    },
  };
}

test('applies replacements, additions, appends and removals, leaving the input as it was', () => {
  const document = upstream();
  const before = structuredClone(document);

  const patched = applyPatches(document, [
    {
      why: 'required names a property that does not exist',
      changes: [
        {
          path: '/components/schemas/saveOrder/required',
          from: ['order', 'orderPos'],
          to: ['order', 'orderPosSave'],
        },
        { path: '/components/schemas/saveOrder/required/2', to: 'mapAll' },
      ],
    },
    {
      why: 'a property is missing and another is gone',
      changes: [
        { path: '/components/schemas/saveOrder/properties/order', to: { type: 'object' } },
        { path: '/components/schemas/saveOrder/properties/legacy', from: { type: 'string' } },
      ],
    },
    {
      why: 'the last parameter is wrong',
      changes: [{ path: '/paths/~1Order~1{orderId}/get/parameters/0', from: { name: 'orderId' } }],
    },
  ]);

  expect(patched).toEqual({
    paths: {
      '/Order/{orderId}': { get: { parameters: [] } },
      '/Order/Factory/saveOrder': {
        post: { schema: { $ref: '#/components/schemas/saveOrder' } },
      },
    },
    components: {
      schemas: {
        saveOrder: {
          required: ['order', 'orderPosSave', 'mapAll'],
          properties: { orderPosSave: { type: 'array' }, order: { type: 'object' } },
        },
      },
    },
  });
  expect(document).toEqual(before);
});

test.each([
  {
    case: 'the upstream value is no longer the one the patch corrects',
    change: {
      path: '/components/schemas/saveOrder/required',
      from: ['order', 'orderPosSave'],
      to: ['order'],
    },
    message:
      'at /components/schemas/saveOrder/required: found ["order","orderPos"], expected ["order","orderPosSave"]',
  },
  {
    case: 'the upstream already has what the patch adds',
    change: { path: '/components/schemas/saveOrder/properties/orderPosSave', to: { type: 'x' } },
    message:
      'at /components/schemas/saveOrder/properties/orderPosSave: found {"type":"array"}, expected nothing',
  },
  {
    case: 'the upstream no longer has what the patch removes',
    change: { path: '/components/schemas/saveOrder/properties/gone', from: { type: 'string' } },
    message:
      'at /components/schemas/saveOrder/properties/gone: found nothing, expected {"type":"string"}',
  },
  {
    case: 'the parent of the target is gone',
    change: { path: '/components/schemas/Gone/required', to: ['order'] },
    message: 'at /components/schemas/Gone/required: its parent does not exist',
  },
  {
    case: 'an array index past the end',
    change: { path: '/paths/~1Order~1{orderId}/get/parameters/2', to: { name: 'q' } },
    message: 'at /paths/~1Order~1{orderId}/get/parameters/2: the array has only 1 entries',
  },
  {
    case: 'an array entry that is not the last is removed',
    change: { path: '/components/schemas/saveOrder/required/0', from: 'order' },
    message: 'at /components/schemas/saveOrder/required/0: only the last entry of an array',
  },
  {
    case: 'the path runs through a $ref',
    change: { path: '/paths/~1Order~1Factory~1saveOrder/post/schema/required', to: ['order'] },
    message:
      'at /paths/~1Order~1Factory~1saveOrder/post/schema/required: it runs through a $ref; patch the referenced component instead',
  },
])('fails, naming the patch, when $case', ({ change, message }) => {
  const patches = [
    {
      why: 'a first patch that applies',
      changes: [{ path: '/components/schemas/saveOrder/properties/order', to: {} }],
    },
    { why: 'the patch under test', changes: [change] },
  ];

  expect(() => applyPatches(upstream(), patches)).toThrow(
    `spec patch 2 no longer applies ${message}`,
  );
  expect(() => applyPatches(upstream(), patches)).toThrow('It corrects: the patch under test');
});

test.each([
  { case: 'not an array', patches: {}, message: 'The spec patches must be an array of patches.' },
  {
    case: 'a patch without why',
    patches: [{ changes: [{ path: '/a', to: 1 }] }],
    message: 'spec patch 1 is invalid: why must say what it corrects.',
  },
  {
    case: 'a patch without changes',
    patches: [{ why: 'x', changes: [] }],
    message: 'spec patch 1 is invalid: changes must be a non-empty array.',
  },
  {
    case: 'a patch with an unknown key',
    patches: [{ why: 'x', changes: [{ path: '/a', to: 1 }], op: 'add' }],
    message: 'spec patch 1 is invalid: it has the unknown key op.',
  },
  {
    case: 'a change without from and to',
    patches: [{ why: 'x', changes: [{ path: '/a' }] }],
    message: 'spec patch 1 is invalid: the change at /a needs from, to or both.',
  },
  {
    case: 'a change whose path is not a pointer',
    patches: [{ why: 'x', changes: [{ path: 'a/b', to: 1 }] }],
    message: 'spec patch 1 is invalid: a change needs a path, a JSON Pointer starting with /.',
  },
  {
    case: 'a change with an unknown key',
    patches: [{ why: 'x', changes: [{ path: '/a', value: 1 }] }],
    message: 'spec patch 1 is invalid: a change has the unknown key value.',
  },
])('rejects a malformed patch file: $case', ({ patches, message }) => {
  expect(() => applyPatches(upstream(), patches)).toThrow(message);
});

test('the embedded spec has every change of spec/patches.json in effect', () => {
  const spec = read('../spec/sevdesk-openapi.json') as { components: Json };
  const patches = read('../spec/patches.json') as { why: string; changes: Change[] }[];
  // The inverse patch, last change first: it expects each change's `to` and restores its `from`.
  // The embedded spec holds `to` with its `$ref`s resolved, so the inverse is resolved the same way.
  const draft = patches.toReversed().map(({ why, changes }) => ({
    why,
    changes: changes.toReversed().map(({ path, from, to }) => ({
      path,
      ...(to === undefined ? {} : { from: to }),
      ...(from === undefined ? {} : { to: from }),
    })),
  }));
  const { inverse } = resolveRefs({ components: spec.components, inverse: draft as Json }) as {
    inverse: Json;
  };

  expect(patches.length).toBeGreaterThan(0);
  expect(() => applyPatches(spec as Json, inverse)).not.toThrow();
});
