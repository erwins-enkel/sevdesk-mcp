import { createHash } from 'node:crypto';

/**
 * What a saved PDF says about its age next to its document (issue #52): the SHA-256 of its bytes,
 * when it was created and when the document last changed (UTC ISO 8601, null when unknown), and
 * `stale` when a draft changed after its PDF was created.
 */
export interface PdfFreshness {
  sha256: string;
  pdfCreated: string | null;
  documentUpdated: string | null;
  stale?: true;
}

// A PDF date as a literal string (`/CreationDate(D:20261110105759Z)`, or with an offset such as
// `+01'00'`): only a full date and time with its offset can be compared as an instant.
const CREATION_DATE =
  /\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:Z(?:00'?00'?)?|([+-])(\d{2})'?(\d{2})'?)\)/g;

// An ISO 8601 date-time with its offset, as sevDesk writes `update` (e.g. 2026-11-10T10:41:00+01:00).
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The instant of the PDF's last literal-string `/CreationDate` (an incremental update writes the
 * newer one after the first), or undefined when it has none it can place: no offset, a partial or
 * impossible date, a hex string, or an Info dictionary inside a compressed stream.
 */
function creationDate(pdf: Uint8Array): Date | undefined {
  const match = [...Buffer.from(pdf).toString('latin1').matchAll(CREATION_DATE)].at(-1);
  if (match === undefined) return undefined;
  const parts = match.slice(1, 7).map(Number);
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const fields = [
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  ];
  // Date.UTC rolls an impossible date (month 13, 30 February, hour 24) over into a real one.
  if (fields.some((field, index) => field !== parts[index])) return undefined;
  // `Z` has no sign; an offset has a sign, hours (00 to 23) and minutes (00 to 59).
  const [sign, hours, minutes] = [match[7], Number(match[8]), Number(match[9])];
  if (sign === undefined) return local;
  if (hours > 23 || minutes > 59) return undefined;
  return new Date(local.getTime() - (sign === '-' ? -1 : 1) * (hours * 60 + minutes) * 60_000);
}

/**
 * The instant of the document's `update`, or undefined unless it is a valid ISO date-time with
 * offset (a month 13 has the shape but no instant).
 */
function updatedAt(update: unknown): Date | undefined {
  if (typeof update !== 'string' || !ISO_INSTANT.test(update)) return undefined;
  const date = new Date(update);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The freshness of `pdf` next to its document's `update`: `stale` only for a draft (`draft`),
 * the one document whose content can still change, whose PDF was created before that change.
 * Without a creation date or an `update` to compare there is no flag, never a guess.
 */
export function pdfFreshness(
  pdf: Uint8Array,
  { update, draft }: { update: unknown; draft: boolean },
): PdfFreshness {
  const created = creationDate(pdf);
  const updated = updatedAt(update);
  const freshness: PdfFreshness = {
    sha256: createHash('sha256').update(pdf).digest('hex'),
    pdfCreated: created?.toISOString() ?? null,
    documentUpdated: updated?.toISOString() ?? null,
  };
  if (draft && created !== undefined && updated !== undefined && created < updated) {
    freshness.stale = true;
  }
  return freshness;
}
