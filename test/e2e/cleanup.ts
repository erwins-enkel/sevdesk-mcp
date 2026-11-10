import type { Client } from '@modelcontextprotocol/client';
import { envelopeOf } from '../connect.ts';

// The cleanup of the manual E2E run against the real account (PRD §8, decision 29). It deletes only
// offers this run created that carry the run's marker and the tag `mcp-test` and are still drafts.
// When any offer fails any condition, it deletes nothing. Its deletes go through the confirmation
// flow like any other delete. test/e2e-cleanup.test.ts checks it offline against the mock sevDesk.

/** The persistent test contact every test offer goes to (PRD §8); created once, never deleted. */
export const TEST_CONTACT = 'MCP Test GmbH';

/** The persistent tag every test offer carries (PRD §8); created once, never deleted. */
export const TEST_TAG = 'mcp-test';

/** sevDesk's status of an offer draft. */
const DRAFT = '100';

/** The text in an offer's headText that ties it to one run. */
export function runMarker(runId: string): string {
  return `sevdesk-mcp E2E run ${runId}`;
}

/** An `execute` tool call: whether it is an error, and its parsed envelope. */
export type Execute = (
  args: { code: string } | { confirm: string },
) => Promise<{ isError: boolean; envelope: Record<string, unknown> }>;

/** `execute` through `client`. */
export function executeVia(client: Client): Execute {
  return async (args) => {
    const result = await client.callTool({ name: 'execute', arguments: args });
    return { isError: result.isError === true, envelope: envelopeOf(result) };
  };
}

/** An offer as sevDesk has it: `found` false when sevDesk does not know its id. */
export interface LiveOffer {
  id: string;
  found: boolean;
  /** Whether a tag named `mcp-test` is on it. */
  tagged: boolean;
  status?: string;
  sendDate?: string | null;
  headText?: string | null;
  number?: string;
}

/**
 * The ids of the tags named `mcp-test` and the offers `ids` as sevDesk has them, read in one run.
 * The tag relations have no documented filters, so all of them are read and filtered in the
 * snippet.
 */
export async function readAccount(
  execute: Execute,
  ids: string[],
): Promise<{ tagIds: string[]; offers: LiveOffer[] }> {
  const { isError, envelope } = await execute({
    code: `
      const name = ${JSON.stringify(TEST_TAG)};
      const ids = ${JSON.stringify(ids)};
      const tagIds = (await sevdesk.request('GET', '/Tag', { query: { name } })).objects
        .filter((tag) => tag.name === name)
        .map((tag) => String(tag.id));
      const relations = tagIds.length === 0 || ids.length === 0 ? [] : await sevdesk.paginate('/TagRelation');
      const tagged = new Set(relations
        .filter((relation) => tagIds.includes(String(relation.tag?.id)) && relation.object?.objectName === 'Order')
        .map((relation) => String(relation.object.id)));
      const offers = [];
      for (const id of ids) {
        let order;
        try {
          [order] = (await sevdesk.request('GET', '/Order/' + id)).objects;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        offers.push(order === undefined
          ? { id, found: false, tagged: tagged.has(id) }
          : { id, found: true, tagged: tagged.has(id), status: String(order.status), sendDate: order.sendDate ?? null, headText: order.headText ?? null, number: order.orderNumber });
      }
      return { tagIds, offers };`,
  });
  if (isError) throw new Error(`Reading the test offers failed: ${JSON.stringify(envelope)}`);
  return envelope.result as { tagIds: string[]; offers: LiveOffer[] };
}

/** Why `offer` must not be deleted by the run with `marker`; empty when it may. */
function whyNot(offer: LiveOffer, marker: string): string[] {
  const { id, found, tagged, status, headText } = offer;
  if (!found) return [`Order ${id} was not found`];
  return [
    headText?.includes(marker) === true ? undefined : `Order ${id} lacks this run's marker`,
    tagged ? undefined : `Order ${id} is not tagged ${TEST_TAG}`,
    status === DRAFT ? undefined : `Order ${id} is no draft (status ${String(status)})`,
  ].filter((reason) => reason !== undefined);
}

/**
 * Whether the run `runId` may delete all of `offers`: each must exist, carry the run's marker in its
 * headText and the tag `mcp-test`, and still be a draft. Otherwise the reasons, one per failed
 * condition.
 */
export function cleanupGuard(
  runId: string,
  offers: LiveOffer[],
): { ok: true } | { ok: false; reasons: string[] } {
  const marker = runMarker(runId);
  const reasons = offers.flatMap((offer) => whyNot(offer, marker));
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** What the cleanup did: the offers as it read them, those it deleted, and why others were not. */
interface Cleanup {
  offers: LiveOffer[];
  deleted: string[];
  reasons: string[];
}

/**
 * Deletes the offers `ids` that the run `runId` created, all or none: it reads them from sevDesk,
 * and when `cleanupGuard` finds a reason against any, it sends nothing and returns the reasons.
 * Otherwise it holds a DELETE for each and confirms exactly those.
 */
export async function cleanUp(execute: Execute, runId: string, ids: string[]): Promise<Cleanup> {
  if (ids.length === 0) return { offers: [], deleted: [], reasons: [] };
  const { offers } = await readAccount(execute, ids);
  const verdict = cleanupGuard(runId, offers);
  if (!verdict.ok) return { offers, deleted: [], reasons: verdict.reasons };

  const deletes = ids.map((id) => `DELETE /Order/${id}`);
  const run = await execute({
    code: `for (const id of ${JSON.stringify(ids)}) await sevdesk.request('DELETE', '/Order/' + id);`,
  });
  const confirmation = run.envelope.confirmation as
    { token: string; held: { method: string; path: string }[] } | undefined;
  const held = confirmation?.held.map(({ method, path }) => `${method} ${path}`) ?? [];
  if (run.isError || confirmation === undefined || held.join() !== deletes.join()) {
    throw new Error(`The deletes were not held as planned: ${JSON.stringify(run.envelope)}`);
  }

  const { envelope } = await execute({ confirm: confirmation.token });
  const outcomes = (envelope.confirmed ?? []) as { outcome: string; status?: number }[];
  const deleted = ids.filter((_, index) => outcomes[index]?.outcome === 'sent');
  // An id without an outcome counts as not deleted, so a failed confirmation never looks like one.
  const reasons = ids.flatMap((id, index) => {
    const { outcome = 'no outcome', status } = outcomes[index] ?? {};
    return outcome === 'sent' ? [] : [`DELETE /Order/${id}: ${outcome} (status ${String(status)})`];
  });
  return { offers, deleted, reasons };
}
