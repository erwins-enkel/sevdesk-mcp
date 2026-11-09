import type { CallToolResult } from '@modelcontextprotocol/server';
import type { SandboxOutcome, SnippetError } from './sandbox.ts';
import type { Write } from './sevdesk.ts';

/**
 * The JSON object every Code Mode tool result carries (decision 11). `execute` adds its write
 * ledger (`writes`) here; the confirmation request follows.
 */
interface Envelope {
  result?: unknown;
  error?: SnippetError;
  console?: string[];
  writes?: Write[];
  notes?: string[];
}

/**
 * Turns a sandbox outcome into a tool result: one text block with the envelope as JSON,
 * `isError` when the run failed. A return value over `outputChars` characters of JSON is cut,
 * and the notes say so, as they do for a missing return value and cut console output. `writes`,
 * the ledger of the write calls the run sent, comes back whether the run failed or not; a note
 * flags writes that may have been applied without a success answer.
 */
export function toToolResult(
  outcome: SandboxOutcome,
  outputChars: number,
  writes: Write[] = [],
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
    notes.push(
      'A write in writes without status got no answer, one with a 5xx status a server error: either may still have been applied. Check with a GET before sending it again.',
    );
  }
  if (notes.length > 0) envelope.notes = notes;

  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(envelope) }];
  return outcome.ok ? { content } : { content, isError: true };
}

/** The tool result of an error that ended the call before any code ran. */
export function errorResult(error: SnippetError): CallToolResult {
  // Without a return value or console output there is nothing to cut.
  return toToolResult({ ok: false, error, console: [], consoleCut: false }, 0);
}
