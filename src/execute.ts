import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { type Config, DEFAULT_CONFIG, type LoadedConfig } from './config.ts';
import { errorResult, toToolResult } from './envelope.ts';
import { type Profile, resolveEnvProfile } from './profile.ts';
import { HostError, runSnippet, type SnippetError } from './sandbox.ts';
import { bookkeepingSystemError, createClient, PAGE_SIZE } from './sevdesk.ts';

/** The tool description, with the configured call budget and output limit. */
const description = ({
  maxCalls,
  limits,
}: Config) => `Call the sevDesk REST API. \`code\` is the body of an async JavaScript function, run in a sandbox with \`console.log\`, \`sevdesk.request(method, path, { query })\` and \`sevdesk.paginate(path, query)\`; no other network or file access. \`path\` is relative to the API base (e.g. '/Contact'); a request resolves to the parsed JSON or throws an Error with \`status\`, \`sevdeskMessage\` and \`hint\`. \`paginate\` resolves to all objects of a list as one array, fetched in pages of ${String(PAGE_SIZE)} (each page is a call). Rate limits (429) and GET server errors (5xx) are retried automatically. Only GET is enabled so far, at most ${String(maxCalls)} calls per run. Find paths and parameters with \`search\` first. Only the return value and console output come back, each cut at ${String(limits.outputChars)} characters, so return just what you need, e.g.:
const r = await sevdesk.request('GET', '/Contact', { query: { depth: 1, limit: 10 } });
return r.objects.map((c) => ({ id: c.id, name: c.name }))`;

/**
 * Registers `execute`: the model's code runs in the sandbox with `sevdesk.request` and
 * `sevdesk.paginate` against the profile's sevDesk account at the configured base URL, within the
 * configured limits and call budget. The bookkeeping system is checked on the first call per
 * profile and remembered for the session (this server instance), never at startup. With an invalid
 * config file it returns the config error and sends nothing.
 */
export function registerExecuteTool(server: McpServer, loaded: LoadedConfig): void {
  const config = loaded.ok ? loaded.config : DEFAULT_CONFIG;
  const resolved = resolveEnvProfile();
  // Per profile name: the check in flight or its outcome (undefined for system 2.0).
  const checks = new Map<string, Promise<SnippetError | undefined>>();

  /** The bookkeeping-system error of `profile`, if any. A failed check is not remembered. */
  function checkAccount(profile: Profile): Promise<SnippetError | undefined> {
    let check = checks.get(profile.name);
    if (check === undefined) {
      const { request } = createClient({
        baseUrl: config.baseUrl,
        token: profile.token,
        maxCalls: 1,
      });
      check = bookkeepingSystemError(
        request,
        profile.name,
        AbortSignal.timeout(config.limits.timeoutMs),
      );
      checks.set(profile.name, check);
      void check.catch(() => checks.delete(profile.name));
    }
    return check;
  }

  server.registerTool(
    'execute',
    {
      description: description(config),
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
      if (!loaded.ok) return errorResult(loaded.error);
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
        baseUrl: config.baseUrl,
        token: profile.token,
        maxCalls: config.maxCalls,
      });
      const outcome = await runSnippet(code, {}, config.limits, { sevdesk });
      return toToolResult(outcome, config.limits.outputChars);
    },
  );
}
