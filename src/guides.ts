import { PAGE_SIZE } from './sevdesk.ts';

/** A curated recipe for the model (PRD §5.4): a title to find it and its English text. */
interface Guide {
  title: string;
  text: string;
}

/**
 * The guides `search` offers as `guides`, by id. They know only bookkeeping system 2.0. Every
 * endpoint in a text is written `METHOD /path` with the spec's path template, never as a bare path:
 * test/guides.test.ts checks each against the patched spec.
 */
export const GUIDES: Record<string, Guide> = {
  offer: {
    title: 'Create an offer (Order with orderType "AN") via saveOrder',
    text: `An offer is an Order with orderType "AN" (AB = order confirmation, LI = delivery note).
1. Contact: GET /Contact with query { name, depth: 1 } (depth 1 includes persons; name matches name, surename or familyname) or { customerNumber }. If there is none, create the company, its contact person, the address and the email:
- POST /Contact with { "name": "<company>", "category": { "id": 3, "objectName": "Category" } } (3 = customer)
- POST /Contact with { "surename": "<first name>", "familyname": "<last name>", "parent": { "id": <company id>, "objectName": "Contact" }, "category": { "id": 3, "objectName": "Category" } } (the contact person; surename is the first name)
- POST /ContactAddress with { "contact": { "id": <company id>, "objectName": "Contact" }, "street": "<street>", "zip": "<zip>", "city": "<city>", "country": { "id": <country id>, "objectName": "StaticCountry" }, "category": { "id": <category id>, "objectName": "Category" } } (country id from GET /StaticCountry, category id from GET /Category with { objectType: "ContactAddress" })
- POST /CommunicationWay with { "contact": { "id": <person id>, "objectName": "Contact" }, "type": "EMAIL", "value": "<email>", "key": { "id": <key id>, "objectName": "CommunicationWayKey" }, "main": true } (key id from GET /CommunicationWayKey, 2 = Arbeit)
2. contactPerson: a user id from GET /SevUser.
3. orderNumber: GET /SevSequence/Factory/getByType with { objectType: "Order", type: "AN" } gives the format and nextSequence of the next offer number.
4. Units: GET /Unity lists the unit ids for positions.
5. POST /Order/Factory/saveOrder:
{
  "order": {
    "objectName": "Order", "mapAll": true, "orderType": "AN", "status": 100, "version": 0,
    "orderNumber": "<next number>", "header": "Angebot <next number>", "orderDate": "09.11.2026",
    "contact": { "id": <contact id>, "objectName": "Contact" },
    "contactPerson": { "id": <user id>, "objectName": "SevUser" },
    "taxRule": { "id": "1", "objectName": "TaxRule" }, "taxText": "zzgl. Umsatzsteuer 19%",
    "currency": "EUR", "showNet": true, "address": "<company>\\n<street>\\n<zip> <city>"
  },
  "orderPosSave": [
    { "objectName": "OrderPos", "mapAll": true, "name": "<item>", "quantity": 3, "price": 1200,
      "unity": { "id": <unit id>, "objectName": "Unity" }, "taxRate": 19 }
  ]
}
Required in order: orderNumber, orderDate, contact, status, contactPerson, taxRule, taxText, currency, header, version, mapAll, orderType. Required per position: quantity, unity, taxRate. status 100 is a draft, which stays editable; sending is a separate step (guides.delivery). With showNet true, price is the net price. Tax rules and rates: guides.taxRules; dates: guides.dates.
The answer is { objects: { order, orderPos } }; objects.order.id is the new offer's id.`,
  },

  taxRules: {
    title: 'Tax rules (taxRule) in bookkeeping system 2.0',
    text: `sevdesk-mcp works only with accounts on bookkeeping system 2.0 (GET /Tools/bookkeepingSystemVersion answers { objects: { version: "2.0" } }). Orders, invoices, credit notes and vouchers carry a taxRule, { "id": "<id>", "objectName": "TaxRule" } with the id as a string. Never send taxType or taxSet (system 1.0). The rate sits on each position (taxRate) and must be one the rule allows, otherwise sevDesk answers 422.
Revenue (orders, invoices, credit notes), rule id: allowed taxRate
- 1 Umsatzsteuerpflichtige Umsätze: 0, 7, 19
- 2 Ausfuhren: 0
- 3 Innergemeinschaftliche Lieferungen: 0, 7, 19
- 4 Steuerfreie Umsätze §4 UStG: 0
- 5 Reverse Charge gem. §13b UStG: 0
- 21 Reverse Charge gem. §18b UStG: 0
- 17 Nicht im Inland steuerbare Leistung: 0
- 18, 19, 20 One Stop Shop (goods, electronic service, other service): the rate of the delivery country
- 11 Steuer nicht erhoben nach §19 UStG (Kleinunternehmer): 0, with smallSettlement true
Expense (vouchers): 8 Innergemeinschaftliche Erwerbe (0, 7, 19), 9 Vorsteuerabziehbare Aufwendungen (0, 7, 19), 10 Nicht vorsteuerabziehbare Aufwendungen (0), 12 Reverse Charge §13b Abs. 2 mit Vorsteuerabzug (0), 13 Reverse Charge §13b ohne Vorsteuerabzug (0), 14 Reverse Charge §13b Abs. 1 EU Umsätze (0).
taxText names the rule on the document, e.g. "zzgl. Umsatzsteuer 19%". For vouchers, GET /ReceiptGuidance/forExpense and GET /ReceiptGuidance/forRevenue list the booking accounts with the tax rules and rates each allows. The full table with unsupported use cases: spec.info.description, section "Tax Rules".`,
  },

  invoiceFromOffer: {
    title: 'Create an invoice from an offer',
    text: `POST /Invoice/Factory/createInvoiceFromOrder with { "order": { "id": <order id>, "objectName": "Order" } } creates an invoice from an order (an offer AN or an order confirmation AB). For part of the amount add "type" ("percentage", "net" or "gross"), "amount" and "partialType" ("AR" advance invoice, "TR" partial invoice; see the schema). The tax rules 17 to 21 allow no advance, partial or final invoices, and a final invoice cannot be created while an advance or partial invoice of the order exists.
Read the new invoice's id and status from the answer (invoice status 100 draft, 200 open or due, 1000 paid). The order then has status 750 (partially calculated) or 1000 (calculated).
The next steps are separate: the PDF with sevdesk.savePdf('Invoice', id); sending with POST /Invoice/{invoiceId}/sendViaEmail or PUT /Invoice/{invoiceId}/sendBy as in guides.delivery. Enshrining with PUT /Invoice/{invoiceId}/enshrine cannot be undone.`,
  },

  receiptWithFile: {
    title: 'Receipt (voucher) with a file',
    text: `A receipt is a Voucher. Attaching a file takes two calls:
1. POST /Voucher/Factory/uploadTempFile as multipart/form-data with the field "file" (PDF, image or XML e-invoice). The answer's objects.filename is the temporary file name. sevdesk.request sends JSON bodies only, so it cannot do this upload.
2. POST /Voucher/Factory/saveVoucher with the voucher, its positions and that file name:
{
  "voucher": {
    "objectName": "Voucher", "mapAll": true, "voucherType": "VOU", "creditDebit": "C",
    "status": 50, "voucherDate": "09.11.2026", "description": "<receipt number>",
    "supplier": { "id": <contact id>, "objectName": "Contact" },
    "taxRule": { "id": "9", "objectName": "TaxRule" }
  },
  "voucherPosSave": [
    { "objectName": "VoucherPos", "mapAll": true, "net": false, "sumGross": 119, "taxRate": 19,
      "accountDatev": { "id": <accountDatevId>, "objectName": "AccountDatev" } }
  ],
  "voucherPosDelete": null,
  "filename": "<objects.filename>"
}
creditDebit "C" is an expense (you bought something), "D" revenue (you sold something). Without a supplier contact, give supplierName instead. status is 50 (draft) or 100 (unpaid), and saving with 100 needs confirmation; a voucher becomes paid only through PUT /Voucher/{voucherId}/bookAmount and is enshrined only through PUT /Voucher/{voucherId}/enshrine, which cannot be undone. The booking account (accountDatevId) and the tax rules and rates it allows come from GET /ReceiptGuidance/forExpense (GET /ReceiptGuidance/forRevenue for "D"). With net true give sumNet instead of sumGross; all positions are either net or gross.`,
  },

  pagination: {
    title: 'Lists, filters and pagination',
    text: `A list answers { "objects": [...] }; with countAll=true it adds "total". limit (1 to 1000) and offset page through it: GET /Contact with { limit: 100, offset: 100 } returns the second hundred. sevdesk.paginate(path, query) collects all pages, ${String(PAGE_SIZE)} objects each, and every page counts as a call, so narrow the list with filters first.
Filters go into query as sevDesk writes them, nested ones with brackets: GET /Order with { "contact[id]": 123, "contact[objectName]": "Contact", orderType: "AN" }. A resource's filters are in its tag description, section "How to filter", e.g. spec.tags.find((t) => t.name === "Invoice").description. embed returns nested objects in full instead of { id, objectName }, e.g. { embed: "contact" }.
GET /Contact returns only organisations unless depth is 1. Positions are not part of a document's answer: GET /Order/{orderId}/getPositions, GET /InvoicePos with invoice[id] and invoice[objectName], GET /VoucherPos with voucher[id] and voucher[objectName].`,
  },

  dates: {
    title: 'Date formats and time zone',
    text: `sevDesk keeps dates in German time (Europe/Berlin).
- Sending: document dates (orderDate, invoiceDate, voucherDate, deliveryDate) take "dd.mm.yyyy", e.g. "09.11.2026", or a Unix timestamp. Prefer "dd.mm.yyyy": it is the calendar day as written, with no time zone to get wrong.
- Reading: sevDesk returns ISO 8601 with the Berlin offset, "+01:00" in winter and "+02:00" in summer, e.g. "2026-11-09T00:00:00+01:00". A document date is local midnight, so take the calendar day from the first 10 characters; converting it to UTC first (new Date(...).toISOString()) shifts it to the previous day.
- Filtering: list filters such as startDate, endDate, createBefore, createAfter, updateBefore and updateAfter take Unix timestamps in seconds. For a whole day use local midnight in Europe/Berlin: 09.11.2026 starts at 1794178800 (2026-11-08T23:00:00Z).`,
  },

  delivery: {
    title: 'Sending: sevDesk mail or PDF only, and marking as sent (sendBy)',
    text: `Two ways to deliver an offer; invoices and credit notes work the same with their own endpoints.
1. sevDesk mail: POST /Order/{orderId}/sendViaEmail with { "toEmail": "<address>", "subject": "Angebot <number>", "text": "<p>…</p>" } (text may contain HTML; optional copy, ccEmail and bccEmail as comma-separated strings, additionalAttachments as comma-separated document ids). sevDesk mails the PDF and marks the order as sent (status 200); after that it can no longer be changed. Irreversible.
2. PDF only: sevdesk.savePdf('Order', id) saves the PDF in the profile's download folder without marking anything; the user sends it themselves and the status stays 100 (draft). Never call GET /Order/{orderId}/getPdf without preventSendBy=true: it can mark the document as sent.
Marking as sent is a separate step, only after the user says it went out: PUT /Order/{orderId}/sendBy with { "sendType": "VPDF", "sendDraft": false } (VPDF downloaded PDF, VM mail, VP postal, VPR print) sets status 200 (delivered) and is irreversible. Do not set status 200 through POST /Order/Factory/saveOrder or PUT /Order/{orderId} instead.
Invoices: POST /Invoice/{invoiceId}/sendViaEmail, PUT /Invoice/{invoiceId}/sendBy, sevdesk.savePdf('Invoice', id). Credit notes: POST /CreditNote/{creditNoteId}/sendViaEmail, PUT /CreditNote/{creditNoteId}/sendBy, sevdesk.savePdf('CreditNote', id).`,
  },
};
