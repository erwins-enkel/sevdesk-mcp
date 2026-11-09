import { setTimeout as sleep } from 'node:timers/promises';
import { confirmationReason } from './classify.ts';
import { binaryFileName, fileStem, saveFile } from './downloads.ts';
import { HostError, type HostFunction, type SnippetError } from './sandbox.ts';

/** sevDesk's API base (PRD §5.6). It must be HTTPS so the token never travels in clear text. */
export const DEFAULT_BASE_URL = 'https://my.sevdesk.de/api/v1';

/** The most sevDesk calls one `execute` run may send (PRD §5.3). */
export const DEFAULT_CALL_BUDGET = 50;

/**
 * Objects per `sevdesk.paginate` page (`limit`): sevDesk's maximum (1 to 1000), so a list costs
 * the fewest calls of the budget.
 */
export const PAGE_SIZE = 1000;

/**
 * The document types `sevdesk.savePdf` saves (those with a `getPdf` endpoint), each with the field
 * that holds its document number, the name of the saved file (decision 14).
 */
export const PDF_TYPES = {
  Order: 'orderNumber',
  Invoice: 'invoiceNumber',
  CreditNote: 'creditNoteNumber',
} as const;
type PdfType = keyof typeof PDF_TYPES;

// A document id as `savePdf` takes it: a positive integer.
const DOCUMENT_ID = /^[1-9]\d*$/;

// A path relative to the base: segments of letters, digits, `-` and `_`. sevDesk's paths use only
// letters and numeric ids, so this rejects absolute and protocol-relative URLs, other hosts, dot
// segments, backslashes, percent-encoding, `?`, `#` and whitespace before anything is sent.
const RELATIVE_PATH = /^(?:\/[A-Za-z0-9_-]+)+$/;

// The methods `sevdesk.request` takes. sevDesk's spec has no PATCH, so a PATCH is always an
// unknown write path and needs confirmation (src/classify.ts).
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

const TOKEN_HINT =
  'sevDesk rejected the API token (wrong, expired or revoked). Replace it in the OS keychain entry of this profile, or set a valid SEVDESK_API_TOKEN for this MCP server and restart it.';

/** A validated call, ready to send; a held one is kept as it is until its confirmation. */
export interface Call {
  method: string;
  path: string;
  url: URL;
  /** The JSON text of the body, if the call has one. */
  body?: string;
}

/**
 * A write call sent to sevDesk, as the ledger of an `execute` result lists it (decision 11):
 * sevDesk's final HTTP status and the id of the object a 2xx JSON answer names. Without `status`
 * no answer came (a network error, or the run ended first), so the write may have been applied.
 */
export interface Write {
  method: string;
  path: string;
  status?: number;
  objectId?: string;
}

/** A non-JSON answer saved in the download directory (decision 15), never its content. */
interface SavedFile {
  path: string;
  contentType: string;
  bytes: number;
}

/**
 * What became of a confirmed call (decision 5): `sent` with sevDesk's 2xx status and the object id
 * of a JSON answer (a non-JSON one is saved as `file`), `failed` with the status of the answer if
 * one came, or `not_sent` because an earlier call failed. A 2xx means sevDesk applied the call, so
 * it is `sent` even when its answer cannot be read or saved; `answerError` then says why.
 */
export interface Confirmed {
  method: string;
  path: string;
  outcome: 'sent' | 'failed' | 'not_sent';
  status?: number;
  objectId?: string;
  file?: SavedFile;
  answerError?: SnippetError;
}

/** When a failed call is sent again (decision 10). */
interface RetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  /** The first wait without `Retry-After`; each further one doubles. */
  baseDelayMs: number;
  /** The longest wait; a `Retry-After` beyond it is not waited for, and the call fails. */
  maxDelayMs: number;
}

/** Up to three retries, after 0.5, 1 and 2 s unless sevDesk sends `Retry-After`. */
const DEFAULT_RETRY: RetryPolicy = { retries: 3, baseDelayMs: 500, maxDelayMs: 10_000 };

interface SendOptions {
  token: string;
  signal: AbortSignal;
  /** The retry policy, or false to send the call exactly once (a confirmed call). */
  retry: RetryPolicy | false;
}

interface ClientOptions {
  baseUrl: string;
  token: string;
  /** Calls sent beyond this many end the run. */
  maxCalls: number;
  /** The profile's download directory: PDFs and non-JSON responses are saved there. */
  downloadDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string, method?: string, path?: string): HostError {
  return new HostError({ kind: 'invalid_request', message, method, path });
}

function needsConfirmation(reason: string, method: string, path: string): HostError {
  return new HostError({
    kind: 'needs_confirmation',
    message: `${reason} Only sevdesk.request holds such a call for confirmation. Nothing was sent.`,
    method,
    path,
  });
}

function isQueryValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** A call's query parameters: strings, numbers and booleans; null and undefined are skipped. */
function toSearchParams(query: unknown, method: string, path: string): URLSearchParams {
  const params = new URLSearchParams();
  if (query === undefined || query === null) return params;
  if (!isRecord(query)) {
    throw invalidRequest('query must be an object of parameter values.', method, path);
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (!isQueryValue(value)) {
      throw invalidRequest(`query.${key} must be a string, number or boolean.`, method, path);
    }
    params.append(key, String(value));
  }
  return params;
}

/**
 * The query parameters and body from the call's options, which may hold only `query` and `body`.
 * A body is a JSON object, and a GET takes none.
 */
function readOptions(
  options: unknown,
  method: string,
  path: string,
): { params: URLSearchParams; body: Record<string, unknown> | undefined } {
  if (options === undefined) return { params: new URLSearchParams(), body: undefined };
  if (!isRecord(options)) {
    throw invalidRequest('The options must be an object like { query: { … } }.', method, path);
  }
  const unknown = Object.keys(options).filter((key) => key !== 'query' && key !== 'body');
  if (unknown.length > 0) {
    throw invalidRequest(
      `Unknown option ${unknown.join(', ')}; use { query, body }.`,
      method,
      path,
    );
  }
  const { body } = options;
  if (body !== undefined && method === 'GET') {
    throw invalidRequest('A GET call takes no body.', method, path);
  }
  if (body !== undefined && !isRecord(body)) {
    throw invalidRequest('body must be an object, the JSON body of the call.', method, path);
  }
  return { params: toSearchParams(options.query, method, path), body };
}

/**
 * Validates the code's arguments `(method, path, options)` and builds the URL and body, with
 * `reason` saying why the call changes sevDesk data irreversibly (`confirmationReason`), if it does.
 */
function build(
  baseUrl: string,
  [method, path, options]: unknown[],
): { call: Call; reason: string | undefined } {
  if (typeof method !== 'string') throw invalidRequest('method must be a string such as "GET".');
  const verb = method.toUpperCase();
  if (typeof path !== 'string' || !RELATIVE_PATH.test(path)) {
    throw invalidRequest(
      'path must be relative to the API base, like "/Contact" or "/Invoice/123": letters, digits, "-" and "_" between slashes. Put query parameters in { query }.',
      verb,
      typeof path === 'string' ? path : undefined,
    );
  }
  if (!METHODS.has(verb)) {
    throw invalidRequest(`Unknown method ${verb}; use GET, POST, PUT or DELETE.`, verb, path);
  }
  const { params, body } = readOptions(options, verb, path);
  const reason = confirmationReason(verb, path, params, body);
  const url = new URL(baseUrl + path);
  url.search = params.toString();
  const call: Call = { method: verb, path, url };
  if (body !== undefined) call.body = JSON.stringify(body);
  return { call, reason };
}

/**
 * `build` for a call that runs directly: one that changes sevDesk data irreversibly fails closed
 * before a request exists, since only `sevdesk.request` holds such a call for confirmation.
 */
function prepare(baseUrl: string, args: unknown[]): Call {
  const { call, reason } = build(baseUrl, args);
  if (reason !== undefined) throw needsConfirmation(reason, call.method, call.path);
  return call;
}

/**
 * The code of the error behind a failed fetch (e.g. ECONNREFUSED), never its text: that can echo
 * header values, the token among them.
 */
function causeCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) ? cause.code : undefined;
  return typeof code === 'string' ? ` (${code})` : '';
}

/** sevDesk's error message from an error response body (`{ error: { message } }`), if any. */
async function sevdeskMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await response.text());
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
      return body.error.message;
    }
  } catch {
    // Not JSON: there is no sevDesk message to pass on.
  }
  return undefined;
}

/** The structured error of a non-2xx response; a 401 gets the token hint. */
async function apiError({ method, path }: Call, response: Response): Promise<HostError> {
  const error: SnippetError = {
    kind: 'api_error',
    message: `${method} ${path} returned HTTP ${String(response.status)}.`,
    status: response.status,
    method,
    path,
  };
  const message = await sevdeskMessage(response);
  if (message !== undefined) error.sevdeskMessage = message;
  if (response.status === 401) error.hint = TOKEN_HINT;
  return new HostError(error);
}

/**
 * Whether a response may be retried (decision 10): 429 for any method, 5xx only for GET. A write
 * that failed with 5xx may still have been applied, so sending it again could duplicate it.
 */
function retryable(method: string, status: number): boolean {
  return status === 429 || (method === 'GET' && status >= 500 && status <= 599);
}

/** A `Retry-After` value (delay-seconds or an HTTP date) in milliseconds; undefined if unreadable. */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * How long to wait before sending a call again after `response`, or undefined when it is not
 * retried: retry is off or used up, the status is not retryable for the method, or `Retry-After`
 * asks for a longer wait than the policy allows. Without `Retry-After` the wait doubles each time.
 */
function retryDelay(
  call: Call,
  response: Response,
  retries: number,
  retry: RetryPolicy | false,
): number | undefined {
  if (retry === false || retries >= retry.retries || !retryable(call.method, response.status)) {
    return undefined;
  }
  const after = retryAfterMs(response.headers.get('retry-after'));
  if (after === undefined) return Math.min(retry.baseDelayMs * 2 ** retries, retry.maxDelayMs);
  return after <= retry.maxDelayMs ? after : undefined;
}

/** Sends a call once with the token and its JSON body; a failed fetch becomes a `network_error`. */
async function fetchOnce({ method, path, url, body }: Call, token: string, signal: AbortSignal) {
  const headers: Record<string, string> = { Authorization: token, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(url.href, {
      method,
      headers,
      body,
      // A redirect from the API is unexpected; following it could carry the token elsewhere.
      redirect: 'error',
      signal,
    });
  } catch (error) {
    throw new HostError({
      kind: 'network_error',
      message: `${method} ${path} could not reach sevDesk${causeCode(error)}.`,
      method,
      path,
    });
  }
}

/**
 * Sends a validated call with the token and resolves to its 2xx response, whose body the caller
 * reads; any other status fails with the structured API error. A 429, or a 5xx on a GET, is sent
 * again after a wait, as `retry` allows (decision 10); `retry: false` sends the call exactly once,
 * as a confirmed call must be. If `signal` aborts while waiting to retry, the call fails with the
 * last response's error.
 */
export async function send(call: Call, { token, signal, retry }: SendOptions): Promise<Response> {
  for (let retries = 0; ; retries += 1) {
    const response = await fetchOnce(call, token, signal);
    const delay = retryDelay(call, response, retries, retry);
    if (delay === undefined) {
      if (!response.ok) throw await apiError(call, response);
      return response;
    }
    const error = await apiError(call, response);
    try {
      await sleep(delay, undefined, { signal });
    } catch {
      throw error;
    }
  }
}

/** The response's content type, or an empty string without one. */
function contentTypeOf(response: Response): string {
  return response.headers.get('content-type') ?? '';
}

/** The parsed JSON of a 2xx response; a non-JSON body or invalid JSON fails. */
async function readJson(call: Call, response: Response): Promise<unknown> {
  const { method, path } = call;
  const contentType = contentTypeOf(response);
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    await response.body?.cancel();
    throw new HostError({
      kind: 'api_error',
      message: `${method} ${path} returned ${contentType || 'no content type'}, not JSON.`,
      status: response.status,
      method,
      path,
      hint: 'sevdesk.request saves a non-JSON response as a file.',
    });
  }
  try {
    return await response.json();
  } catch {
    throw new HostError({
      kind: 'api_error',
      message: `${method} ${path} returned invalid JSON.`,
      status: response.status,
      method,
      path,
    });
  }
}

/** Saves a non-JSON response as a new file in `downloadDir` (decision 15) and says where. */
async function saveBody(
  call: Call,
  response: Response,
  downloadDir: string,
  signal: AbortSignal,
): Promise<SavedFile> {
  // Without a content type a recipient may assume application/octet-stream (RFC 9110, 8.3).
  const contentType = contentTypeOf(response) || 'application/octet-stream';
  const name = binaryFileName(call.path, contentType);
  const body = response.body ?? new Uint8Array();
  const { path, bytes } = await saveFile(downloadDir, name, body, { replace: false, signal });
  return { path, contentType, bytes };
}

/**
 * What `sevdesk.request` resolves to: the parsed JSON of a JSON response. Any other response is
 * saved as a new file in `downloadDir`, and only `{ path, contentType, bytes }` comes back, never
 * its content.
 */
async function readBody(
  call: Call,
  response: Response,
  downloadDir: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (JSON_CONTENT_TYPE.test(contentTypeOf(response))) return readJson(call, response);
  return saveBody(call, response, downloadDir, signal);
}

/**
 * The id of the object a write's answer names: `objects.id` (the first object of an array), or the
 * id of the first object inside it, as a factory save answers `{ objects: { order, orderPos } }`.
 * Like `pdfBytes`, it also reads an answer that is not wrapped in `objects`.
 */
function objectIdOf(response: unknown): string | undefined {
  const objects =
    isRecord(response) && response.objects !== undefined ? response.objects : response;
  const object: unknown = Array.isArray(objects) ? objects[0] : objects;
  if (!isRecord(object)) return undefined;
  for (const candidate of [object, ...Object.values(object)]) {
    const id = isRecord(candidate) ? candidate.id : undefined;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return undefined;
}

/** The `(type, id)` of `sevdesk.savePdf`: a type of `PDF_TYPES` and a positive integer id. */
function pdfArguments([type, id, ...rest]: unknown[]): { type: PdfType; id: string } {
  if (typeof type !== 'string' || !Object.hasOwn(PDF_TYPES, type)) {
    throw invalidRequest(`type must be one of ${Object.keys(PDF_TYPES).join(', ')}.`);
  }
  const text = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (typeof text !== 'string' || !DOCUMENT_ID.test(text)) {
    throw invalidRequest('id must be the positive integer id of the document, e.g. 123.');
  }
  if (rest.length > 0) throw invalidRequest('sevdesk.savePdf takes only (type, id).');
  return { type: type as PdfType, id: text };
}

/** The document number in the response of `GET /{Type}/{id}`, if it has one. */
function documentNumber(response: unknown, field: string): string | undefined {
  const objects = isRecord(response) ? response.objects : undefined;
  const document: unknown = Array.isArray(objects) ? objects[0] : undefined;
  const number = isRecord(document) ? document[field] : undefined;
  return typeof number === 'string' ? number : undefined;
}

/**
 * The PDF of a getPdf response: its base64 `content` (with `base64encoded: true`), under `objects`
 * as sevDesk wraps its responses, or at the top level as the official spec documents it. Anything
 * else fails.
 */
function pdfBytes({ method, path }: Call, response: unknown): Buffer {
  const file = isRecord(response) && isRecord(response.objects) ? response.objects : response;
  if (isRecord(file) && file.base64encoded === true && typeof file.content === 'string') {
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length > 0) return bytes;
  }
  throw new HostError({
    kind: 'api_error',
    message: `${method} ${path} returned no base64-encoded PDF content.`,
    method,
    path,
  });
}

/**
 * The call behind `sevdesk.paginate(path, query)`: a GET validated like any other, without
 * `limit` and `offset`, which each page sets.
 */
function preparePages(baseUrl: string, [path, query]: unknown[]): Call {
  const call = prepare(baseUrl, ['GET', path, { query }]);
  const paging = ['limit', 'offset'].filter((key) => call.url.searchParams.has(key));
  if (paging.length > 0) {
    throw invalidRequest(
      `sevdesk.paginate sets limit and offset itself; leave out ${paging.join(' and ')}. Use sevdesk.request for a single page.`,
      call.method,
      call.path,
    );
  }
  return call;
}

/** The call of the page of `PAGE_SIZE` objects starting at `offset`. */
function pageCall(call: Call, offset: number): Call {
  const url = new URL(call.url);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(offset));
  return { ...call, url };
}

/** The `objects` array of a list response; any other response is not a list. */
function listObjects(call: Call, response: unknown): unknown[] {
  const objects = isRecord(response) ? response.objects : undefined;
  if (Array.isArray(objects)) return objects as unknown[];
  throw invalidRequest(
    `GET ${call.path} did not return a list (an objects array); use sevdesk.request for it.`,
    call.method,
    call.path,
  );
}

/** Fails unless `baseUrl` uses HTTPS, so the token never travels in clear text. */
function requireHttps(baseUrl: string): void {
  if (new URL(baseUrl).protocol !== 'https:') {
    throw new HostError({
      kind: 'invalid_base_url',
      message: `The sevDesk base URL must use HTTPS: ${baseUrl}`,
    });
  }
}

/** The error that ends a run over its call budget; `stopped` says what was left undone. */
function budgetError(maxCalls: number, stopped: string, hint: string): HostError {
  return new HostError(
    {
      kind: 'call_budget',
      message: `The run reached the limit of ${String(maxCalls)} sevDesk calls and was stopped; ${stopped}`,
      hint,
    },
    true,
  );
}

/**
 * Creates `sevdesk.request`, `sevdesk.paginate` and `sevdesk.savePdf` for one run. `request`
 * validates a call and returns the parsed JSON, or saves a non-JSON response in `downloadDir` and
 * returns where; `paginate` collects every object of a list, page by page, into one array;
 * `savePdf` saves a document's PDF in `downloadDir`. Between them they send at most `maxCalls`
 * calls (each page is one, `savePdf` costs two, a retry none) to `baseUrl` with the token added here
 * (never visible to the code), retried as decision 10 allows. A reversible write runs and enters
 * `writes`, the run's ledger. An irreversible call through `request` is held (decision 5): it is not
 * sent, enters `held` and resolves to `{ held: true }`; `paginate` and `savePdf` refuse one. A held
 * call takes a call of the budget, as does each `readDocument`, the host's read for the
 * confirmation preview. The call over `maxCalls` is not sent (or held) and ends the run, so
 * `paginate` never returns a partial list.
 */
export function createClient({ baseUrl, token, maxCalls, downloadDir }: ClientOptions): {
  request: HostFunction;
  paginate: HostFunction;
  savePdf: HostFunction;
  writes: Write[];
  held: Call[];
  readDocument: (path: string, signal: AbortSignal) => Promise<unknown>;
} {
  requireHttps(baseUrl);
  let sent = 0;
  const withinBudget = () => (sent += 1) <= maxCalls;
  const writes: Write[] = [];
  const held: Call[] = [];

  /** Sends `call` within the budget; the call over it is not sent and ends the run with `hint`. */
  const sendCounted = (call: Call, signal: AbortSignal, hint: string): Promise<Response> => {
    if (!withinBudget()) {
      throw budgetError(maxCalls, `${call.method} ${call.path} was not sent.`, hint);
    }
    return send(call, { token, signal, retry: DEFAULT_RETRY });
  };

  /**
   * Sends a write like `sendCounted` and enters it in `writes` once it is sent: then the status of
   * sevDesk's answer, an error status included, and the id of the object a JSON answer names.
   */
  const sendWrite = (call: Call, signal: AbortSignal, hint: string): Promise<unknown> => {
    const sending = sendCounted(call, signal, hint);
    const write: Write = { method: call.method, path: call.path };
    writes.push(write);
    return sending.then(
      async (response) => {
        write.status = response.status;
        const value = await readBody(call, response, downloadDir, signal);
        const objectId = objectIdOf(value);
        if (objectId !== undefined) write.objectId = objectId;
        return value;
      },
      (error: unknown) => {
        if (error instanceof HostError && error.error.status !== undefined) {
          write.status = error.error.status;
        }
        throw error;
      },
    );
  };

  /** Keeps an irreversible call for its confirmation instead of sending it, within the budget. */
  const hold = (call: Call): Promise<unknown> => {
    if (!withinBudget()) {
      throw budgetError(
        maxCalls,
        `${call.method} ${call.path} was not held.`,
        'Hold fewer calls per run: each is sent on confirmation.',
      );
    }
    held.push(call);
    return Promise.resolve({ held: true });
  };

  const request: HostFunction = (args, signal) => {
    const { call, reason } = build(baseUrl, args);
    if (reason !== undefined) return hold(call);
    if (call.method !== 'GET') {
      return sendWrite(call, signal, 'Spread the writes over several runs.');
    }
    const hint = 'Fetch fewer, larger pages, or filter with query parameters.';
    return sendCounted(call, signal, hint).then((response) =>
      readBody(call, response, downloadDir, signal),
    );
  };

  const paginate: HostFunction = async (args, signal) => {
    const call = preparePages(baseUrl, args);
    const objects: unknown[] = [];
    for (;;) {
      if (!withinBudget()) {
        throw budgetError(
          maxCalls,
          `sevdesk.paginate('${call.path}') had fetched ${String(objects.length)} objects and its list is incomplete, so none of it is returned.`,
          'Narrow the list with query parameters, or fetch it in parts across runs with sevdesk.request and limit/offset.',
        );
      }
      const page = pageCall(call, objects.length);
      const response = await send(page, { token, signal, retry: DEFAULT_RETRY });
      const items = listObjects(call, await readJson(page, response));
      // Only an empty page ends the list: should sevDesk cap a page below PAGE_SIZE, a short
      // page is not the last one.
      if (items.length === 0) return objects;
      objects.push(...items);
    }
  };

  // The document's number names the file, so it is fetched first; an unknown id fails there. The
  // PDF is fetched with preventSendBy=true, so sevDesk never marks the document as sent (decision 7).
  const savePdf: HostFunction = (args, signal) => {
    const { type, id } = pdfArguments(args);
    const document = prepare(baseUrl, ['GET', `/${type}/${id}`]);
    const pdf = prepare(baseUrl, [
      'GET',
      `/${type}/${id}/getPdf`,
      { query: { preventSendBy: true } },
    ]);
    const hint = 'Save fewer PDFs per run: each costs 2 calls.';
    const fetched = sendCounted(document, signal, hint).then((response) =>
      readJson(document, response),
    );
    return fetched.then(async (fields) => {
      const number = documentNumber(fields, PDF_TYPES[type]);
      const stem = number === undefined ? undefined : fileStem(number);
      const fileName = `${stem ?? `${type}-${id}`}.pdf`;
      const bytes = pdfBytes(pdf, await readJson(pdf, await sendCounted(pdf, signal, hint)));
      const { path } = await saveFile(downloadDir, fileName, bytes, { replace: true, signal });
      return { path, fileName };
    });
  };

  /** The JSON of `GET path`, a document a held call acts on, read for the confirmation preview. */
  const readDocument = async (path: string, signal: AbortSignal): Promise<unknown> => {
    const call = prepare(baseUrl, ['GET', path]);
    const hint =
      'Hold calls on fewer documents per run: the preview reads each document a held call acts on, one call each.';
    return readJson(call, await sendCounted(call, signal, hint));
  };

  return { request, paginate, savePdf, writes, held, readDocument };
}

interface ReplayOptions {
  token: string;
  /** The profile's download directory, where a non-JSON answer is saved. */
  downloadDir: string;
  signal: AbortSignal;
}

/** Reads a confirmed call's 2xx answer into `entry`: the object id of JSON, else the saved file. */
async function readAnswer(
  call: Call,
  response: Response,
  entry: Confirmed,
  { downloadDir, signal }: ReplayOptions,
): Promise<void> {
  if (!JSON_CONTENT_TYPE.test(contentTypeOf(response))) {
    entry.file = await saveBody(call, response, downloadDir, signal);
    return;
  }
  const objectId = objectIdOf(await readJson(call, response));
  if (objectId !== undefined) entry.objectId = objectId;
}

/**
 * Sends a confirmed call exactly once (decision 10); a call that fails rejects with its error. Once
 * sevDesk answers 2xx the call is applied, so `entry` is `sent` with that status, and an answer
 * that cannot be read (not JSON as declared, invalid JSON) or saved only sets `answerError`.
 */
async function sendConfirmed(call: Call, entry: Confirmed, options: ReplayOptions): Promise<void> {
  const response = await send(call, { token: options.token, signal: options.signal, retry: false });
  entry.outcome = 'sent';
  entry.status = response.status;
  try {
    await readAnswer(call, response, entry, options);
  } catch (error) {
    if (!(error instanceof HostError)) throw error;
    entry.answerError = error.error;
  }
}

/**
 * Sends the held calls of a confirmation exactly as they were stored, in order, each once and never
 * retried (decisions 5 and 10), and reports each. The first call that fails (no 2xx answer) stops
 * it: that call is `failed`, every later one `not_sent`, and `error` says why. A 2xx whose answer
 * cannot be read is no failure: the call was applied, so the next one is sent.
 */
export async function replay(
  calls: Call[],
  options: ReplayOptions,
): Promise<{ confirmed: Confirmed[]; error?: SnippetError }> {
  const confirmed: Confirmed[] = [];
  let error: SnippetError | undefined;
  for (const call of calls) {
    const entry: Confirmed = { method: call.method, path: call.path, outcome: 'not_sent' };
    confirmed.push(entry);
    if (error !== undefined) continue;
    try {
      await sendConfirmed(call, entry, options);
    } catch (thrown) {
      if (!(thrown instanceof HostError)) throw thrown;
      entry.outcome = 'failed';
      entry.status ??= thrown.error.status;
      error = thrown.error;
    }
  }
  return error === undefined ? { confirmed } : { confirmed, error };
}

/**
 * The account's bookkeeping system check: undefined for system 2.0, an `unsupported_account`
 * error for anything else (PRD §5.4). It reads JSON only, so a non-JSON answer fails rather than
 * being saved as a file. A failed request rejects with its `HostError`.
 */
export async function bookkeepingSystemError(
  { baseUrl, token }: { baseUrl: string; token: string },
  profile: string,
  signal: AbortSignal,
): Promise<SnippetError | undefined> {
  requireHttps(baseUrl);
  const call = prepare(baseUrl, ['GET', '/Tools/bookkeepingSystemVersion']);
  const response = await readJson(call, await send(call, { token, signal, retry: DEFAULT_RETRY }));
  const version =
    isRecord(response) && isRecord(response.objects) ? response.objects.version : undefined;
  if (version === '2.0') return undefined;
  const reported =
    typeof version === 'string' ? `bookkeeping system ${version}` : 'an unknown bookkeeping system';
  return {
    kind: 'unsupported_account',
    message: `The sevDesk account of profile ${profile} uses ${reported}; sevdesk-mcp supports only system 2.0.`,
  };
}
