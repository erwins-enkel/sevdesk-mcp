import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { confirmationReason, OPERATIONS } from '../src/classify.ts';

interface Spec {
  paths: Record<string, Record<string, unknown>>;
}

const embedded = JSON.parse(
  readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8'),
) as Spec;

// The HTTP methods of an OpenAPI 3.0 path item; its other keys (parameters, summary, …) are no
// operations.
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// Path segments PRD §6 names as irreversible.
const IRREVERSIBLE_NAME = /^(?:send\w*|enshrine|bookAmount|cancelInvoice|resetTo\w+|getPdf)$/;

/** Every operation of `spec` as `METHOD /path template`. */
function operationsOf(spec: Spec): string[] {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((key) => HTTP_METHODS.includes(key))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
}

/** The operations of `spec` the classification table lacks. */
function unclassified(spec: Spec): string[] {
  return operationsOf(spec).filter((operation) => !Object.hasOwn(OPERATIONS, operation));
}

test('every operation of the embedded spec is classified, and the table lists no other', () => {
  const operations = operationsOf(embedded);

  expect(operations.length).toBeGreaterThan(0);
  expect(unclassified(embedded)).toEqual([]);
  expect(Object.keys(OPERATIONS).filter((operation) => !operations.includes(operation))).toEqual(
    [],
  );
});

test('a write added to a spec fixture turns the completeness check red', () => {
  const fixture = structuredClone(embedded);
  fixture.paths['/Contact'] = { ...fixture.paths['/Contact'], patch: { operationId: 'patch' } };
  fixture.paths['/Invoice/{invoiceId}/markAsPaid'] = { put: { operationId: 'markAsPaid' } };

  expect(unclassified(fixture)).toEqual(['PATCH /Contact', 'PUT /Invoice/{invoiceId}/markAsPaid']);
});

test('the table follows PRD §6: DELETE, send, enshrine, book, cancel, reset and getPdf are irreversible', () => {
  const entries = Object.entries(OPERATIONS);
  const named = ([operation]: [string, string]) =>
    operation.startsWith('DELETE ') ||
    (operation.split(' ')[1] ?? '').split('/').some((segment) => IRREVERSIBLE_NAME.test(segment));

  expect(entries.filter((entry) => named(entry) && entry[1] !== 'irreversible')).toEqual([]);
  expect(entries.filter((entry) => !named(entry) && entry[1] === 'irreversible')).toEqual([]);
  expect(
    entries.filter(([operation, effect]) =>
      operation.startsWith('GET ') ? effect === 'reversible' : effect === 'read',
    ),
  ).toEqual([]);
});

const none = new URLSearchParams();

test.each([
  { name: 'a new order draft', path: '/Order/Factory/saveOrder', body: { order: { status: 100 } } },
  {
    name: 'a new invoice draft with a string status and id null',
    path: '/Invoice/Factory/saveInvoice',
    body: { invoice: { id: null, status: '100' } },
  },
  {
    name: 'a new voucher draft',
    path: '/Voucher/Factory/saveVoucher',
    body: { voucher: { status: 50 } },
  },
  {
    name: 'an order change without status',
    method: 'PUT',
    path: '/Order/1',
    body: { header: 'x' },
  },
  {
    name: 'the status of a referenced order',
    path: '/Invoice/Factory/createInvoiceFromOrder',
    body: { order: { id: 1, objectName: 'Order', status: 200 } },
  },
  { name: 'a contact status', method: 'PUT', path: '/Contact/1', body: { status: 1000 } },
  { name: 'a forced re-render of an order', path: '/Order/1/render', body: { forceReload: true } },
  {
    name: 'a new voucher draft with voucherPosDelete null, as the guide sends it',
    path: '/Voucher/Factory/saveVoucher',
    body: { voucher: { status: 50 }, voucherPosSave: [], voucherPosDelete: null },
  },
  {
    name: 'an order save with an empty orderPosDelete',
    path: '/Order/Factory/saveOrder',
    body: { order: { id: 5, objectName: 'Order' }, orderPosSave: [], orderPosDelete: [] },
  },
  {
    name: 'an invoice save with invoicePosDelete null and an empty discountDelete',
    path: '/Invoice/Factory/saveInvoice',
    body: { invoice: { id: 5, objectName: 'Invoice' }, invoicePosDelete: null, discountDelete: {} },
  },
  {
    name: 'a credit note save with an empty creditNotePosDelete and discountDelete null',
    path: '/CreditNote/Factory/saveCreditNote',
    body: {
      creditNote: { id: 5, objectName: 'CreditNote' },
      creditNotePosDelete: '',
      discountDelete: null,
    },
  },
])('$name runs directly', ({ method = 'POST', path, body }) => {
  expect(confirmationReason(method, path, none, body)).toBeUndefined();
});

test.each([
  {
    name: 'an order saved with a non-draft status',
    path: '/Order/Factory/saveOrder',
    body: { order: { status: 200 } },
  },
  {
    name: 'a voucher saved as unpaid',
    path: '/Voucher/Factory/saveVoucher',
    body: { voucher: { status: 100 } },
  },
  {
    name: 'an existing invoice saved with the draft status',
    path: '/Invoice/Factory/saveInvoice',
    body: { invoice: { id: 5, status: 100 } },
  },
  {
    name: 'a top-level status on a factory save',
    path: '/Order/Factory/saveOrder',
    body: { status: 100, order: { status: 100 } },
  },
  { name: 'a status in an order update', method: 'PUT', path: '/Order/1', body: { status: 100 } },
  {
    name: 'a status in another write of the type',
    path: '/Invoice/Factory/createInvoiceReminder',
    body: { invoice: { id: 1, objectName: 'Invoice', status: 1000 } },
  },
  { name: 'a write path in other case', method: 'PUT', path: '/contact/1', body: {} },
  { name: 'a named segment where the spec has an id', method: 'PUT', path: '/Order/sendAll' },
])('$name needs confirmation', ({ method = 'POST', path, body }) => {
  expect(confirmationReason(method, path, none, body)).toEqual(expect.any(String));
});

const position = (objectName: string) => ({ id: 7, objectName });

test.each([
  {
    name: 'an invoice save with invoicePosDelete',
    path: '/Invoice/Factory/saveInvoice',
    body: { invoice: { id: 5, objectName: 'Invoice' }, invoicePosDelete: [position('InvoicePos')] },
    key: 'invoicePosDelete',
  },
  {
    name: 'an invoice save with discountDelete',
    path: '/Invoice/Factory/saveInvoice',
    body: { invoice: { id: 5, objectName: 'Invoice' }, discountDelete: position('Discounts') },
    key: 'discountDelete',
  },
  {
    name: 'an order save with orderPosDelete',
    path: '/Order/Factory/saveOrder',
    body: { order: { id: 5, objectName: 'Order' }, orderPosDelete: [position('OrderPos')] },
    key: 'orderPosDelete',
  },
  {
    name: 'a credit note save with creditNotePosDelete',
    path: '/CreditNote/Factory/saveCreditNote',
    body: {
      creditNote: { id: 5, objectName: 'CreditNote' },
      creditNotePosDelete: position('CreditNotePos'),
    },
    key: 'creditNotePosDelete',
  },
  {
    name: 'a credit note save with discountDelete',
    path: '/CreditNote/Factory/saveCreditNote',
    body: {
      creditNote: { id: 5, objectName: 'CreditNote' },
      discountDelete: [position('Discounts')],
    },
    key: 'discountDelete',
  },
  {
    name: 'a new voucher draft with voucherPosDelete',
    path: '/Voucher/Factory/saveVoucher',
    body: { voucher: { status: 50 }, voucherPosDelete: position('VoucherPos') },
    key: 'voucherPosDelete',
  },
  {
    name: 'a delete key in other case',
    path: '/Order/Factory/saveOrder',
    body: { order: { id: 5, objectName: 'Order' }, OrderPosDelete: [position('OrderPos')] },
    key: 'OrderPosDelete',
  },
  {
    name: 'a delete key on another write path',
    method: 'PUT',
    path: '/Order/5',
    body: { header: 'x', orderPosDelete: [position('OrderPos')] },
    key: 'orderPosDelete',
  },
  {
    name: 'a delete key whose list holds only null',
    path: '/Order/Factory/saveOrder',
    body: { order: { id: 5, objectName: 'Order' }, orderPosDelete: [null] },
    key: 'orderPosDelete',
  },
])('$name deletes data and needs confirmation', ({ method = 'POST', path, body, key }) => {
  expect(confirmationReason(method, path, none, body)).toContain(`${key} in its body`);
});
