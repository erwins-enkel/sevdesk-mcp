import { expect, test } from 'vitest';
import { resolveRefs } from '../scripts/resolve-refs.ts';

test('inlines nested local refs, including escaped pointer segments', () => {
  const document = {
    paths: { '/a': { schema: { $ref: '#/components/schemas/Outer' } } },
    components: {
      schemas: {
        Outer: { type: 'object', properties: { inner: { $ref: '#/components/schemas/In~1ner' } } },
        'In/ner': { type: 'string' },
      },
    },
  };

  const resolved = resolveRefs(document);

  expect(resolved).toMatchObject({
    paths: { '/a': { schema: { type: 'object', properties: { inner: { type: 'string' } } } } },
  });
  expect(JSON.stringify(resolved)).not.toContain('$ref');
});

test('fails on a circular ref', () => {
  const document = {
    components: {
      schemas: { Node: { properties: { next: { $ref: '#/components/schemas/Node' } } } },
    },
  };

  expect(() => resolveRefs(document)).toThrow('circular $ref: #/components/schemas/Node');
});

test('fails on a non-local ref', () => {
  expect(() => resolveRefs({ schema: { $ref: 'other.yaml#/Thing' } })).toThrow(
    'unsupported $ref (only local refs): other.yaml#/Thing',
  );
});

test('fails on a ref to a missing target', () => {
  expect(() => resolveRefs({ schema: { $ref: '#/components/schemas/Gone' } })).toThrow(
    'unresolvable $ref: #/components/schemas/Gone',
  );
});
