import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Confirmation } from './confirm.ts';
import type { SandboxOutcome, SnippetError } from './sandbox.ts';
import type { Confirmed, Write } from './sevdesk.ts';

/**
 * The JSON object every Code Mode tool result carries (decision 11). `execute` adds its write
 * ledger (`writes`) and the confirmation request of held calls (`confirmation`); a confirmation run
 * reports each confirmed call (`confirmed`).
 */
interface Envelope {
  result?: unknown;
  error?: SnippetError;
  console?: string[];
  writes?: Write[];
  confirmation?: Confirmation;
  confirmed?: Confirmed[];
  notes?: string[];
}

/** What became of a run's held calls: a confirmation request, or dropped (`METHOD path` each). */
type Held = { confirmation: Confirmation } | { dropped: string[] };

const MAYBE_APPLIED =
  'A write in writes without status got no answer, one with a 5xx status a server error: either may still have been applied. Check with a GET before sending it again.';

/** The notes on a run's held calls. */
function heldNotes(held: Held | undefined): string[] {
  if (held === undefined) return [];
  if ('confirmation' in held) {
    const count = held.confirmation.held.length;
    return [
      `${String(count)} irreversible call${count === 1 ? ' was' : 's were'} held, not sent. Show the user confirmation.held; only after their yes call execute with confirm set to confirmation.token and no code. The token works once, for 10 minutes.`,
    ];
  }
  if (held.dropped.length === 0) return [];
  return [
    `The run failed, so its held calls were dropped unsent and no confirmation token was issued: ${held.dropped.join(', ')}. Do not repeat the writes in writes.`,
  ];
}

/**
 * Turns a sandbox outcome into a tool result: one text block with the envelope as JSON,
 * `isError` when the run failed. A return value over `outputChars` characters of JSON is cut,
 * and the notes say so, as they do for a missing return value and cut console output. `writes`,
 * the ledger of the write calls the run sent, comes back whether the run failed or not; a note
 * flags writes that may have been applied without a success answer. `held` adds the confirmation
 * request of the held calls with a note on what to do, or a note that they were dropped.
 */
export function toToolResult(
  outcome: SandboxOutcome,
  outputChars: number,
  writes: Write[] = [],
  held?: Held,
): CallToolResult {
  const envelope: Envelope = {};
  const notes: string[] = [];
  if (!outcome.ok) {
    envelope.error = outcome.error;
  } else if (outcome.json === undefined) {
    notes.push(
      'No return value: the code returned undefined (or a value JSON cannot represent). End it with return <data>.',
    );
  } else if (outcome.json.length <= outputChars) {
    envelope.result = JSON.parse(outcome.json);
  } else {
    envelope.result = outcome.json.slice(0, outputChars);
    notes.push(
      `Result cut to ${String(outputChars)} of ${String(outcome.json.length)} characters. Filter or map it more narrowly in the code.`,
    );
  }
  if (outcome.console.length > 0) envelope.console = outcome.console;
  if (outcome.consoleCut) {
    notes.push(`console.log output cut after ${String(outputChars)} characters.`);
  }
  if (writes.length > 0) envelope.writes = writes;
  if (writes.some(({ status }) => status === undefined || status >= 500)) {
    notes.push(MAYBE_APPLIED);
  }
  if (held !== undefined && 'confirmation' in held) envelope.confirmation = held.confirmation;
  notes.push(...heldNotes(held));
  if (notes.length > 0) envelope.notes = notes;

  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(envelope) }];
  return outcome.ok ? { content } : { content, isError: true };
}

/** The tool result of an error that ended the call before any code ran. */
export function errorResult(error: SnippetError): CallToolResult {
  // Without a return value or console output there is nothing to cut.
  return toToolResult({ ok: false, error, console: [], consoleCut: false }, 0);
}

/**
 * The tool result of a confirmation run: `confirmed`, what became of each held call, and the error
 * that stopped it, if one did (`isError`). A note flags a failed call that may still have been
 * applied (no answer, or a 5xx).
 */
export function confirmedResult({
  confirmed,
  error,
}: {
  confirmed: Confirmed[];
  error?: SnippetError;
}): CallToolResult {
  const envelope: Envelope = { confirmed };
  if (error !== undefined) envelope.error = error;
  const unsure = confirmed.some(
    ({ outcome, status }) => outcome === 'failed' && (status === undefined || status >= 500),
  );
  if (unsure) {
    envelope.notes = [
      'The failed call in confirmed got no answer (no status) or a server error (5xx), so it may still have been applied. Check with a GET before sending it again.',
    ];
  }
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(envelope) }];
  return error === undefined ? { content } : { content, isError: true };
}
