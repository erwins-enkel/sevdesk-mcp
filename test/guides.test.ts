import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { GUIDES } from '../src/guides.ts';

const spec = JSON.parse(
  readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> };

// A sevDesk path in a text (a capitalised segment after a slash that does not follow a word, so
// "AN/AB" and "Europe/Berlin" are not paths), with the method in front of it when there is one.
const ENDPOINT =
  /(?:\b(GET|POST|PUT|DELETE) )?(?<![\w}\]])(\/[A-Z][A-Za-z]*(?:\/(?:[A-Za-z]+|\{\w+\}))*)/g;

function endpointsIn(text: string): { method: string | undefined; path: string }[] {
  return [...text.matchAll(ENDPOINT)].map((match) => ({ method: match[1], path: match[2] ?? '' }));
}

const used = Object.entries(GUIDES).flatMap(([id, { text }]) =>
  endpointsIn(text).map((endpoint) => ({ id, ...endpoint })),
);

test('the endpoint check finds methods, bare paths and path templates, and skips other slashes', () => {
  expect(endpointsIn('GET /Order/{orderId}/getPdf, then /Contact; AN/AB, Europe/Berlin')).toEqual([
    { method: 'GET', path: '/Order/{orderId}/getPdf' },
    { method: undefined, path: '/Contact' },
  ]);
});

test('every guide names each endpoint as METHOD /path', () => {
  expect(used.length).toBeGreaterThan(0);
  expect(used.filter(({ method }) => method === undefined)).toEqual([]);
});

test('every endpoint the guides use exists in the patched spec', () => {
  const missing = used.filter(
    ({ method, path }) => spec.paths[path]?.[(method ?? '').toLowerCase()] === undefined,
  );

  expect(missing).toEqual([]);
});
