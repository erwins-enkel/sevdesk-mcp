import type { CallToolResult } from '@modelcontextprotocol/server';
import type { SandboxOutcome, SnippetError } from './sandbox.ts';

/**
 * The JSON object every Code Mode tool result carries (decision 11). `execute` adds its write
 * ledger and confirmation request here.
 */
interface Envelope {
  result?: unknown;
  error?: SnippetError;
  console?: string[];
  notes?: string[];
}

/**
 * Turns a sandbox outcome into a tool result: one text block with the envelope as JSON,
 * `isError` when the run failed. A return value over `outputChars` characters of JSON is cut,
 * and the notes say so, as they do for a missing return value and cut console output.
 */
export function toToolResult(outcome: SandboxOutcome, outputChars: number): CallToolResult {
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
  if (notes.length > 0) envelope.notes = notes;

  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(envelope) }];
  return outcome.ok ? { content } : { content, isError: true };
}
