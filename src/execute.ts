import { type CallToolResult, fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { toToolResult } from './envelope.ts';
import { type Profile, resolveEnvProfile } from './profile.ts';
import { DEFAULT_LIMITS, HostError, runSnippet, type SnippetError } from './sandbox.ts';
import {
  bookkeepingSystemError,
  createClient,
  DEFAULT_BASE_URL,
  DEFAULT_CALL_BUDGET,
  PAGE_SIZE,
} from './sevdesk.ts';

const description = `Call the sevDesk REST API. \`code\` is the body of an async JavaScript function, run in a sandbox with \`console.log\`, \`sevdesk.request(method, path, { query })\` and \`sevdesk.paginate(path, query)\`; no other network or file access. \`path\` is relative to the API base (e.g. '/Contact'); a request resolves to the parsed JSON or throws an Error with \`status\`, \`sevdeskMessage\` and \`hint\`. \`paginate\` resolves to all objects of a list as one array, fetched in pages of ${String(PAGE_SIZE)} (each page is a call). Rate limits (429) and GET server errors (5xx) are retried automatically. Only GET is enabled so far, at most ${String(DEFAULT_CALL_BUDGET)} calls per run. Find paths and parameters with \`search\` first. Only the return value and console output come back, each cut at ${String(DEFAULT_LIMITS.outputChars)} characters, so return just what you need, e.g.:
const r = await sevdesk.request('GET', '/Contact', { query: { depth: 1, limit: 10 } });
return r.objects.map((c) => ({ id: c.id, name: c.name }))`;

/** The tool result of an error that ended the call before the code ran. */
function errorResult(error: SnippetError): CallToolResult {
  return toToolResult(
    { ok: false, error, console: [], consoleCut: false },
    DEFAULT_LIMITS.outputChars,
  );
}

/**
 * Registers `execute`: the model's code runs in the sandbox with `sevdesk.request` and
 * `sevdesk.paginate` against the profile's sevDesk account. The bookkeeping system is checked on
 * the first call per profile and remembered for the session (this server instance), never at
 * startup.
 */
export function registerExecuteTool(server: McpServer): void {
  const resolved = resolveEnvProfile();
  // Per profile name: the check in flight or its outcome (undefined for system 2.0).
  const checks = new Map<string, Promise<SnippetError | undefined>>();

  /** The bookkeeping-system error of `profile`, if any. A failed check is not remembered. */
  function checkAccount(profile: Profile): Promise<SnippetError | undefined> {
    let check = checks.get(profile.name);
    if (check === undefined) {
      const { request } = createClient({
        baseUrl: DEFAULT_BASE_URL,
        token: profile.token,
        maxCalls: 1,
      });
      check = bookkeepingSystemError(
        request,
        profile.name,
        AbortSignal.timeout(DEFAULT_LIMITS.timeoutMs),
      );
      checks.set(profile.name, check);
      void check.catch(() => checks.delete(profile.name));
    }
    return check;
  }

  server.registerTool(
    'execute',
    {
      description,
      inputSchema: fromJsonSchema<{ code: string }>({
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Body of an async JavaScript function; use return.',
          },
        },
        required: ['code'],
      }),
    },
    async ({ code }) => {
      if (!resolved.ok) return errorResult(resolved.error);
      const { profile } = resolved;
      try {
        const accountError = await checkAccount(profile);
        if (accountError) return errorResult(accountError);
      } catch (error) {
        if (!(error instanceof HostError)) throw error;
        return errorResult(error.error);
      }
      const sevdesk = createClient({
        baseUrl: DEFAULT_BASE_URL,
        token: profile.token,
        maxCalls: DEFAULT_CALL_BUDGET,
      });
      const outcome = await runSnippet(code, {}, DEFAULT_LIMITS, { sevdesk });
      return toToolResult(outcome, DEFAULT_LIMITS.outputChars);
    },
  );
}
