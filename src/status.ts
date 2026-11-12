/** A document status: its English label and what it means, in one line. */
interface Status {
  label: string;
  meaning: string;
}

/**
 * The status codes of orders, invoices, credit notes and vouchers (issue #58), by objectName and
 * code as sevDesk returns it, from the spec's status tables. Labels say what a status means; a
 * meaning names sevDesk's own term where the label differs. One table for every orderType (AN, AB,
 * LI), as the spec states. `statusText()` and `guides.status` both read it.
 */
export const STATUS: Record<string, Record<string, Status>> = {
  Order: {
    '100': { label: 'draft', meaning: 'not sent yet, still editable' },
    '200': { label: 'sent', meaning: 'sent to the customer (sevDesk: Delivered)' },
    '300': {
      label: 'rejected or cancelled',
      meaning: 'the customer rejected it, or it was cancelled',
    },
    '500': { label: 'accepted', meaning: 'the customer accepted it' },
    '750': {
      label: 'partially invoiced',
      meaning: 'an invoice covers part of the order (sevDesk: Partially Calculated)',
    },
    '1000': {
      label: 'invoiced',
      meaning: 'invoices cover the whole order (sevDesk: Calculated)',
    },
  },
  Invoice: {
    '50': { label: 'deactivated', meaning: 'a deactivated recurring invoice (invoiceType WKR)' },
    '100': { label: 'draft', meaning: 'not sent yet, still editable' },
    '200': {
      label: 'open',
      meaning:
        'sent, not paid; sevDesk shows it as due once its payment deadline has passed (sevDesk: Open / Due). An invoice partially paid before sevDesk release 4.181 (2024-06-13) stayed at 200: check it with GET /Invoice/{invoiceId}/getIsPartiallyPaid',
    },
    '750': { label: 'partially paid', meaning: 'payments cover part of it' },
    '1000': { label: 'paid', meaning: 'payments cover all of it' },
  },
  CreditNote: {
    '100': { label: 'draft', meaning: 'not sent yet, still editable' },
    '200': {
      label: 'open',
      meaning: 'sent to the customer, not paid yet (sevDesk: Open / Delivered)',
    },
    '750': { label: 'partially paid', meaning: 'payments cover part of it' },
    '1000': { label: 'paid', meaning: 'payments cover all of it' },
  },
  Voucher: {
    '50': { label: 'draft', meaning: 'not completed yet, still editable' },
    '100': {
      label: 'unpaid',
      meaning:
        'completed, not paid; sevDesk shows it as due once its payment deadline has passed (sevDesk: Unpaid / Due)',
    },
    '150': {
      label: 'transferred',
      meaning:
        'a payment was created in sevDesk; the bank transaction that marks it paid has not been imported yet',
    },
    '750': { label: 'partially paid', meaning: 'payments cover part of it' },
    '1000': { label: 'paid', meaning: 'payments cover all of it' },
  },
};

/**
 * The label of status `status` of a document of type `type` (its objectName, e.g. `Order`), for
 * `sevdesk.statusText`. `status` is the code as a number or as the string sevDesk returns. Any
 * other type, code or value has no label: undefined, never a guess.
 */
export function statusText(type: unknown, status: unknown): string | undefined {
  if (typeof type !== 'string' || !Object.hasOwn(STATUS, type)) return undefined;
  const code = typeof status === 'number' ? String(status) : status;
  const codes = STATUS[type];
  if (typeof code !== 'string' || codes === undefined || !Object.hasOwn(codes, code)) {
    return undefined;
  }
  return codes[code]?.label;
}
