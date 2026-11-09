import { HostError, type HostFunction, type SnippetError } from './sandbox.ts';

/** sevDesk's API base (PRD §5.6). It must be HTTPS so the token never travels in clear text. */
export const DEFAULT_BASE_URL = 'https://my.sevdesk.de/api/v1';

/** The most sevDesk calls one `execute` run may send (PRD §5.3). */
export const DEFAULT_CALL_BUDGET = 50;

// A path relative to the base: segments of letters, digits, `-` and `_`. sevDesk's paths use only
// letters and numeric ids, so this rejects absolute and protocol-relative URLs, other hosts, dot
// segments, backslashes, percent-encoding, `?`, `#` and whitespace before anything is sent.
const RELATIVE_PATH = /^(?:\/[A-Za-z0-9_-]+)+$/;

// Methods that write. They need the confirmation gate, which does not exist yet.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

const TOKEN_HINT =
  'sevDesk rejected the API token (wrong, expired or revoked). Set a valid SEVDESK_API_TOKEN for this MCP server and restart it.';

/** A validated call, ready to send. */
interface Call {
  method: string;
  path: string;
  url: URL;
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
 * Validates the code's arguments `(method, path, options)` and builds the URL. Anything that is
 * not a plain read fails closed before a request exists: writes, and `getPdf` without
 * `preventSendBy=true`, which can mark the document as sent (decision 7).
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
  const getsPdf = path.split('/').some((segment) => segment.toLowerCase() === 'getpdf');
  if (getsPdf && params.get('preventSendBy') !== 'true') {
    throw notEnabled(
      'getPdf without preventSendBy=true can mark the document as sent, which is not enabled yet. Pass { query: { preventSendBy: true } }. Nothing was sent.',
      verb,
      path,
    );
  }
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

/** Sends a validated call with the token and returns the parsed JSON response. */
async function send(call: Call, token: string, signal: AbortSignal): Promise<unknown> {
  const { method, path } = call;
  let response: Response;
  try {
    response = await fetch(call.url.href, {
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
 * Creates `sevdesk.request` for one run: it validates each call, sends at most `maxCalls` of them
 * to `baseUrl` with the token added here (never visible to the code) and returns the parsed JSON.
 * Writes, `getPdf` without `preventSendBy=true` and non-JSON responses fail closed until the
 * confirmation gate and file downloads exist. The call over `maxCalls` is not sent and ends the
 * run.
 */
export function createClient({ baseUrl, token, maxCalls }: ClientOptions): HostFunction {
  if (new URL(baseUrl).protocol !== 'https:') {
    throw new HostError({
      kind: 'invalid_base_url',
      message: `The sevDesk base URL must use HTTPS: ${baseUrl}`,
    });
  }
  let sent = 0;
  return (args, signal) => {
    const call = prepare(baseUrl, args);
    sent += 1;
    if (sent > maxCalls) {
      throw new HostError(
        {
          kind: 'call_budget',
          message: `The run reached the limit of ${String(maxCalls)} sevDesk calls and was stopped; ${call.method} ${call.path} was not sent.`,
          hint: 'Fetch fewer, larger pages, or filter with query parameters.',
        },
        true,
      );
    }
    return send(call, token, signal);
  };
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
