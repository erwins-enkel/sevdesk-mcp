// The classification of sevDesk calls (PRD §6, decisions 6 and 7): which calls change the
// account's data irreversibly and need the human's confirmation, and which run directly.

/**
 * What an operation of the sevDesk API does to the account's data: `read` changes nothing,
 * `reversible` creates or changes data that can be changed back (drafts, contacts, settings),
 * `irreversible` cannot be undone and needs confirmation.
 */
type Effect = 'read' | 'reversible' | 'irreversible';

/**
 * Every operation of the patched spec, `METHOD /path template` in spec order, with its effect.
 * test/classify.test.ts fails when the spec has an operation the table lacks or the table one the
 * spec lacks, so a spec update cannot bring in an unclassified path.
 *
 * Irreversible: every DELETE; sending (`sendViaEmail`, `sendBy`, `sendByWithRender`);
 * `enshrine`, `bookAmount` and `cancelInvoice`; `resetToOpen` and `resetToDraft`; `getPdf`, which
 * can mark the document as sent unless `preventSendBy=true` (decision 7). No operation hands files
 * to a third party: every export returns its file or job id to the caller, and a DATEV export
 * that enshrines its documents is caught by its enshrine flag (`ENSHRINE_FLAG`). A reversible
 * write can still delete what its body names, which `deletion` catches (a factory save's
 * `orderPosDelete`, …), or change a document's status, which `statusChange` catches (decision 6).
 * `render` is reversible: it renders the stored PDF again from the document's data and changes no
 * status.
 */
export const OPERATIONS: Record<string, Effect> = {
  'GET /Tools/bookkeepingSystemVersion': 'read',
  'GET /CheckAccount': 'read',
  'POST /CheckAccount/Factory/fileImportAccount': 'reversible',
  'POST /CheckAccount/Factory/clearingAccount': 'reversible',
  'GET /CheckAccount/{checkAccountId}': 'read',
  'PUT /CheckAccount/{checkAccountId}': 'reversible',
  'DELETE /CheckAccount/{checkAccountId}': 'irreversible',
  'GET /CheckAccount/{checkAccountId}/getBalanceAtDate': 'read',
  'GET /CheckAccountTransaction': 'read',
  'POST /CheckAccountTransaction': 'reversible',
  'GET /CheckAccountTransaction/{checkAccountTransactionId}': 'read',
  'PUT /CheckAccountTransaction/{checkAccountTransactionId}': 'reversible',
  'DELETE /CheckAccountTransaction/{checkAccountTransactionId}': 'irreversible',
  'PUT /CheckAccountTransaction/{checkAccountTransactionId}/enshrine': 'irreversible',
  'GET /PrivateTransactionRule': 'read',
  'POST /PrivateTransactionRule': 'reversible',
  'DELETE /PrivateTransactionRule/{id}': 'irreversible',
  'GET /Contact/Factory/getNextCustomerNumber': 'read',
  'GET /Contact/Factory/findContactsByCustomFieldValue': 'read',
  'GET /Contact/Mapper/checkCustomerNumberAvailability': 'read',
  'GET /Contact': 'read',
  'POST /Contact': 'reversible',
  'GET /Contact/{contactId}': 'read',
  'PUT /Contact/{contactId}': 'reversible',
  'DELETE /Contact/{contactId}': 'irreversible',
  'GET /Contact/{contactId}/getTabsItemCount': 'read',
  'POST /ContactAddress': 'reversible',
  'GET /ContactAddress': 'read',
  'GET /ContactAddress/{contactAddressId}': 'read',
  'PUT /ContactAddress/{contactAddressId}': 'reversible',
  'DELETE /ContactAddress/{contactAddressId}': 'irreversible',
  'GET /CommunicationWay': 'read',
  'POST /CommunicationWay': 'reversible',
  'GET /CommunicationWay/{communicationWayId}': 'read',
  'DELETE /CommunicationWay/{communicationWayId}': 'irreversible',
  'PUT /CommunicationWay/{communicationWayId}': 'reversible',
  'GET /CommunicationWayKey': 'read',
  'GET /AccountingContact': 'read',
  'POST /AccountingContact': 'reversible',
  'GET /AccountingContact/{accountingContactId}': 'read',
  'PUT /AccountingContact/{accountingContactId}': 'reversible',
  'DELETE /AccountingContact/{accountingContactId}': 'irreversible',
  'GET /Textparser/fetchDictionaryEntriesByType': 'read',
  'GET /ContactCustomField': 'read',
  'POST /ContactCustomField': 'reversible',
  'GET /ContactCustomField/{contactCustomFieldId}': 'read',
  'PUT /ContactCustomField/{contactCustomFieldId}': 'reversible',
  'DELETE /ContactCustomField/{contactCustomFieldId}': 'irreversible',
  'GET /ContactCustomFieldSetting': 'read',
  'POST /ContactCustomFieldSetting': 'reversible',
  'GET /ContactCustomFieldSetting/{contactCustomFieldSettingId}': 'read',
  'PUT /ContactCustomFieldSetting/{contactCustomFieldSettingId}': 'reversible',
  'DELETE /ContactCustomFieldSetting/{contactCustomFieldSettingId}': 'irreversible',
  'GET /ContactCustomFieldSetting/{contactCustomFieldSettingId}/getReferenceCount': 'read',
  'GET /CreditNote': 'read',
  'POST /CreditNote/Factory/saveCreditNote': 'reversible',
  'POST /CreditNote/Factory/createFromInvoice': 'reversible',
  'POST /CreditNote/Factory/createFromVoucher': 'reversible',
  'GET /CreditNote/{creditNoteId}': 'read',
  'PUT /CreditNote/{creditNoteId}': 'reversible',
  'DELETE /CreditNote/{creditNoteId}': 'irreversible',
  'GET /CreditNote/{creditNoteId}/sendByWithRender': 'irreversible',
  'PUT /CreditNote/{creditNoteId}/sendBy': 'irreversible',
  'PUT /CreditNote/{creditNoteId}/enshrine': 'irreversible',
  'GET /CreditNote/{creditNoteId}/getPdf': 'irreversible',
  'POST /CreditNote/{creditNoteId}/sendViaEmail': 'irreversible',
  'PUT /CreditNote/{creditNoteId}/bookAmount': 'irreversible',
  'PUT /CreditNote/{creditNoteId}/resetToOpen': 'irreversible',
  'PUT /CreditNote/{creditNoteId}/resetToDraft': 'irreversible',
  'GET /CreditNotePos': 'read',
  'PUT /SevClient/{SevClientId}/updateExportConfig': 'reversible',
  'GET /Export/datevCSV': 'read',
  'GET /Export/createDatevCsvZipExportJob': 'read',
  'GET /Export/createDatevXmlZipExportJob': 'read',
  'GET /Progress/generateDownloadHash': 'read',
  'GET /Progress/getProgress': 'read',
  'GET /ExportJob/jobDownloadInfo': 'read',
  'GET /Export/invoiceCsv': 'read',
  'GET /Export/invoiceZip': 'read',
  'GET /Export/creditNoteCsv': 'read',
  'GET /Export/voucherListCsv': 'read',
  'GET /Export/transactionsCsv': 'read',
  'GET /Export/voucherZip': 'read',
  'GET /Export/contactListCsv': 'read',
  'GET /Part': 'read',
  'POST /Part': 'reversible',
  'GET /Part/{partId}': 'read',
  'PUT /Part/{partId}': 'reversible',
  'GET /Part/{partId}/getStock': 'read',
  'GET /Invoice': 'read',
  'POST /Invoice/Factory/saveInvoice': 'reversible',
  'GET /Invoice/{invoiceId}': 'read',
  'GET /Invoice/{invoiceId}/getPositions': 'read',
  'POST /Invoice/Factory/createInvoiceFromOrder': 'reversible',
  'POST /Invoice/Factory/createInvoiceReminder': 'reversible',
  'GET /Invoice/{invoiceId}/getIsPartiallyPaid': 'read',
  'POST /Invoice/{invoiceId}/cancelInvoice': 'irreversible',
  'POST /Invoice/{invoiceId}/render': 'reversible',
  'POST /Invoice/{invoiceId}/sendViaEmail': 'irreversible',
  'GET /Invoice/{invoiceId}/getPdf': 'irreversible',
  'GET /Invoice/{invoiceId}/getXml': 'read',
  'PUT /Invoice/{invoiceId}/sendBy': 'irreversible',
  'PUT /Invoice/{invoiceId}/enshrine': 'irreversible',
  'PUT /Invoice/{invoiceId}/bookAmount': 'irreversible',
  'PUT /Invoice/{invoiceId}/resetToOpen': 'irreversible',
  'PUT /Invoice/{invoiceId}/resetToDraft': 'irreversible',
  'GET /InvoicePos': 'read',
  'GET /DocServer/getLetterpapersWithThumb': 'read',
  'GET /DocServer/getTemplatesWithThumb': 'read',
  'PUT /Invoice/{invoiceId}/changeParameter': 'reversible',
  'PUT /Order/{orderId}/changeParameter': 'reversible',
  'PUT /CreditNote/{creditNoteId}/changeParameter': 'reversible',
  'GET /Order': 'read',
  'POST /Order/Factory/saveOrder': 'reversible',
  'GET /Order/{orderId}': 'read',
  'PUT /Order/{orderId}': 'reversible',
  'DELETE /Order/{orderId}': 'irreversible',
  'GET /Order/{orderId}/getPositions': 'read',
  'GET /Order/{orderId}/getDiscounts': 'read',
  'GET /Order/{orderId}/getRelatedObjects': 'read',
  'POST /Order/{orderId}/sendViaEmail': 'irreversible',
  'POST /Order/Factory/createPackingListFromOrder': 'reversible',
  'POST /Order/Factory/createContractNoteFromOrder': 'reversible',
  'GET /Order/{orderId}/getPdf': 'irreversible',
  'PUT /Order/{orderId}/sendBy': 'irreversible',
  'GET /OrderPos': 'read',
  'GET /OrderPos/{orderPosId}': 'read',
  'PUT /OrderPos/{orderPosId}': 'reversible',
  'DELETE /OrderPos/{orderPosId}': 'irreversible',
  'POST /Voucher/Factory/saveVoucher': 'reversible',
  'POST /Voucher/Factory/uploadTempFile': 'reversible',
  'GET /Voucher': 'read',
  'GET /Voucher/{voucherId}': 'read',
  'PUT /Voucher/{voucherId}': 'reversible',
  'PUT /Voucher/{voucherId}/enshrine': 'irreversible',
  'PUT /Voucher/{voucherId}/bookAmount': 'irreversible',
  'PUT /Voucher/{voucherId}/resetToOpen': 'irreversible',
  'PUT /Voucher/{voucherId}/resetToDraft': 'irreversible',
  'GET /VoucherPos': 'read',
  'GET /ReceiptGuidance/forAllAccounts': 'read',
  'GET /ReceiptGuidance/forAccountNumber': 'read',
  'GET /ReceiptGuidance/forTaxRule': 'read',
  'GET /ReceiptGuidance/forRevenue': 'read',
  'GET /ReceiptGuidance/forExpense': 'read',
  'GET /Report/invoicelist': 'read',
  'GET /Report/orderlist': 'read',
  'GET /Report/contactlist': 'read',
  'GET /Report/voucherlist': 'read',
  'GET /Tag': 'read',
  'GET /Tag/{tagId}': 'read',
  'PUT /Tag/{tagId}': 'reversible',
  'DELETE /Tag/{tagId}': 'irreversible',
  'POST /Tag/Factory/create': 'reversible',
  'GET /TagRelation': 'read',
  'GET /SevUser': 'read',
  'GET /StaticCountry': 'read',
  'GET /Category': 'read',
  'GET /Unity': 'read',
  'GET /SevSequence/Factory/getByType': 'read',
  'POST /Order/{orderId}/render': 'reversible',
  'POST /CreditNote/{creditNoteId}/render': 'reversible',
};

/** A table operation, split for matching. */
interface Template {
  method: string;
  segments: string[];
  effect: Effect;
}

const TEMPLATES: Template[] = Object.entries(OPERATIONS).map(([operation, effect]) => {
  const [method = '', path = ''] = operation.split(' ');
  return { method, segments: path.split('/'), effect };
});

// A path parameter matches only a sevDesk id, so a template never stands in for a named segment:
// `/Order/sendAll` is not an instance of `/Order/{orderId}`.
const ID = /^\d+$/;

// The one GET the spec lacks that runs as a read: `companyName()` reads the account's company from
// `GET /SevClient`. Any other GET the spec lacks needs confirmation (issue #72).
const UNDOCUMENTED_READS = new Set(['/SevClient']);

// Query flags that enshrine every exported document (`enshrine` on `/Export/datevCSV`,
// `enshrineDocuments` on `/Export/createDatevCsvZipExportJob`), unless set to false.
const ENSHRINE_FLAG = /^enshrine/i;

// Body keys naming objects a write deletes: `invoicePosDelete`, `orderPosDelete`,
// `creditNotePosDelete`, `voucherPosDelete` and `discountDelete` of the factory saves, case ignored.
const DELETE_KEY = /delete$/i;

// Query keys naming a status (issue #71): `status`, `invoice[status]` and any other key containing
// it, case ignored. No documented query parameter of a write contains it (`invoice[id]`, …).
const STATUS_KEY = /status/i;

/**
 * The document types whose status a write can change (decision 6), with the status of a draft.
 * `sevdesk.savePdf` renders a draft's PDF again before fetching it.
 */
export const DRAFT_STATUS = new Map([
  ['Invoice', '100'],
  ['Order', '100'],
  ['CreditNote', '100'],
  ['Voucher', '50'],
]);

const SENDS = 'sends, enshrines, books, cancels or resets a document.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The effect of the table operation `method path` is an instance of, or undefined when the spec
 * has no such operation. Literal segments match exactly, path parameters only an id.
 */
function effectOf(method: string, path: string): Effect | undefined {
  const segments = path.split('/');
  return TEMPLATES.find(
    (template) =>
      template.method === method &&
      template.segments.length === segments.length &&
      template.segments.every(
        (part, index) =>
          part === segments[index] || (part.startsWith('{') && ID.test(segments[index] ?? '')),
      ),
  )?.effect;
}

/**
 * Why a GET changes data irreversibly, or undefined for a read: a path the table does not know
 * other than `UNDOCUMENTED_READS` (fail closed, decision 6: the spec has GETs that change data, so
 * an unknown one may too), `getPdf` without exactly one `preventSendBy` key, case ignored, set to
 * `true` (decision 7), or an irreversible operation of the table.
 */
function readReason(path: string, params: URLSearchParams): string | undefined {
  const effect = effectOf('GET', path);
  if (effect === undefined && !UNDOCUMENTED_READS.has(path)) {
    return `GET ${path} is not a GET path of the sevDesk API spec, so it counts as irreversible. Find the path with search.`;
  }
  if (path.split('/').some((segment) => segment.toLowerCase() === 'getpdf')) {
    const keys = [...params.keys()].filter((key) => key.toLowerCase() === 'preventsendby');
    if (keys.length === 1 && params.get('preventSendBy') === 'true') return undefined;
    return 'getPdf without preventSendBy=true, or with another key that differs from it only in case, can mark the document as sent. To fetch only the PDF, pass { query: { preventSendBy: true } } or use sevdesk.savePdf.';
  }
  return effect === 'irreversible' ? `GET ${path} ${SENDS}` : undefined;
}

/**
 * Whether a write creates a new draft of `type`: a factory save (`POST /{Type}/Factory/save{Type}`)
 * whose document has no id and the `draft` status.
 */
function isNewDraft(
  method: string,
  path: string,
  type: string,
  document: unknown,
  draft: string,
): boolean {
  if (method !== 'POST' || path !== `/${type}/Factory/save${type}` || !isRecord(document)) {
    return false;
  }
  const { id, status } = document;
  const isNumberOrString = typeof status === 'number' || typeof status === 'string';
  return (id === undefined || id === null) && isNumberOrString && String(status) === draft;
}

/**
 * Why a write changes a document's status (decision 6), or undefined, on an Invoice, Order,
 * CreditNote or Voucher path: a query key naming a status (`STATUS_KEY`, issue #71), whatever the
 * body holds, or a `status` at the top level of the body or in its document object (`order` of
 * saveOrder, `invoice` of saveInvoice, …). Only a new draft may carry a status, in its body
 * (`isNewDraft`).
 */
function statusChange(
  method: string,
  path: string,
  params: URLSearchParams,
  body: unknown,
): string | undefined {
  const [, type = ''] = path.split('/');
  const draft = DRAFT_STATUS.get(type);
  if (draft === undefined) return undefined;
  const key = [...params.keys()].find((name) => STATUS_KEY.test(name));
  if (key !== undefined) {
    return `query.${key} of ${method} ${path} names a status, which can change the document's status. Leave it out of the query; a new draft carries its status in the body.`;
  }
  if (!isRecord(body)) return undefined;
  const document = body[type.charAt(0).toLowerCase() + type.slice(1)];
  if (body.status === undefined) {
    const status = isRecord(document) ? document.status : undefined;
    if (status === undefined || isNewDraft(method, path, type, document, draft)) return undefined;
  }
  return `${method} ${path} sets a status in its body, which changes the document's status. Only a new draft (without id) may carry status ${draft}; leave status out to change other fields.`;
}

/** Whether a body value names nothing: absent, null, or an empty string, array or object. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * Why a write's body deletes data (issue #70), or undefined: a key at its top level ending in
 * `Delete` (`DELETE_KEY`) whose value is not empty, such as `orderPosDelete` of saveOrder, which
 * deletes positions as `DELETE /OrderPos/{orderPosId}` does. Any other value counts as naming
 * something (fail closed).
 */
function deletion(method: string, path: string, body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const key = Object.keys(body).find((name) => DELETE_KEY.test(name) && !isEmpty(body[name]));
  return key === undefined
    ? undefined
    : `${method} ${path} deletes data: ${key} in its body is not empty.`;
}

/**
 * Why a write changes data irreversibly, or undefined for a reversible one: every DELETE, a write
 * path the table does not know (fail closed, decision 6), an irreversible operation of the table,
 * a body that names something to delete, or a status change in the query or body.
 */
function writeReason(
  method: string,
  path: string,
  params: URLSearchParams,
  body: unknown,
): string | undefined {
  if (method === 'DELETE') return `DELETE ${path} deletes data.`;
  const effect = effectOf(method, path);
  if (effect === undefined) {
    return `${method} ${path} is not a write path of the sevDesk API spec, so it counts as irreversible. Find the path with search.`;
  }
  if (effect === 'irreversible') return `${method} ${path} ${SENDS}`;
  return deletion(method, path, body) ?? statusChange(method, path, params, body);
}

/**
 * Why a call needs confirmation because it changes sevDesk data irreversibly (PRD §6), or
 * undefined when it runs directly: a read, or a reversible write. Besides the rules of
 * `readReason` and `writeReason`, an enshrine query flag that is not false makes any call
 * irreversible. `method` is upper case and `path` a validated path relative to the API base.
 */
export function confirmationReason(
  method: string,
  path: string,
  params: URLSearchParams,
  body: unknown,
): string | undefined {
  const reason =
    method === 'GET' ? readReason(path, params) : writeReason(method, path, params, body);
  if (reason !== undefined) return reason;
  const flag = [...params].find(([key, value]) => ENSHRINE_FLAG.test(key) && value !== 'false');
  return flag ? `query.${flag[0]}=${flag[1]} enshrines the exported documents.` : undefined;
}
