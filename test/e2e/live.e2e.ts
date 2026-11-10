import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GUIDES } from '../../src/guides.ts';
import { fill, template } from '../guide-template.ts';
import {
  cleanUp,
  type Execute,
  executeVia,
  type LiveOffer,
  readAccount,
  runMarker,
  TEST_CONTACT,
  TEST_TAG,
} from './cleanup.ts';

// The manual E2E run against a real sevDesk account (issue #21, PRD §8, decision 29), started with
// `bun run test:e2e` and never in CI. It drives PRD §4 Priority A through a server spawned over
// stdio, with the guides' templates as bodies: the persistent contact "MCP Test GmbH" (created once
// if missing), an offer draft tagged mcp-test with the run id in its headText, its PDF (saved again
// after a change of its header, which the new PDF must show: savePdf renders a draft again, issue
// #49), and the mail to SEVDESK_E2E_MAIL_TO. It records what getPdf without preventSendBy=true does
// to the live status (decision 7). Only contacts and offers, never invoices. Afterwards it deletes
// this run's tagged drafts through the confirmation flow (test/e2e/cleanup.ts), all or none, and
// lists the offers left for manual deletion. The server gets a temporary home, so the real config
// file, audit log and Downloads folder stay untouched. The report printed at the end names neither
// the token nor the mail address, so it can go into the issue as it is.

/** An environment variable's value, or undefined when it is unset or blank. */
function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

const token = setting(process.env.SEVDESK_E2E_TOKEN);
const mailTo = setting(process.env.SEVDESK_E2E_MAIL_TO);

const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const PROFILE = 'e2e';
const SAVE_ORDER = '/Order/Factory/saveOrder';
const DRAFT = '100';
// The fixture contact's address and person: fictitious.
const ADDRESS = { street: 'Teststraße 1', zip: '10115', city: 'Berlin' };
const PERSON = { 'first name': 'Max', 'last name': 'Mustermann' };

const runId = randomUUID();
const marker = runMarker(runId);
// The text the offer's header gets after its first PDF: letters and digits only, so a PDF cannot
// split or reshape it.
const headerMarker = `R${runId.replaceAll('-', '').slice(0, 12)}`;
/** The lines printed at the end. */
const report: string[] = [`sevdesk-mcp E2E run ${runId}`];
/** The id of every offer this run created, from the writes ledgers. */
const created: string[] = [];
/** The offers this run sent on purpose that are no longer drafts: listed, never deleted. */
const kept = new Map<string, LiveOffer>();

let home: string | undefined;
let client: Client | undefined;
let execute: Execute;
let contactId: string | undefined;
let offerId: string | undefined;

/** `value` from an earlier test of the run; a test that needs it fails when that test failed. */
function earlier<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`No ${what}: an earlier test of this run failed`);
  return value;
}

/** A guide's text. */
function guide(id: string): string {
  const text = GUIDES[id]?.text;
  if (text === undefined) throw new Error(`There is no guide ${id}`);
  return text;
}

/** The variables that put the server's config, state and Downloads directories into `dir`. */
function homeEnv(dir: string): Record<string, string> {
  return {
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
    APPDATA: join(dir, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(dir, 'AppData', 'Local'),
  };
}

/** `base` that also records the offers each run created, from its writes ledger. */
function recording(base: Execute): Execute {
  return async (args) => {
    const result = await base(args);
    const writes = (result.envelope.writes ?? []) as { path: string; objectId?: string }[];
    for (const { objectId } of writes.filter(({ path }) => path === SAVE_ORDER)) {
      if (objectId === undefined) {
        report.push(`A saveOrder got no answer: an offer may exist; search sevDesk for ${marker}`);
      } else {
        created.push(objectId);
      }
    }
    return result;
  };
}

/** Runs `code` and returns its envelope; a failed run fails the test. */
async function run(code: string): Promise<Record<string, unknown>> {
  const { isError, envelope } = await execute({ code });
  if (isError) throw new Error(`execute failed: ${JSON.stringify(envelope.error)}`);
  return envelope;
}

/** Confirms the one held call `expected` (`METHOD /path`) of `envelope`; it must be sent. */
async function confirmHeld(envelope: Record<string, unknown>, expected: string): Promise<void> {
  const confirmation = envelope.confirmation as {
    token: string;
    held: { method: string; path: string }[];
  };
  expect(confirmation.held.map(({ method, path }) => `${method} ${path}`)).toEqual([expected]);
  const confirmed = await execute({ confirm: confirmation.token });
  expect(confirmed.isError).toBe(false);
  expect(confirmed.envelope.confirmed).toMatchObject([{ outcome: 'sent' }]);
}

/**
 * The text of the PDF at `path`, all pages, without whitespace: a PDF may split its text anywhere,
 * so only a marker without whitespace is found reliably.
 */
async function pdfText(path: string): Promise<string> {
  const task = getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let page = 1; page <= pdf.numPages; page += 1) {
      const { items } = await (await pdf.getPage(page)).getTextContent();
      pages.push(items.map((item) => ('str' in item ? item.str : '')).join(''));
    }
    return pages.join('').replace(/\s+/g, '');
  } finally {
    await task.destroy();
  }
}

/** Saves the PDF of offer `id` with savePdf: its text, and whether the run rendered it again. */
async function savePdfText(id: string): Promise<{ text: string; rendered: boolean }> {
  const { result, writes = [] } = await run(
    `return await sevdesk.savePdf('Order', ${JSON.stringify(id)});`,
  );
  const render = `/Order/${id}/render`;
  return {
    text: await pdfText((result as { path: string }).path),
    rendered: (writes as { path: string }[]).some(({ path }) => path === render),
  };
}

/** The offer `id` as sevDesk has it now. */
async function readOffer(id: string): Promise<LiveOffer> {
  const [offer] = (await readAccount(execute, [id])).offers;
  if (offer === undefined) throw new Error(`Order ${id} was not read`);
  return offer;
}

function label({ id, number, status }: LiveOffer): string {
  return `Order ${id} (${number ?? 'no number'}, status ${status ?? 'unknown'})`;
}

/** The status and sendDate of `before` and `after`, and whether either changed. */
function change(before: LiveOffer, after: LiveOffer): string {
  const sendDate = (offer: LiveOffer) => offer.sendDate ?? 'none';
  const same = before.status === after.status && sendDate(before) === sendDate(after);
  return `status ${String(before.status)} → ${String(after.status)}, sendDate ${sendDate(before)} → ${sendDate(after)}: ${same ? 'unchanged' : 'changed'}`;
}

/** Keeps `offer` for manual deletion when it is no longer a draft. */
function keepIfSent(offer: LiveOffer): void {
  if (offer.status !== DRAFT) kept.set(offer.id, offer);
}

/**
 * Step 1 of the offer guide: the contact "MCP Test GmbH", created with its contact person and
 * address when it is missing. Two of that name fail the run rather than pick one.
 */
async function findOrCreateContact(): Promise<{ id: string; created: boolean }> {
  const offer = guide('offer');
  const company = fill(template(offer, 'POST /Contact with '), { company: TEST_CONTACT });
  const person = fill(template(offer, 'POST /Contact with ', 1), {
    ...PERSON,
    'company id': 'company.id',
  });
  const address = fill(template(offer, 'POST /ContactAddress with '), {
    'company id': 'company.id',
    ...ADDRESS,
    'country id': 'country.id',
    'category id': 'category.id',
  });
  const { result } = await run(`
    const name = ${JSON.stringify(TEST_CONTACT)};
    const found = (await sevdesk.request('GET', '/Contact', { query: { name, depth: 1 } })).objects
      .filter((contact) => contact.name === name);
    if (found.length > 1) throw new Error('sevDesk has ' + found.length + ' contacts named ' + name + '; merge them into one.');
    if (found.length === 1) return { id: found[0].id, created: false };
    const company = (await sevdesk.request('POST', '/Contact', { body: ${company} })).objects;
    await sevdesk.request('POST', '/Contact', { body: ${person} });
    const country = (await sevdesk.request('GET', '/StaticCountry')).objects.find((c) => c.name === 'Deutschland');
    const [category] = (await sevdesk.request('GET', '/Category', { query: { objectType: 'ContactAddress' } })).objects;
    await sevdesk.request('POST', '/ContactAddress', { body: ${address} });
    return { id: company.id, created: true };`);
  return result as { id: string; created: boolean };
}

/** Steps 2 to 4 of the offer guide: a user, the next offer number and a unit. */
async function lookUp(): Promise<{ userId: string; number: string; unitId: string }> {
  const { result } = await run(`
    const [user] = (await sevdesk.request('GET', '/SevUser')).objects;
    const sequence = (await sevdesk.request('GET', '/SevSequence/Factory/getByType', { query: { objectType: 'Order', type: 'AN' } })).objects;
    const [unit] = (await sevdesk.request('GET', '/Unity')).objects;
    return { userId: user.id, number: sequence.format.replace('%NUMBER', String(sequence.nextSequence)), unitId: unit.id };`);
  return result as { userId: string; number: string; unitId: string };
}

/**
 * Step 5 of the offer guide with the template as it stands, plus the run's marker in headText and
 * the tag mcp-test. Returns the new draft's id once sevDesk shows it tagged, marked and a draft.
 */
async function createOffer(): Promise<string> {
  const { userId, number, unitId } = await lookUp();
  const body = fill(template(guide('offer'), 'POST /Order/Factory/saveOrder:'), {
    'next number': number,
    'contact id': JSON.stringify(earlier(contactId, 'contact')),
    'user id': JSON.stringify(userId),
    'unit id': JSON.stringify(unitId),
    item: 'sevdesk-mcp E2E test',
    company: TEST_CONTACT,
    ...ADDRESS,
  });
  const { result } = await run(`
    const body = ${body};
    body.order.headText = ${JSON.stringify(marker)};
    const id = (await sevdesk.request('POST', '${SAVE_ORDER}', { body })).objects.order.id;
    await sevdesk.request('POST', '/Tag/Factory/create', { body: { name: ${JSON.stringify(TEST_TAG)}, object: { id: Number(id), objectName: 'Order' } } });
    return id;`);
  const id = String(result);
  const offer = await readOffer(id);
  expect(offer).toMatchObject({ found: true, tagged: true, status: DRAFT, number });
  expect(offer.headText).toContain(marker);
  return id;
}

/**
 * Deletes the run's offers that were not sent on purpose (all or none, test/e2e/cleanup.ts), reports
 * what is left in the account, and fails when the cleanup left any of them.
 */
async function cleanUpAndReport(): Promise<void> {
  report.push(`Offers created: ${created.length === 0 ? 'none' : created.join(', ')}`);
  const candidates = created.filter((id) => !kept.has(id));
  const { offers, deleted, reasons } = await cleanUp(execute, runId, candidates);
  report.push(
    `Cleanup: ${deleted.length === 0 ? 'deleted nothing' : `deleted ${deleted.map((id) => `Order ${id}`).join(', ')}`}`,
  );
  if (reasons.length > 0) report.push(`Cleanup: not deleted, because ${reasons.join('; ')}`);
  const left = [...kept.values(), ...offers.filter(({ id }) => !deleted.includes(id))];
  report.push(
    `Left in the account for manual deletion: ${left.length === 0 ? 'nothing' : left.map(label).join(', ')}`,
  );
  if (reasons.length > 0)
    throw new Error(`The cleanup left offers of this run: ${reasons.join('; ')}`);
}

function liveRun(apiToken: string): void {
  describe(`the real sevDesk account, run ${runId}`, () => {
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-e2e-'));
      client = new Client({ name: 'sevdesk-mcp-e2e', version: '0.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli],
          env: {
            ...getDefaultEnvironment(),
            ...homeEnv(home),
            SEVDESK_API_TOKEN: apiToken,
            SEVDESK_PROFILE: PROFILE,
          },
        }),
      );
      execute = recording(executeVia(client));
    });

    afterAll(async () => {
      try {
        await cleanUpAndReport();
      } finally {
        console.log(report.join('\n'));
        await client?.close();
        if (home !== undefined) rmSync(home, { recursive: true, force: true });
      }
    });

    test(`the contact "${TEST_CONTACT}" is found, or created once from the offer guide`, async () => {
      const contact = await findOrCreateContact();
      contactId = contact.id;
      report.push(
        `Contact ${TEST_CONTACT}: ${contact.created ? 'created' : 'found'} (id ${contact.id})`,
      );
    });

    test('PDF only: the tagged offer draft gets its PDF from savePdf, and its status stays unchanged', async () => {
      const tags = (await readAccount(execute, [])).tagIds;
      report.push(
        `Tag ${TEST_TAG}: ${tags.length === 0 ? 'missing, created by tagging the first offer' : `found (id ${tags.join(', ')})`}`,
      );
      const id = await createOffer();
      offerId = id;
      // Tagging reuses the persistent tag rather than adding one.
      expect((await readAccount(execute, [])).tagIds).toHaveLength(1);

      const before = await readOffer(id);
      const { result } = await run(`return await sevdesk.savePdf('Order', ${JSON.stringify(id)});`);
      const { path } = result as { path: string };
      expect(path.startsWith(String(home))).toBe(true);
      expect(readFileSync(path).subarray(0, 4).toString('latin1')).toBe('%PDF');
      const after = await readOffer(id);
      report.push(`savePdf (preventSendBy=true) on ${label(after)}: ${change(before, after)}`);
      expect([after.status, after.sendDate]).toEqual([before.status, before.sendDate]);
    });

    test('issue #49: a PDF saved after a change of the offer draft shows the change', async () => {
      const id = earlier(offerId, 'offer from the PDF-only test');
      const before = await readOffer(id);
      const first = await savePdfText(id);
      const header = `Angebot ${before.number ?? ''} ${headerMarker}`;
      await run(
        `await sevdesk.request('PUT', '/Order/${id}', { body: { header: ${JSON.stringify(header)} } }); return true;`,
      );
      const second = await savePdfText(id);
      const after = await readOffer(id);
      const shows = second.text.includes(headerMarker);
      report.push(
        `savePdf after changing the header of ${label(after)}: the PDF ${shows ? 'shows' : 'does not show'} the change; ${change(before, after)}`,
      );
      expect([first.rendered, second.rendered]).toEqual([true, true]);
      expect(first.text.includes(headerMarker)).toBe(false);
      expect(shows).toBe(true);
      expect([after.status, after.sendDate]).toEqual([before.status, before.sendDate]);
    });

    test('decision 7: getPdf without preventSendBy=true is held, and the run records what it does to the status', async () => {
      const id = earlier(offerId, 'offer from the PDF-only test');
      const path = `/Order/${id}/getPdf`;
      const before = await readOffer(id);
      const held = await run(`return await sevdesk.request('GET', '${path}');`);
      expect(held).toMatchObject({ result: { held: true } });
      await confirmHeld(held, `GET ${path}`);
      const after = await readOffer(id);
      report.push(`getPdf without preventSendBy=true on ${label(after)}: ${change(before, after)}`);
      keepIfSent(after);
    });

    test('sevDesk mail: an offer goes to SEVDESK_E2E_MAIL_TO only after its confirmation', async (context) => {
      if (mailTo === undefined) {
        report.push('Mail test: skipped, SEVDESK_E2E_MAIL_TO is not set');
        return context.skip('SEVDESK_E2E_MAIL_TO is not set: the mail test is skipped');
      }
      const id = await createOffer();
      const { number = '' } = await readOffer(id);
      const path = `/Order/${id}/sendViaEmail`;
      const mail = fill(template(guide('delivery'), 'POST /Order/{orderId}/sendViaEmail with '), {
        address: mailTo,
        number,
      });
      const held = await run(`return await sevdesk.request('POST', '${path}', { body: ${mail} });`);
      expect(held).toMatchObject({ result: { held: true } });
      const previews = (held.confirmation as { held: { recipient?: string }[] }).held;
      // Compared as a boolean, so a failure never prints the address.
      expect(previews.length === 1 && previews[0]?.recipient === mailTo).toBe(true);
      await confirmHeld(held, `POST ${path}`);
      const after = await readOffer(id);
      report.push(`Mail test: ${label(after)} sent to SEVDESK_E2E_MAIL_TO`);
      keepIfSent(after);
      expect(after.status).not.toBe(DRAFT);
    });
  });
}

if (token === undefined) {
  test.skip('SEVDESK_E2E_TOKEN is not set: the run against the real sevDesk account is skipped');
} else {
  liveRun(token);
}
