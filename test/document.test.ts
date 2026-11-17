import { describe, expect, test } from 'vitest';
import { compactDocument, isBare } from '../src/document.ts';

// `compactDocument()`, the compact form `sevdesk.getDocument` resolves to (issue #59): every key is
// present, `null` where sevDesk sent no value; texts as plain text unless `html`; line sums as sevDesk
// sends them, else derived in exact decimal arithmetic.

/** The one position of an Order with `position`, compacted. */
function positionOf(position: Record<string, unknown>, html = false) {
  const [compact] = compactDocument('Order', {}, [position], { html }).positions;
  if (compact === undefined) throw new Error('no position');
  return compact;
}

/** The line sums of `position`. */
function sumsOf(position: Record<string, unknown>) {
  const { sumNet, sumGross, sumSource } = positionOf(position);
  return { sumNet, sumGross, sumSource };
}

/** The `headText` of an Order with `headText`, as plain text or, with `html`, as sent. */
function headTextOf(headText: unknown, html = false) {
  return compactDocument('Order', { headText }, [], { html }).headText;
}

test('an offer comes back compact: plain texts, calendar days, numbers, names and its positions in order', () => {
  const offer = {
    id: '7',
    objectName: 'Order',
    orderNumber: 'AN-1006',
    orderType: 'AN',
    status: '100',
    orderDate: '2026-11-10T00:00:00+01:00',
    sendDate: null,
    update: '2026-11-10T10:41:00+01:00',
    contact: { id: '5', objectName: 'Contact', name: 'Beispiel GmbH', customerNumber: '1042' },
    contactPerson: { id: '11', objectName: 'SevUser', fullname: 'Erika Muster' },
    address: 'Beispiel GmbH\nTeststraße 1\n10115 Berlin',
    header: 'Angebot AN-1006',
    headText: '<p>Sehr geehrte Damen und Herren,</p><p>vielen Dank f&uuml;r Ihre Anfrage.</p>',
    footText: '<p>G&uuml;ltig 30&nbsp;Tage.</p>',
    paymentTerms: '14 Tage netto',
    deliveryTerms: null,
    taxRule: { id: '1', objectName: 'TaxRule' },
    taxText: 'zzgl. Umsatzsteuer 19%',
    currency: 'EUR',
    showNet: '1',
    sumNet: '3700',
    sumTax: '703',
    sumGross: '4403',
    customerInternalNote: 'not part of the compact form',
  };
  const positions = [
    {
      positionNumber: '2',
      name: 'Versand',
      text: null,
      quantity: '1',
      unity: { id: '9', objectName: 'Unity', name: 'Pauschal' },
      price: '100',
      priceNet: '100',
      priceGross: '119',
      discount: null,
      taxRate: '19',
      sumNet: '100',
      sumGross: '119',
      optional: false,
    },
    {
      positionNumber: '1',
      name: 'Tisch',
      text: '<p>Eiche, ge&ouml;lt</p>',
      quantity: '3',
      unity: { id: '1', objectName: 'Unity', name: 'Stk' },
      price: '1200',
      priceNet: '1200',
      priceGross: '1428',
      discount: '0',
      taxRate: '19',
      optional: null,
    },
  ];

  expect(compactDocument('Order', offer, positions, { html: false })).toEqual({
    type: 'Order',
    id: '7',
    kind: 'Offer',
    number: 'AN-1006',
    status: '100',
    statusText: 'draft',
    date: '2026-11-10',
    sendDate: null,
    update: '2026-11-10T10:41:00+01:00',
    contact: { id: '5', name: 'Beispiel GmbH', customerNumber: '1042' },
    contactPerson: { id: '11', name: 'Erika Muster' },
    address: 'Beispiel GmbH\nTeststraße 1\n10115 Berlin',
    header: 'Angebot AN-1006',
    headText: 'Sehr geehrte Damen und Herren,\nvielen Dank für Ihre Anfrage.',
    footText: 'Gültig 30 Tage.',
    taxRule: '1',
    taxText: 'zzgl. Umsatzsteuer 19%',
    currency: 'EUR',
    showNet: true,
    sumNet: 3700,
    sumTax: 703,
    sumGross: 4403,
    paymentTerms: '14 Tage netto',
    deliveryTerms: null,
    positions: [
      {
        number: 1,
        name: 'Tisch',
        text: 'Eiche, geölt',
        quantity: 3,
        unity: { id: '1', name: 'Stk' },
        price: 1200,
        priceNet: 1200,
        priceGross: 1428,
        discount: 0,
        taxRate: 19,
        sumNet: 3600,
        sumGross: 4284,
        sumSource: 'derived',
        optional: null,
      },
      {
        number: 2,
        name: 'Versand',
        text: null,
        quantity: 1,
        unity: { id: '9', name: 'Pauschal' },
        price: 100,
        priceNet: 100,
        priceGross: 119,
        discount: null,
        taxRate: 19,
        sumNet: 100,
        sumGross: 119,
        sumSource: 'sevDesk',
        optional: false,
      },
    ],
  });
});

test('html keeps headText, footText and position texts exactly as sevDesk sent them', () => {
  const headText = '<p>Gr&uuml;&szlig;e</p>';
  const footText = '<ul><li>A</li></ul>';
  const compact = compactDocument(
    'Order',
    { headText, footText },
    [{ name: 'Tisch', text: '<b>Eiche</b>' }],
    { html: true },
  );

  expect([compact.headText, compact.footText, compact.positions[0]?.text]).toEqual([
    headText,
    footText,
    '<b>Eiche</b>',
  ]);
});

describe('plain text from HTML', () => {
  test.each([
    [
      'line breaks and paragraphs',
      '<p>Zeile 1<br>Zeile 2<br/>Zeile 3</p><p>Absatz</p>',
      'Zeile 1\nZeile 2\nZeile 3\nAbsatz',
    ],
    ['list items', '<ul><li>Eins</li><li class="x">Zwei</li></ul>', '- Eins\n- Zwei'],
    [
      'named and numeric entities',
      '&auml;&ouml;&uuml;&szlig; &amp; 5&nbsp;&#8364; &#x20AC;',
      'äöüß & 5 € €',
    ],
    ['an encoded tag stays literal text', '<p>&lt;b&gt; ist kein Tag</p>', '<b> ist kein Tag'],
    [
      'other tags are removed',
      '<div><strong>fett</strong> und <span style="x">mehr</span></div>',
      'fett und mehr',
    ],
    ['a "<" before no tag stays text', 'a < b und 3<4', 'a < b und 3<4'],
    ['a tag cut off at the end is removed', '<p>Text</p><scr', 'Text'],
    ['a tag that removing another one forms is removed too', '<<b>script>alert(1)', 'alert(1)'],
    ['CRLF, trailing spaces and blank lines', 'A   \r\nB\r\n\r\n\r\n\r\nC  ', 'A\nB\n\nC'],
    ['an unknown entity stays as it is', 'a &foo; b', 'a &foo; b'],
  ])('%s', (_, html, text) => {
    expect(headTextOf(html)).toBe(text);
  });

  test('a text without content, or none, is null', () => {
    expect([headTextOf('<p></p>'), headTextOf('   '), headTextOf(null), headTextOf(42)]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('line sums', () => {
  test.each([
    [
      'quantity × unit price',
      { quantity: '3', priceNet: '1200', priceGross: '1428' },
      { sumNet: 3600, sumGross: 4284, sumSource: 'derived' },
    ],
    [
      'exact half-up rounding to cents, where floats would round down',
      { quantity: '2.5', priceNet: '19.99', priceGross: '23.79' },
      { sumNet: 49.98, sumGross: 59.48, sumSource: 'derived' },
    ],
    [
      'a percentage discount that sumDiscount confirms',
      {
        quantity: '4',
        price: '50',
        priceNet: '50',
        priceGross: '59.5',
        discount: '10',
        sumDiscount: '20',
      },
      { sumNet: 180, sumGross: 214.2, sumSource: 'derived' },
    ],
    [
      'a discount sumDiscount contradicts',
      {
        quantity: '4',
        price: '50',
        priceNet: '50',
        priceGross: '59.5',
        discount: '10',
        sumDiscount: '5',
      },
      { sumNet: null, sumGross: null, sumSource: null },
    ],
    [
      'a discount without sumDiscount',
      { quantity: '4', price: '50', priceNet: '50', priceGross: '59.5', discount: '10' },
      { sumNet: null, sumGross: null, sumSource: null },
    ],
    [
      'the sums sevDesk sends',
      { quantity: '1', priceNet: '1', priceGross: '1', sumNet: '99', sumGross: '117.81' },
      { sumNet: 99, sumGross: 117.81, sumSource: 'sevDesk' },
    ],
    [
      'numbers instead of decimal strings',
      { quantity: 2, priceNet: 10.5, priceGross: 12.5 },
      { sumNet: 21, sumGross: 25, sumSource: 'derived' },
    ],
    [
      'a negative quantity rounds away from zero',
      { quantity: '-2.5', priceNet: '19.99', priceGross: '23.79' },
      { sumNet: -49.98, sumGross: -59.48, sumSource: 'derived' },
    ],
    [
      'a missing priceNet',
      { quantity: '3', priceGross: '1428' },
      { sumNet: null, sumGross: null, sumSource: null },
    ],
    [
      'a quantity that is not a decimal',
      { quantity: 'drei', priceNet: '1200', priceGross: '1428' },
      { sumNet: null, sumGross: null, sumSource: null },
    ],
  ])('%s', (_, position, sums) => {
    expect(sumsOf(position)).toEqual(sums);
  });
});

describe('names', () => {
  test('an organisation by its name, a person by first and last name', () => {
    const organisation = { id: 5, objectName: 'Contact', name: 'Beispiel GmbH' };
    const person = { id: '6', objectName: 'Contact', surename: ' Max ', familyname: 'Mustermann' };

    expect(
      compactDocument('Order', { contact: organisation }, [], { html: false }).contact,
    ).toEqual({
      id: '5',
      name: 'Beispiel GmbH',
      customerNumber: null,
    });
    expect(compactDocument('Order', { contact: person }, [], { html: false }).contact).toEqual({
      id: '6',
      name: 'Max Mustermann',
      customerNumber: null,
    });
  });

  test.each([
    ['fullname', { fullname: 'Erika Muster', firstName: 'E.', username: 'em' }, 'Erika Muster'],
    [
      'first and last name',
      { firstName: 'Erika', lastName: 'Muster', username: 'em' },
      'Erika Muster',
    ],
    ['username', { username: 'erika' }, 'erika'],
    ['nothing to name it by', {}, null],
  ])('a user by %s', (_, fields, name) => {
    const contactPerson = { id: '11', objectName: 'SevUser', ...fields };
    expect(compactDocument('Order', { contactPerson }, [], { html: false }).contactPerson).toEqual({
      id: '11',
      name,
    });
  });

  test('a bare reference has no name, and a missing one is null', () => {
    const compact = compactDocument(
      'Order',
      { contact: { id: '5', objectName: 'Contact' }, contactPerson: null },
      [{ unity: { id: '1', objectName: 'Unity' } }],
      { html: false },
    );

    expect([compact.contact, compact.contactPerson, compact.positions[0]?.unity]).toEqual([
      { id: '5', name: null, customerNumber: null },
      null,
      { id: '1', name: null },
    ]);
  });
});

test('isBare: only a reference with an id and nothing besides id and objectName', () => {
  expect(isBare({ id: '5', objectName: 'Contact' })).toBe(true);
  expect(isBare({ id: 5 })).toBe(true);
  expect(isBare({ id: '5', objectName: 'Contact', name: 'Beispiel GmbH' })).toBe(false);
  expect(isBare({ objectName: 'Contact' })).toBe(false);
  expect(isBare({ id: null, objectName: 'Contact' })).toBe(false);
  expect(isBare(null)).toBe(false);
  expect(isBare('5')).toBe(false);
});

test('positions are sorted by their number, stably, those without one last', () => {
  const positions = [
    { name: 'ohne A' },
    { name: 'drei', positionNumber: '3' },
    { name: 'eins b', positionNumber: '1' },
    { name: 'ohne B', positionNumber: null },
    { name: 'eins a', positionNumber: 1 },
  ];

  const names = compactDocument('Order', {}, positions, { html: false }).positions.map(
    ({ name }) => name,
  );

  expect(names).toEqual(['eins b', 'eins a', 'drei', 'ohne A', 'ohne B']);
});

test('an empty document has every key, each null', () => {
  expect(compactDocument('CreditNote', {}, [], { html: false })).toEqual({
    type: 'CreditNote',
    id: null,
    kind: 'Credit note',
    number: null,
    status: null,
    statusText: null,
    date: null,
    sendDate: null,
    update: null,
    contact: null,
    contactPerson: null,
    address: null,
    header: null,
    headText: null,
    footText: null,
    taxRule: null,
    taxText: null,
    currency: null,
    showNet: null,
    sumNet: null,
    sumTax: null,
    sumGross: null,
    deliveryDate: null,
    positions: [],
  });
});

test("each type reads its own number, date and further keys; an Order's kind follows its orderType", () => {
  const invoice = compactDocument(
    'Invoice',
    {
      invoiceNumber: 'RE-1001',
      invoiceDate: '2026-11-12T00:00:00+01:00',
      deliveryDate: '2026-11-01T00:00:00+01:00',
      deliveryDateUntil: '2026-11-30T00:00:00+01:00',
      timeToPay: '14',
      discount: '2',
      discountTime: '7',
      showNet: false,
    },
    [],
    { html: false },
  );
  const creditNote = compactDocument(
    'CreditNote',
    { creditNoteNumber: 'GU-1001', creditNoteDate: '2026-11-13T00:00:00+01:00' },
    [],
    { html: false },
  );

  expect(invoice).toMatchObject({
    kind: 'Invoice',
    number: 'RE-1001',
    date: '2026-11-12',
    showNet: false,
    deliveryDate: '2026-11-01',
    deliveryDateUntil: '2026-11-30',
    timeToPay: 14,
    discount: 2,
    discountTime: 7,
  });
  expect(creditNote).toMatchObject({ kind: 'Credit note', number: 'GU-1001', date: '2026-11-13' });
  expect(
    ['AB', 'LI', 'XX'].map(
      (orderType) => compactDocument('Order', { orderType }, [], { html: false }).kind,
    ),
  ).toEqual(['Order confirmation', 'Delivery note', 'Order']);
});
