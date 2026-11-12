import { getPdfAnswer, sevdeskPdf } from './sevdesk-pdf.ts';

// sevDesk's answers to the endpoints whose real shape test/sevdesk-shapes.json records (issue #60),
// as the mock gives them: each has every recorded field, with a type the real answer had.
// test/response-shapes.test.ts checks them against the recording. Tests that model sevDesk's real
// answers build on them, as the Priority A account (test/priority-a.test.ts) does; tests of single
// behaviours keep their own small answers.

type Row = Record<string, unknown>;

/** The test company as GET /Contact lists it. */
export const CONTACT: Row = { id: '7', objectName: 'Contact', name: 'MCP Test GmbH' };

/**
 * The offer draft AN-1042 as GET /Order/{orderId} answers it: 3 days at 1,200 EUR net with 19 %
 * tax, last changed after its date.
 */
export const ORDER: Row = {
  id: '42',
  objectName: 'Order',
  orderNumber: 'AN-1042',
  orderType: 'AN',
  orderDate: '2026-11-09T00:00:00+01:00',
  status: '100',
  update: '2026-11-09T10:15:00+01:00',
  sendDate: null,
  header: 'Angebot AN-1042',
  headText: 'Vielen Dank für Ihre Anfrage.',
  address: 'MCP Test GmbH\nMusterstraße 1\n10115 Berlin',
  currency: 'EUR',
  sumNet: '3600',
  sumGross: '4284',
};

/** The one position of `ORDER`. */
const POSITION: Row = {
  id: '100',
  objectName: 'OrderPos',
  name: 'KI-Workshop',
  quantity: '3',
  price: '1200',
  taxRate: '19',
  unity: { id: '4', objectName: 'Unity' },
};

/** An open invoice as GET /Invoice/{invoiceId} answers it. */
const INVOICE: Row = {
  id: '9',
  objectName: 'Invoice',
  invoiceNumber: 'RE-1001',
  invoiceDate: '2026-11-09T00:00:00+01:00',
  status: '200',
  update: '2026-11-09T10:15:00+01:00',
  address: 'MCP Test GmbH\nMusterstraße 1\n10115 Berlin',
  currency: 'EUR',
  sumNet: '3600',
  sumGross: '4284',
};

/** The answer of each recorded endpoint (`METHOD /path template`) as the mock gives it. */
export const ANSWERS = {
  'GET /Contact': (contacts: Row[] = [CONTACT]) => ({ objects: contacts }),
  'GET /SevSequence/Factory/getByType': () => ({
    objects: { format: 'AN-%NUMBER', nextSequence: 1042 },
  }),
  'POST /Order/Factory/saveOrder': (order: Row = ORDER, positions: Row[] = [POSITION]) => ({
    objects: { order, orderPos: positions },
  }),
  'GET /Order/{orderId}': (order: Row = ORDER) => ({ objects: [order] }),
  'GET /Order/{orderId}/getPositions': (positions: Row[] = [POSITION]) => ({ objects: positions }),
  'GET /Order/{orderId}/getPdf': (pdf: Buffer = sevdeskPdf()) => getPdfAnswer(pdf),
  'POST /Order/{orderId}/render': (pdf: Buffer = sevdeskPdf()) => ({
    objects: { pdf: pdf.toString('base64'), docId: 'd4605b19248ad176443b7cb382679b1f' },
  }),
  'GET /Invoice/{invoiceId}': (invoice: Row = INVOICE) => ({ objects: [invoice] }),
};
