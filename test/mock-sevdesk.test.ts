import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_BASE_URL } from '../src/sevdesk.ts';
import { startMockSevdesk } from './mock-sevdesk.ts';

// The mock sevDesk follows the embedded spec (PRD §8): it takes routes and answers requests only
// for operations of spec/sevdesk-openapi.json, plus the undocumented GET /SevClient the setup reads.

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function answer(method: string, path: string) {
  const response = await fetch(`${DEFAULT_BASE_URL}${path}`, { method });
  const json: unknown = await response.json();
  return { status: response.status, json };
}

test.each(['GET /Offer', 'PATCH /Contact', 'POST /Order/42'])(
  'a route for %s, which the spec lacks, fails the start',
  async (route) => {
    await expect(startMockSevdesk({ [route]: () => ({ json: {} }) })).rejects.toThrow(
      `The mock sevDesk follows the embedded spec, which lacks ${route}`,
    );
  },
);

test('a request the spec lacks answers 404 and never reaches a route; spec operations are routed', async () => {
  const routed = vi.fn(() => ({ json: { objects: [{ id: '7', objectName: 'Contact' }] } }));
  const sevdesk = await startMockSevdesk({ 'GET /Contact/7': routed });
  closers.push(sevdesk.close);

  const offer = await answer('GET', '/Offer');
  const patch = await answer('PATCH', '/Contact/7');
  const contact = await answer('GET', '/Contact/7');
  const unrouted = await answer('GET', '/Contact/8');
  const company = await answer('GET', '/SevClient');

  expect(offer).toEqual({
    status: 404,
    json: { objects: null, error: { message: 'GET /Offer is not in the embedded sevDesk spec' } },
  });
  expect(patch).toEqual({
    status: 404,
    json: {
      objects: null,
      error: { message: 'PATCH /Contact/7 is not in the embedded sevDesk spec' },
    },
  });
  expect(contact).toEqual({ status: 200, json: { objects: [{ id: '7', objectName: 'Contact' }] } });
  expect(routed).toHaveBeenCalledTimes(1);
  // A spec operation without a route, and the undocumented GET /SevClient, answer the plain 404.
  for (const plain of [unrouted, company]) {
    expect(plain).toEqual({
      status: 404,
      json: { objects: null, error: { message: 'Not found' } },
    });
  }
  expect(sevdesk.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /Offer',
    'PATCH /Contact/7',
    'GET /Contact/7',
    'GET /Contact/8',
    'GET /SevClient',
  ]);
});
