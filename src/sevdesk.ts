import { setTimeout as sleep } from 'node:timers/promises';
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

// A path relative to the base: segments of letters, digits, `-` and `_`. sevDesk's paths use only
// letters and numeric ids, so this rejects absolute and protocol-relative URLs, other hosts, dot
// segments, backslashes, percent-encoding, `?`, `#` and whitespace before anything is sent.
const RELATIVE_PATH = /^(?:\/[A-Za-z0-9_-]+)+$/;

// Methods that write. They need the confirmation gate, which does not exist yet.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Path segments of the irreversible operations in PRD §6: send (`sendBy`, `sendViaEmail`),
// enshrine, `bookAmount`, cancel and reset. sevDesk serves some as GET
// (`/CreditNote/{id}/sendByWithRender` marks the credit note as sent), so a GET is checked too.
const IRREVERSIBLE_SEGMENT = /^(?:send|enshrine|bookamount|cancel|reset)/i;

// Query flags that enshrine every exported document (`enshrine` on `/Export/datevCSV`,
// `enshrineDocuments` on `/Export/createDatevCsvZipExportJob`), unless set to false.
const ENSHRINE_FLAG = /^enshrine/i;

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

const TOKEN_HINT =
  'sevDesk rejected the API token (wrong, expired or revoked). Set a valid SEVDESK_API_TOKEN for this MCP server and restart it.';

/** A validated call, ready to send. */
interface Call {
  method: string;
  path: string;
  url: URL;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string, method?: string, path?: string): HostError {
  return new HostError({ kind: 'invalid_request', message, method, path });
}

function notEnabled(message: string, method: string, path: string): HostError {
  return new HostError({ kind: 'not_enabled', message, method, path });
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

/** The query parameters from the call's options, which may hold only `query` and `body`. */
function readOptions(options: unknown, method: string, path: string): URLSearchParams {
  if (options === undefined) return new URLSearchParams();
  if (!isRecord(options)) {
    throw invalidRequest('The options must be an object like { query: { … } }.', method, path);
  }
  const unknown = Object.keys(options).filter((key) => key !== 'query' && key !== 'body');
  if (unknown.length > 0) {
    throw invalidRequest(`Unknown option ${unknown.join(', ')}; use { query }.`, method, path);
  }
  if (options.body !== undefined) throw invalidRequest('A GET call takes no body.', method, path);
  return toSearchParams(options.query, method, path);
}

/**
 * Why a GET would change sevDesk data irreversibly, or undefined: a segment naming an
 * irreversible operation, `getPdf` without `preventSendBy=true` (it can mark the document as
 * sent, decision 7) or an enshrine flag. Such calls need the confirmation gate, which does not
 * exist yet. The full classification of every spec path arrives with the writes slice.
 */
function irreversibleRead(path: string, params: URLSearchParams): string | undefined {
  const segments = path.split('/');
  if (segments.some((segment) => IRREVERSIBLE_SEGMENT.test(segment))) {
    return `GET ${path} sends, enshrines, books, cancels or resets a document, which needs confirmation and is not enabled yet. Nothing was sent.`;
  }
  const getsPdf = segments.some((segment) => segment.toLowerCase() === 'getpdf');
  if (getsPdf && params.get('preventSendBy') !== 'true') {
    return 'getPdf without preventSendBy=true can mark the document as sent, which is not enabled yet. Pass { query: { preventSendBy: true } }. Nothing was sent.';
  }
  const flag = [...params].find(([key, value]) => ENSHRINE_FLAG.test(key) && value !== 'false');
  if (flag) {
    return `query.${flag[0]}=${flag[1]} enshrines the exported documents, which needs confirmation and is not enabled yet. Nothing was sent.`;
  }
  return undefined;
}

/**
 * Validates the code's arguments `(method, path, options)` and builds the URL. Writes and
 * irreversible reads (see `irreversibleRead`) fail closed before a request exists.
 */
function prepare(baseUrl: string, [method, path, options]: unknown[]): Call {
  if (typeof method !== 'string') throw invalidRequest('method must be a string such as "GET".');
  const verb = method.toUpperCase();
  if (typeof path !== 'string' || !RELATIVE_PATH.test(path)) {
    throw invalidRequest(
      'path must be relative to the API base, like "/Contact" or "/Invoice/123": letters, digits, "-" and "_" between slashes. Put query parameters in { query }.',
      verb,
      typeof path === 'string' ? path : undefined,
    );
  }
  if (WRITE_METHODS.has(verb)) {
    throw notEnabled(
      `${verb} calls are not enabled yet: execute only reads (GET) so far. Nothing was sent.`,
      verb,
      path,
    );
  }
  if (verb !== 'GET') throw invalidRequest(`Unknown method ${verb}; use GET.`, verb, path);
  const params = readOptions(options, verb, path);
  const irreversible = irreversibleRead(path, params);
  if (irreversible !== undefined) throw notEnabled(irreversible, verb, path);
  const url = new URL(baseUrl + path);
  url.search = params.toString();
  return { method: verb, path, url };
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

/** Sends a call once with the token; a failed fetch becomes a `network_error`. */
async function fetchOnce({ method, path, url }: Call, token: string, signal: AbortSignal) {
  try {
    return await fetch(url.href, {
      method,
      headers: { Authorization: token, Accept: 'application/json' },
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
 * Sends a validated call with the token and returns the parsed JSON response. A 429, or a 5xx on a
 * GET, is sent again after a wait, as `retry` allows (decision 10); `retry: false` sends the call
 * exactly once, as a confirmed call must be. If `signal` aborts while waiting to retry, the call
 * fails with the last response's error.
 */
export async function send(call: Call, { token, signal, retry }: SendOptions): Promise<unknown> {
  for (let retries = 0; ; retries += 1) {
    const response = await fetchOnce(call, token, signal);
    const delay = retryDelay(call, response, retries, retry);
    if (delay === undefined) return readJson(call, response);
    const error = await apiError(call, response);
    try {
      await sleep(delay, undefined, { signal });
    } catch {
      throw error;
    }
  }
}

/** The parsed JSON of a response; a non-2xx status, a non-JSON body or invalid JSON fails. */
async function readJson(call: Call, response: Response): Promise<unknown> {
  const { method, path } = call;
  if (!response.ok) throw await apiError(call, response);
  const contentType = response.headers.get('content-type') ?? '';
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    await response.body?.cancel();
    throw notEnabled(
      `${method} ${path} returned ${contentType || 'no content type'}, not JSON; non-JSON responses are not enabled yet.`,
      method,
      path,
    );
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
 * Creates `sevdesk.request` and `sevdesk.paginate` for one run. `request` validates a call and
 * returns the parsed JSON; `paginate` collects every object of a list, page by page, into one
 * array. Between them they send at most `maxCalls` calls (each page is one, a retry is not) to
 * `baseUrl` with the token added here (never visible to the code), retried as decision 10 allows.
 * Writes, irreversible reads and non-JSON responses fail closed until the confirmation gate and
 * file downloads exist. The call over `maxCalls` is not sent and ends the run, so `paginate`
 * never returns a partial list.
 */
export function createClient({ baseUrl, token, maxCalls }: ClientOptions): {
  request: HostFunction;
  paginate: HostFunction;
} {
  if (new URL(baseUrl).protocol !== 'https:') {
    throw new HostError({
      kind: 'invalid_base_url',
      message: `The sevDesk base URL must use HTTPS: ${baseUrl}`,
    });
  }
  let sent = 0;
  const withinBudget = () => (sent += 1) <= maxCalls;

  const request: HostFunction = (args, signal) => {
    const call = prepare(baseUrl, args);
    if (!withinBudget()) {
      throw budgetError(
        maxCalls,
        `${call.method} ${call.path} was not sent.`,
        'Fetch fewer, larger pages, or filter with query parameters.',
      );
    }
    return send(call, { token, signal, retry: DEFAULT_RETRY });
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
      const items = listObjects(call, await send(page, { token, signal, retry: DEFAULT_RETRY }));
      // Only an empty page ends the list: should sevDesk cap a page below PAGE_SIZE, a short
      // page is not the last one.
      if (items.length === 0) return objects;
      objects.push(...items);
    }
  };

  return { request, paginate };
}

/**
 * The account's bookkeeping system check: undefined for system 2.0, an `unsupported_account`
 * error for anything else (PRD §5.4). A failed request rejects with its `HostError`.
 */
export async function bookkeepingSystemError(
  request: HostFunction,
  profile: string,
  signal: AbortSignal,
): Promise<SnippetError | undefined> {
  const response = await request(['GET', '/Tools/bookkeepingSystemVersion'], signal);
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
