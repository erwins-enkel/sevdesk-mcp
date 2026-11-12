import { expect, test } from 'vitest';
import { DRAFT_STATUS } from '../src/classify.ts';
import { GUIDES } from '../src/guides.ts';
import { STATUS, statusText } from '../src/status.ts';

// The agreed labels (issue #58), written out here rather than read from the table they check.
const LABELS: Record<string, Record<string, string>> = {
  Order: {
    '100': 'draft',
    '200': 'sent',
    '300': 'rejected or cancelled',
    '500': 'accepted',
    '750': 'partially invoiced',
    '1000': 'invoiced',
  },
  Invoice: {
    '50': 'deactivated',
    '100': 'draft',
    '200': 'open',
    '750': 'partially paid',
    '1000': 'paid',
  },
  CreditNote: { '100': 'draft', '200': 'open', '750': 'partially paid', '1000': 'paid' },
  Voucher: {
    '50': 'draft',
    '100': 'unpaid',
    '150': 'transferred',
    '750': 'partially paid',
    '1000': 'paid',
  },
};

const known = Object.entries(LABELS).flatMap(([type, codes]) =>
  Object.entries(codes).map(([code, label]) => ({ type, code, label })),
);

test.each(known)(
  '$type $code is "$label", as a string and as a number',
  ({ type, code, label }) => {
    expect(statusText(type, code)).toBe(label);
    expect(statusText(type, Number(code))).toBe(label);
  },
);

test.each([
  ['Order', '999'],
  ['Invoice', '300'],
  ['CreditNote', '300'],
  ['CreditNote', '500'],
  ['Voucher', '200'],
])('an unknown code gets no label: %s %s', (type, code) => {
  expect(statusText(type, code)).toBeUndefined();
});

test.each(['Contact', 'constructor', '__proto__', 'toString'])(
  'an unknown type gets no label: %s',
  (type) => {
    expect(statusText(type, '100')).toBeUndefined();
  },
);

test.each([null, undefined, {}, [], ['100'], true, ' 100', '100 ', '0100', 100.5, 'toString'])(
  'a status that is no code gets no label: %j',
  (status) => {
    expect(statusText('Order', status)).toBeUndefined();
  },
);

test('a type that is no string gets no label', () => {
  expect(statusText(undefined, '100')).toBeUndefined();
  expect(statusText({ toString: () => 'Order' }, '100')).toBeUndefined();
});

test('the draft status the confirmation rules allow on a new document is labelled "draft"', () => {
  expect([...DRAFT_STATUS].map(([type, code]) => statusText(type, code))).toEqual(
    [...DRAFT_STATUS].map(() => 'draft'),
  );
});

test('guides.status lists every code of the table with its label and meaning', () => {
  const text = GUIDES.status?.text ?? '';
  const lines = Object.values(STATUS).flatMap((codes) =>
    Object.entries(codes).map(([code, { label, meaning }]) => `- ${code} ${label}: ${meaning}`),
  );

  expect(lines).toHaveLength(known.length);
  expect(lines.filter((line) => !text.includes(line))).toEqual([]);
  expect(text).toContain('sevdesk.statusText(type, status)');
});
