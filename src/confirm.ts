// The confirmation of held calls (PRD §6, decisions 5 and 9): the preview the human confirms and
// the in-memory, single-use tokens that let `execute({ confirm })` send exactly those calls.
import { randomUUID } from 'node:crypto';
import { HostError, type SnippetError } from './sandbox.ts';
import type { Call } from './sevdesk.ts';

/** How long a confirmation token is valid (decision 5). */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * The document types a preview reads, with their kind and the fields holding their number and date.
 * A voucher's description is essentially its number (the receipt number).
 */
const DOCUMENTS: Record<string, { label: string; number: string; date: string }> = {
  Order: { label: 'Order', number: 'orderNumber', date: 'orderDate' },
  Invoice: { label: 'Invoice', number: 'invoiceNumber', date: 'invoiceDate' },
  CreditNote: { label: 'Credit note', number: 'creditNoteNumber', date: 'creditNoteDate' },
  Voucher: { label: 'Voucher', number: 'description', date: 'voucherDate' },
};

// An Order by its orderType.
const ORDER_LABELS: Record<string, string> = {
  AN: 'Offer',
  AB: 'Order confirmation',
  LI: 'Delivery note',
};

// The document a held call acts on: `/{Type}/{id}` (the match) at the start of its path.
const DOCUMENT_PATH = /^\/(Order|Invoice|CreditNote|Voucher)\/\d+(?=\/|$)/;

// sevDesk answers dates as ISO 8601 with the Berlin offset; the first 10 characters are the
// calendar day (guides.dates).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

/**
 * One held call as the human confirms it (decision 9): the exact call (method, path, query, JSON
 * body) and, for a call on an Order, Invoice, CreditNote or Voucher, that document as sevDesk has
 * it: its kind, number, date (ISO 8601) and amount (numbers with the currency code). `recipient` is
 * the mail address of a send, else the document's addressee; `subject` the mail subject.
 */
export interface Preview {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  document?: string;
  number?: string;
  date?: string;
  amount?: { net?: number; gross?: number; currency: string };
  recipient?: string;
  subject?: string;
}

/** The confirmation request of a run: the token, when it expires, the profile and the previews. */
export interface Confirmation {
  token: string;
  /** ISO 8601. */
  expiresAt: string;
  profile: string;
  /** The profile's company from the config file; the environment profile has none. */
  company?: string;
  held: Preview[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A sum as sevDesk answers it (a decimal string, or a number) as a number, or undefined. */
function numberOf(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

/** The net and gross sums with the currency code; undefined without a currency or any sum. */
function amountOf(document: Record<string, unknown>): Preview['amount'] {
  const currency = textOf(document.currency);
  const net = numberOf(document.sumNet);
  const gross = numberOf(document.sumGross);
  if (currency === undefined || (net === undefined && gross === undefined)) return undefined;
  return { net, gross, currency };
}

/** The calendar day of an ISO 8601 date, as `YYYY-MM-DD`, or undefined. */
function dateOf(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_DATE.test(value) ? value.slice(0, 10) : undefined;
}

/** Who the call reaches: the mail address of a send, else the document's addressee. */
function recipientOf(body: unknown, document: Record<string, unknown> | undefined) {
  const email = isRecord(body) ? textOf(body.toEmail) : undefined;
  if (email !== undefined || document === undefined) return email;
  // The address starts with the addressee's name, as printed on the document.
  const addressee = textOf(document.address)?.split(/\r?\n/)[0]?.trim();
  return textOf(addressee) ?? textOf(document.supplierName);
}

/** The document of a `GET /{Type}/{id}` answer: the first of `objects`. */
function documentOf(path: string, response: unknown): Record<string, unknown> {
  const objects = isRecord(response) ? response.objects : undefined;
  const document: unknown = Array.isArray(objects) ? objects[0] : objects;
  if (isRecord(document)) return document;
  throw new HostError({
    kind: 'api_error',
    message: `GET ${path} returned no document for the confirmation preview.`,
    method: 'GET',
    path,
  });
}

/** The preview fields of a document, as sevDesk answered it, read with its `DOCUMENTS` entry. */
function documentFields(
  { label, number, date }: (typeof DOCUMENTS)[string],
  document: Record<string, unknown>,
): Partial<Preview> {
  const order = label === 'Order' ? ORDER_LABELS[String(document.orderType)] : undefined;
  return {
    document: order ?? label,
    number: textOf(document[number]),
    date: dateOf(document[date]),
    amount: amountOf(document),
  };
}

/**
 * The previews of `held`, in order (decision 9). Each document a held call acts on is read once
 * with `read` (`GET /{Type}/{id}`), after the run, so the preview shows the document as the
 * confirmed call will find it. A read that fails, or finds no document, rejects: then no token is
 * issued.
 */
export async function previewHeld(
  held: Call[],
  read: (path: string) => Promise<unknown>,
): Promise<Preview[]> {
  const documents = new Map<string, Record<string, unknown>>();
  const previews: Preview[] = [];
  for (const call of held) {
    const body: unknown = call.body === undefined ? undefined : JSON.parse(call.body);
    const { searchParams } = call.url;
    const preview: Preview = {
      method: call.method,
      path: call.path,
      query: searchParams.size > 0 ? Object.fromEntries(searchParams) : undefined,
      body,
    };
    const [path, type = ''] = DOCUMENT_PATH.exec(call.path) ?? [];
    const kind = DOCUMENTS[type];
    let document: Record<string, unknown> | undefined;
    if (path !== undefined && kind !== undefined) {
      document = documents.get(path) ?? documentOf(path, await read(path));
      documents.set(path, document);
      Object.assign(preview, documentFields(kind, document));
    }
    preview.recipient = recipientOf(body, document);
    preview.subject = isRecord(body) ? textOf(body.subject) : undefined;
    previews.push(preview);
  }
  return previews;
}

/** The token is not (or no longer) in the store. */
const UNKNOWN_TOKEN: SnippetError = {
  kind: 'invalid_confirmation',
  message: 'The confirmation token is unknown, already used or expired. Nothing was sent.',
  hint: "Tokens work once, for 10 minutes, on the server that issued them. To ask again, run only the irreversible calls (e.g. the send on the existing draft's id), not the code that created drafts.",
};

interface Pending {
  profile: string;
  calls: Call[];
  /** Epoch milliseconds; from then on the token is expired. */
  expiresAt: number;
}

/**
 * The confirmation tokens of one server (decision 5): in memory only, so a restart forgets them.
 * `issue` stores a run's held calls for its profile under a fresh token, valid for 10 minutes.
 * `take` hands them out once: an unknown, used or expired token is rejected, as is a token of
 * another profile, which stays valid for its own.
 */
export function createConfirmations() {
  const pending = new Map<string, Pending>();

  /** Forgets the expired tokens. */
  const purge = () => {
    const now = Date.now();
    for (const [token, entry] of pending) if (now >= entry.expiresAt) pending.delete(token);
  };

  return {
    issue(
      profile: { name: string; company?: string },
      calls: Call[],
      held: Preview[],
    ): Confirmation {
      purge();
      const token = randomUUID();
      const expiresAt = Date.now() + TOKEN_TTL_MS;
      pending.set(token, { profile: profile.name, calls: [...calls], expiresAt });
      const expires = new Date(expiresAt).toISOString();
      return { token, expiresAt: expires, profile: profile.name, company: profile.company, held };
    },

    take(
      token: string,
      profile: string,
    ): { ok: true; calls: Call[] } | { ok: false; error: SnippetError } {
      purge();
      const entry = pending.get(token);
      if (entry === undefined) return { ok: false, error: UNKNOWN_TOKEN };
      if (entry.profile !== profile) {
        return {
          ok: false,
          error: {
            kind: 'invalid_confirmation',
            message: `The confirmation token belongs to profile ${entry.profile}, not ${profile}. Nothing was sent.`,
            hint: `Confirm with account ${entry.profile}.`,
          },
        };
      }
      pending.delete(token);
      return { ok: true, calls: entry.calls };
    },
  };
}
