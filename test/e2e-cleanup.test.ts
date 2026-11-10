import { afterEach, expect, test, vi } from 'vitest';
import { connect } from './connect.ts';
import {
  cleanUp,
  cleanupGuard,
  type Execute,
  executeVia,
  type LiveOffer,
  runMarker,
  TEST_TAG,
} from './e2e/cleanup.ts';
import { type MockRequest, type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// The cleanup of the manual E2E run (issue #21, PRD §8), offline: it deletes only offers of this
// run that carry the tag mcp-test and are still drafts, through the confirmation flow, and deletes
// nothing when any offer fails a condition.

const RUN = 'run-7f3a';
const OTHER_RUN = 'run-0b19';
const TOKEN = 'token-e2e-cleanup-4d8e';
const TAG_ID = '5';
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** An offer of `RUN` that may be deleted, with `changes`. */
function offer(id: string, changes: Partial<LiveOffer> = {}): LiveOffer {
  const headText = `<p>${runMarker(RUN)}</p>`;
  return { id, found: true, tagged: true, status: '100', headText, number: `AN-${id}`, ...changes };
}

// Each way an offer fails the guard, with the reason it gets.
const FAILURES: [string, Partial<LiveOffer>, string][] = [
  ['not found', { found: false }, 'Order 102 was not found'],
  ['of another run', { headText: runMarker(OTHER_RUN) }, "Order 102 lacks this run's marker"],
  ['untagged', { tagged: false }, `Order 102 is not tagged ${TEST_TAG}`],
  ['no draft', { status: '200' }, 'Order 102 is no draft (status 200)'],
];

test('the guard lets the run delete its tagged drafts', () => {
  expect(cleanupGuard(RUN, [offer('101'), offer('102')])).toEqual({ ok: true });
});

test.each(FAILURES)('the guard refuses all when one offer is %s', (_, changes, reason) => {
  expect(cleanupGuard(RUN, [offer('101'), offer('102', changes), offer('103')])).toEqual({
    ok: false,
    reasons: [reason],
  });
});

/**
 * A mock sevDesk account with `offers`, and `execute` on a server for it. Each call is recorded with
 * the requests the mock received while it ran.
 */
async function open(offers: LiveOffer[]) {
  const relations = offers
    .filter(({ tagged }) => tagged)
    .map(({ id }) => ({
      id: `9${id}`,
      objectName: 'TagRelation',
      tag: { id: TAG_ID, objectName: 'Tag' },
      object: { id: Number(id), objectName: 'Order' },
    }));
  const routes: MockRoutes = {
    'GET /Tag': () => ({ json: { objects: [{ id: TAG_ID, objectName: 'Tag', name: TEST_TAG }] } }),
    // sevdesk.paginate reads until an empty page.
    'GET /TagRelation': ({ query }) => ({
      json: { objects: query.get('offset') === '0' ? relations : [] },
    }),
  };
  for (const { id, found, status, headText, number } of offers) {
    if (!found) continue;
    const order = {
      id,
      objectName: 'Order',
      orderType: 'AN',
      orderNumber: number,
      status,
      headText,
    };
    routes[`GET /Order/${id}`] = () => ({ json: { objects: [order] } });
    routes[`DELETE /Order/${id}`] = () => ({ json: { objects: [null] } });
  }
  const sevdesk = await startMockSevdesk(routes);
  closers.push(sevdesk.close);
  vi.stubEnv('SEVDESK_API_TOKEN', TOKEN);
  const client = await connect();
  closers.push(() => client.close());

  const calls: { confirm: boolean; requests: MockRequest[] }[] = [];
  const base = executeVia(client);
  const execute: Execute = async (args) => {
    const start = sevdesk.requests.length;
    const result = await base(args);
    calls.push({ confirm: 'confirm' in args, requests: sevdesk.requests.slice(start) });
    return result;
  };
  const deletes = () =>
    sevdesk.requests.filter(({ method }) => method === 'DELETE').map(({ path }) => path);
  return { execute, calls, deletes };
}

test('the cleanup deletes the tagged drafts of the run, only through the confirmation', async () => {
  // A tagged draft of another run is in the account too.
  const otherRun = offer('900', { headText: runMarker(OTHER_RUN) });
  const { execute, calls, deletes } = await open([offer('101'), offer('102'), otherRun]);

  const cleanup = await cleanUp(execute, RUN, ['101', '102']);

  expect(cleanup).toEqual({
    offers: [offer('101', { sendDate: null }), offer('102', { sendDate: null })],
    deleted: ['101', '102'],
    reasons: [],
  });
  expect(deletes()).toEqual(['/Order/101', '/Order/102']);
  const unconfirmed = calls.filter(({ confirm }) => !confirm).flatMap(({ requests }) => requests);
  expect(unconfirmed.filter(({ method }) => method === 'DELETE')).toEqual([]);
});

test.each(FAILURES)(
  'the cleanup deletes nothing when one offer is %s',
  async (_, changes, reason) => {
    const { execute, calls, deletes } = await open([
      offer('101'),
      offer('102', changes),
      offer('103'),
    ]);

    const cleanup = await cleanUp(execute, RUN, ['101', '102', '103']);

    expect(cleanup).toMatchObject({ deleted: [], reasons: [reason] });
    expect(deletes()).toEqual([]);
    // Only the read ran: no delete was held, so no token exists that could send one.
    expect(calls).toHaveLength(1);
  },
);

test('the cleanup of a run without offers sends nothing', async () => {
  const { execute, calls } = await open([offer('101')]);
  expect(await cleanUp(execute, RUN, [])).toEqual({ offers: [], deleted: [], reasons: [] });
  expect(calls).toEqual([]);
});
