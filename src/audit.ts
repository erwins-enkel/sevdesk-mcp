// The audit log (PRD §6, decision 16): one JSONL file per month in the state directory, with one
// line for every write call `execute` handles. Never a request body, never the token.
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localDirs } from './paths.ts';
import { HostError } from './sandbox.ts';
import type { Call } from './sevdesk.ts';

/**
 * What became of a write call: `executed`, a reversible write sent directly; `held`, an
 * irreversible call kept for confirmation, not sent; `confirmed`, a held call sent after its
 * confirmation; `rejected`, a call refused by read-only mode or the confirmation gate, not sent.
 */
type AuditOutcome = 'executed' | 'held' | 'confirmed' | 'rejected';

/** sevDesk's answer to a sent call: its final HTTP status and the id of the object it names. */
interface Answer {
  status?: number;
  objectId?: string;
}

/**
 * The audit log of one profile. Both methods throw a fatal `audit_error` when the log cannot be
 * written, so a run never goes on without its lines.
 */
export interface AuditLog {
  /**
   * Before a call is sent: opens the current month's file for appending, so an unwritable log
   * stops the call before anything is sent.
   */
  check(): void;
  /** Appends the line of `call` with its `outcome` and, for a sent call, sevDesk's answer. */
  write(call: Call, outcome: AuditOutcome, answer?: Answer): void;
}

/** The audit log with `"audit": false` in the config file: it checks and writes nothing. */
export const NO_AUDIT: AuditLog = { check: () => undefined, write: () => undefined };

const HINT =
  'Tell the user the audit log could not be written. They can make its directory writable, or turn the log off with "audit": false in the config file and restart the MCP server.';

/** The directory of the audit log in the state directory. */
export function auditDir(): string {
  return join(localDirs().state, 'audit');
}

/** The file of the UTC month of `time` in the audit directory, e.g. `audit/2026-11.jsonl`. */
function monthFile(time: Date): string {
  return join(auditDir(), `${time.toISOString().slice(0, 7)}.jsonl`);
}

/**
 * Opens `file` for appending, its directory created as needed; a new file is readable by its owner
 * only. Every write through the descriptor lands at the end of the file (O_APPEND).
 */
function openForAppend(file: string): number {
  mkdirSync(dirname(file), { recursive: true });
  return openSync(file, 'a', 0o600);
}

/**
 * Appends `line` to `file` with a single write: with O_APPEND, each line lands whole even when
 * several server processes append to the same file at once. A short write fails.
 */
function append(file: string, line: string): void {
  const fd = openForAppend(file);
  try {
    const bytes = Buffer.from(line, 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short write');
  } finally {
    closeSync(fd);
  }
}

/**
 * The JSON line of `call` (decision 16): time, profile, method, path, query, status, object id,
 * the SHA-256 of the body and the outcome. The body itself and the token never enter it.
 */
function lineOf(
  time: Date,
  profile: string,
  call: Call,
  outcome: AuditOutcome,
  { status, objectId }: Answer = {},
): string {
  const { searchParams } = call.url;
  const line = {
    time: time.toISOString(),
    profile,
    method: call.method,
    path: call.path,
    query: searchParams.size > 0 ? Object.fromEntries(searchParams) : undefined,
    status,
    objectId,
    bodyHash:
      call.body === undefined ? undefined : createHash('sha256').update(call.body).digest('hex'),
    outcome,
  };
  return `${JSON.stringify(line)}\n`;
}

/** What became of `call` when its line could not be written. */
function callState({ method, path }: Call, outcome: AuditOutcome): string {
  if (outcome === 'held') return `${method} ${path} was neither held nor sent`;
  if (outcome === 'rejected') return `${method} ${path} was rejected and not sent`;
  return `${method} ${path} was sent`;
}

/** The fatal error of a log that could not be written: only the error's code, if any. */
function auditError(state: string, file: string, error: unknown): HostError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return new HostError(
    {
      kind: 'audit_error',
      message: `The audit log ${file} could not be written${code === undefined ? '' : ` (${code})`}: ${state}.`,
      hint: HINT,
    },
    true,
  );
}

/**
 * The audit log of `profile` (decision 16): `<state directory>/audit/<YYYY-MM>.jsonl`, one file per
 * UTC month, never deleted by the server. Each line is written synchronously, at once.
 */
export function auditLog(profile: string): AuditLog {
  return {
    check() {
      const file = monthFile(new Date());
      try {
        closeSync(openForAppend(file));
      } catch (error) {
        throw auditError('nothing was sent', file, error);
      }
    },
    write(call, outcome, answer) {
      const time = new Date();
      const file = monthFile(time);
      try {
        append(file, lineOf(time, profile, call, outcome, answer));
      } catch (error) {
        throw auditError(callState(call, outcome), file, error);
      }
    },
  };
}
