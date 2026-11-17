// sevDesk documents as the model reads them: the vocabulary the confirmation preview (decision 9)
// and `sevdesk.getDocument` (issue #59) share, what getDocument reads for a document, and the
// compact form it resolves to.
import { decodeHTML } from 'entities';
import { statusText } from './status.ts';

/**
 * The document types a preview reads, with their kind and the fields holding their number and date.
 * A voucher's description is essentially its number (the receipt number).
 */
export const DOCUMENTS = {
  Order: { label: 'Order', number: 'orderNumber', date: 'orderDate' },
  Invoice: { label: 'Invoice', number: 'invoiceNumber', date: 'invoiceDate' },
  CreditNote: { label: 'Credit note', number: 'creditNoteNumber', date: 'creditNoteDate' },
  Voucher: { label: 'Voucher', number: 'description', date: 'voucherDate' },
} satisfies Record<string, { label: string; number: string; date: string }>;

/** A type of `DOCUMENTS`. */
export type DocumentType = keyof typeof DOCUMENTS;

/** Whether `type` is one of `DOCUMENTS`. */
export function isDocumentType(type: string): type is DocumentType {
  return Object.hasOwn(DOCUMENTS, type);
}

// An Order by its orderType.
const ORDER_LABELS: Record<string, string> = {
  AN: 'Offer',
  AB: 'Order confirmation',
  LI: 'Delivery note',
};

// sevDesk answers dates as ISO 8601 with the Berlin offset; the first 10 characters are the
// calendar day (guides.dates).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
export function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A sum as sevDesk answers it (a decimal string, or a number) as a number, or undefined. */
export function numberOf(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

/** The calendar day of an ISO 8601 date, as `YYYY-MM-DD`, or undefined. */
export function dateOf(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_DATE.test(value) ? value.slice(0, 10) : undefined;
}

/** The kind of `document` of `type`: an Order by its orderType, else the type's label. */
export function kindOf(type: DocumentType, document: Record<string, unknown>): string {
  const { label } = DOCUMENTS[type];
  return type === 'Order' ? (ORDER_LABELS[String(document.orderType)] ?? label) : label;
}

/** A query of a positions call: filter values as `sevdesk.request` takes them. */
type Query = Record<string, string>;

/**
 * What `getDocument` reads per type besides the document: where its positions are (sevDesk does not
 * put them into the document's answer, guides.pagination), and the keys only that type has.
 */
const READS = {
  Order: {
    positions: (id: string) => ({ path: `/Order/${id}/getPositions`, query: {} }),
    keys: (document: Record<string, unknown>) => ({
      paymentTerms: text(document.paymentTerms),
      deliveryTerms: text(document.deliveryTerms),
    }),
  },
  Invoice: {
    positions: (id: string) => ({ path: `/Invoice/${id}/getPositions`, query: {} }),
    keys: (document: Record<string, unknown>) => ({
      deliveryDate: day(document.deliveryDate),
      deliveryDateUntil: day(document.deliveryDateUntil),
      timeToPay: number(document.timeToPay),
      discount: number(document.discount),
      discountTime: number(document.discountTime),
    }),
  },
  CreditNote: {
    positions: (id: string) => ({
      path: '/CreditNotePos',
      query: { 'creditNote[id]': id, 'creditNote[objectName]': 'CreditNote' },
    }),
    keys: (document: Record<string, unknown>) => ({ deliveryDate: day(document.deliveryDate) }),
  },
} satisfies Record<
  string,
  {
    positions: (id: string) => { path: string; query: Query };
    keys: (document: Record<string, unknown>) => Record<string, unknown>;
  }
>;

/** The document types `getDocument` reads. */
export type ReadableType = keyof typeof READS;

/** The call that lists the positions of document `id` of `type`: its path and filter query. */
export function positionsCall(type: ReadableType, id: string): { path: string; query: Query } {
  return READS[type].positions(id);
}

/**
 * Whether `reference` is a bare reference sevDesk did not embed: an object with an `id` and no keys
 * besides `id` and `objectName`.
 */
export function isBare(reference: unknown): reference is { id: string | number } {
  return (
    isRecord(reference) &&
    (typeof reference.id === 'string' || typeof reference.id === 'number') &&
    Object.keys(reference).every((key) => key === 'id' || key === 'objectName')
  );
}

/** A non-empty string as sevDesk sent it, else null. */
function text(value: unknown): string | null {
  return textOf(value) ?? null;
}

/** A number from a decimal string or a number, else null. */
function number(value: unknown): number | null {
  return numberOf(value) ?? null;
}

/** The calendar day of an ISO 8601 date, else null. */
function day(value: unknown): string | null {
  return dateOf(value) ?? null;
}

/** An id or code (sevDesk sends them as strings, sometimes as numbers) as text, else null. */
function code(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return text(value);
}

/** A flag sevDesk sends as a boolean, `1`/`0` or `"1"`/`"0"`, else null. */
function flag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

/** The non-blank parts, trimmed and joined with a space, or undefined when there are none. */
function joined(...parts: unknown[]): string | undefined {
  const words = parts.flatMap((part) => textOf(part)?.trim() ?? []);
  return words.length > 0 ? words.join(' ') : undefined;
}

/** A contact: an organisation by its name, a person by first and last name. */
function contactOf(contact: unknown) {
  if (!isRecord(contact)) return null;
  return {
    id: code(contact.id),
    name: textOf(contact.name)?.trim() ?? joined(contact.surename, contact.familyname) ?? null,
    customerNumber: text(contact.customerNumber),
  };
}

/** A sevDesk user (the document's contact person): by full name, first and last name, username. */
function userOf(user: unknown) {
  if (!isRecord(user)) return null;
  const name =
    textOf(user.fullname)?.trim() ?? joined(user.firstName, user.lastName) ?? text(user.username);
  return { id: code(user.id), name };
}

/** A unit of a position. */
function unityOf(unity: unknown) {
  if (!isRecord(unity)) return null;
  return { id: code(unity.id), name: text(unity.name) };
}

// A tag as a browser reads one: `<` and a letter, `/`, `!` or `?`, up to the next `>` or the end of
// the text. A `<` before anything else (`a < b`) is text.
const TAG = /<[a-z/!?][^>]*(?:>|$)/gi;

/**
 * `html` without its tags, removed until none is left: removing one can join its neighbours into
 * another.
 */
function withoutTags(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(TAG, '');
  } while (text !== previous);
  return text;
}

/**
 * A text as plain text: line breaks for `<br>` and the end of paragraphs, list items and rows, `- `
 * for a list item, no other tags (`withoutTags`), HTML entities decoded (sevDesk's editor may store
 * an umlaut as `&uuml;`), trailing spaces and runs of blank lines removed. A text without content
 * is null.
 */
function htmlToText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const marked = value
    .replace(/\r\n?/g, '\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, '\n');
  const plain = decodeHTML(withoutTags(marked))
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain === '' ? null : plain;
}

/** An exact decimal: `digits` / 10^`scale`. */
interface Decimal {
  digits: bigint;
  scale: number;
}

const DECIMAL = /^(-?\d+)(?:\.(\d+))?$/;

/** A decimal string or a finite number as an exact decimal, else undefined. */
function decimalOf(value: unknown): Decimal | undefined {
  const written = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof written !== 'string') return undefined;
  const [, whole, fraction = ''] = DECIMAL.exec(written.trim()) ?? [];
  if (whole === undefined) return undefined;
  return { digits: BigInt(whole + fraction), scale: fraction.length };
}

/** The exact product of `factors`. */
function product(...factors: Decimal[]): Decimal {
  return factors.reduce((a, b) => ({ digits: a.digits * b.digits, scale: a.scale + b.scale }), {
    digits: 1n,
    scale: 0,
  });
}

/** `value` in whole cents, rounded half away from zero. */
function cents({ digits, scale }: Decimal): bigint {
  if (scale <= 2) return digits * 10n ** BigInt(2 - scale);
  const divisor = 10n ** BigInt(scale - 2);
  const size = digits < 0n ? -digits : digits;
  const rounded = size / divisor + ((size % divisor) * 2n >= divisor ? 1n : 0n);
  return digits < 0n ? -rounded : rounded;
}

/** An amount in whole cents as a number. */
function amount(value: bigint): number {
  return Number(value) / 100;
}

/**
 * What remains of a position's amount after its discount, (100 − discount) / 100: all of it without
 * a discount. A discount is read as a percentage only when sevDesk's `sumDiscount` confirms it
 * (quantity × price × discount / 100 within a cent of it); otherwise, or when it is no decimal, the
 * share is undefined.
 */
function remainingShare(position: Record<string, unknown>, quantity: Decimal) {
  if (position.discount === undefined || position.discount === null)
    return { digits: 1n, scale: 0 };
  const discount = decimalOf(position.discount);
  if (discount === undefined) return undefined;
  if (discount.digits === 0n) return { digits: 1n, scale: 0 };
  const price = decimalOf(position.price);
  const sumDiscount = decimalOf(position.sumDiscount);
  if (price === undefined || sumDiscount === undefined) return undefined;
  const percent = { digits: 1n, scale: 2 };
  const expected = cents(product(quantity, price, discount, percent));
  const gap = expected - cents(sumDiscount);
  if (gap > 1n || gap < -1n) return undefined;
  const hundred = 100n * 10n ** BigInt(discount.scale);
  return { digits: hundred - discount.digits, scale: discount.scale + 2 };
}

/** Line sums that could not be derived. */
const NO_SUMS = { sumNet: null, sumGross: null, sumSource: null };

/**
 * A position's net and gross line sums: those sevDesk sends (`sumNet` and `sumGross`), else derived
 * exactly from quantity × priceNet and quantity × priceGross less a confirmed percentage discount,
 * rounded half away from zero to cents. `sumSource` says which; without the fields to derive them
 * from, both sums are null.
 */
function positionSums(position: Record<string, unknown>): {
  sumNet: number | null;
  sumGross: number | null;
  sumSource: 'sevDesk' | 'derived' | null;
} {
  const sentNet = numberOf(position.sumNet);
  const sentGross = numberOf(position.sumGross);
  if (sentNet !== undefined && sentGross !== undefined) {
    return { sumNet: sentNet, sumGross: sentGross, sumSource: 'sevDesk' };
  }
  const quantity = decimalOf(position.quantity);
  const priceNet = decimalOf(position.priceNet);
  const priceGross = decimalOf(position.priceGross);
  if (quantity === undefined || priceNet === undefined || priceGross === undefined) return NO_SUMS;
  const share = remainingShare(position, quantity);
  if (share === undefined) return NO_SUMS;
  return {
    sumNet: amount(cents(product(quantity, priceNet, share))),
    sumGross: amount(cents(product(quantity, priceGross, share))),
    sumSource: 'derived',
  };
}

/** A position, compacted; `toText` turns its text into what the result shows. */
function positionOf(value: unknown, toText: (value: unknown) => string | null) {
  const position = isRecord(value) ? value : {};
  return {
    number: number(position.positionNumber),
    name: text(position.name),
    text: toText(position.text),
    quantity: number(position.quantity),
    unity: unityOf(position.unity),
    price: number(position.price),
    priceNet: number(position.priceNet),
    priceGross: number(position.priceGross),
    discount: number(position.discount),
    taxRate: number(position.taxRate),
    ...positionSums(position),
    optional: flag(position.optional),
  };
}

/** A position's place: by its number, those without one last. */
function rank(position: { number: number | null }): number {
  return position.number ?? Number.POSITIVE_INFINITY;
}

/**
 * The compact form of `document` of `type` with its `positions` (issue #59), as
 * `sevdesk.getDocument` resolves to it. Every key is present, null where sevDesk sent no value.
 * Dates are calendar days, amounts numbers, `status` sevDesk's code with its label in `statusText`
 * (`src/status.ts`, null for a code without one). headText, footText and the positions' texts are
 * plain text unless `html`, which keeps them as sevDesk sent them. Positions are sorted by their
 * number, stably, those without one last.
 */
export function compactDocument(
  type: ReadableType,
  document: Record<string, unknown>,
  positions: unknown[],
  { html }: { html: boolean },
) {
  const { number: numberField, date } = DOCUMENTS[type];
  const toText = html ? text : htmlToText;
  const taxRule = isRecord(document.taxRule) ? document.taxRule.id : undefined;
  return {
    type,
    id: code(document.id),
    kind: kindOf(type, document),
    number: text(document[numberField]),
    status: code(document.status),
    statusText: statusText(type, document.status) ?? null,
    date: day(document[date]),
    sendDate: day(document.sendDate),
    update: text(document.update),
    contact: contactOf(document.contact),
    contactPerson: userOf(document.contactPerson),
    address: text(document.address),
    header: text(document.header),
    headText: toText(document.headText),
    footText: toText(document.footText),
    taxRule: code(taxRule),
    taxText: text(document.taxText),
    currency: text(document.currency),
    showNet: flag(document.showNet),
    sumNet: number(document.sumNet),
    sumTax: number(document.sumTax),
    sumGross: number(document.sumGross),
    ...READS[type].keys(document),
    positions: positions
      .map((position) => positionOf(position, toText))
      .sort((a, b) => rank(a) - rank(b) || 0),
  };
}
