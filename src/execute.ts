import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { type Config, DEFAULT_CONFIG, type LoadedConfig } from './config.ts';
import { errorResult, toToolResult } from './envelope.ts';
import { readToken } from './keychain.ts';
import { defaultDownloadDir } from './paths.ts';
import {
  describeProfiles,
  type Profile,
  type ReachableProfile,
  reachableProfiles,
  selectProfile,
} from './profile.ts';
import { HostError, runSnippet, type SnippetError } from './sandbox.ts';
import { bookkeepingSystemError, createClient, PAGE_SIZE, PDF_TYPES } from './sevdesk.ts';

/** The tool description, with the configured call budget and output limit. */
const description = ({
  maxCalls,
  limits,
}: Config) => `Call the sevDesk REST API. \`code\` is the body of an async JavaScript function, run in a sandbox with \`console.log\`, \`sevdesk.request(method, path, { query })\`, \`sevdesk.paginate(path, query)\` and \`sevdesk.savePdf(type, id)\`; no other network or file access. \`path\` is relative to the API base (e.g. '/Contact'); a request resolves to the parsed JSON or throws an Error with \`status\`, \`sevdeskMessage\` and \`hint\`. A non-JSON response (e.g. a CSV export) is saved as a new file in the profile's download folder and resolves to \`{ path, contentType, bytes }\`. \`paginate\` resolves to all objects of a list as one array, fetched in pages of ${String(PAGE_SIZE)} (each page is a call). \`savePdf\` saves a document's PDF (type one of ${Object.keys(PDF_TYPES).join(', ')}) in that folder as <number>.pdf, replacing an older copy, without marking it sent; it resolves to \`{ path, fileName }\` and costs 2 calls. File contents never come back. Rate limits (429) and GET server errors (5xx) are retried automatically. Only GET is enabled so far, at most ${String(maxCalls)} calls per run. Find paths and parameters with \`search\` first. Only the return value and console output come back, each cut at ${String(limits.outputChars)} characters, so return just what you need, e.g.:
const r = await sevdesk.request('GET', '/Contact', { query: { depth: 1, limit: 10 } });
return r.objects.map((c) => ({ id: c.id, name: c.name }))`;

interface Input {
  code: string;
  account?: string;
}

/**
 * The input schema: `code`, and `account` as an enum of the reachable profiles with their companies
 * when there are any. `account` is never required by the schema, so a call without it reaches the
 * handler, which asks for it with the list of profiles when there are several.
 */
function inputSchema(profiles: ReachableProfile[]) {
  const properties: Record<string, object> = {
    code: { type: 'string', description: 'Body of an async JavaScript function; use return.' },
  };
  if (profiles.length > 0) {
    properties.account = {
      type: 'string',
      enum: profiles.map(({ name }) => name),
      description: `sevDesk profile to use, one of: ${describeProfiles(profiles)}. Required when there are several.`,
    };
  }
  return fromJsonSchema<Input>({ type: 'object', properties, required: ['code'] });
}

/**
 * Registers `execute`: the model's code runs in the sandbox with `sevdesk.request`,
 * `sevdesk.paginate` and `sevdesk.savePdf` against the sevDesk account of the profile it selects
 * with `account` (decision 1: among the profiles this server reaches, `pinnedProfile` narrowing them
 * to one), at the configured base URL, within the configured limits and call budget, saving files in
 * the profile's download directory. A keychain profile's token is read on every call. The
 * bookkeeping system is checked on the first call per profile and remembered for the session (this
 * server instance), never at startup. With an invalid config file it returns the config error and
 * sends nothing.
 */
export function registerExecuteTool(
  server: McpServer,
  loaded: LoadedConfig,
  pinnedProfile: string | undefined,
): void {
  const config = loaded.ok ? loaded.config : DEFAULT_CONFIG;
  const reachable = reachableProfiles(config, pinnedProfile);
  // Per profile name: the check in flight or its outcome (undefined for system 2.0).
  const checks = new Map<string, Promise<SnippetError | undefined>>();

  /** The bookkeeping-system error of `profile`, if any. A failed check is not remembered. */
  function checkAccount(profile: Profile): Promise<SnippetError | undefined> {
    let check = checks.get(profile.name);
    if (check === undefined) {
      check = bookkeepingSystemError(
        { baseUrl: config.baseUrl, token: profile.token },
        profile.name,
        AbortSignal.timeout(config.limits.timeoutMs),
      );
      checks.set(profile.name, check);
      void check.catch(() => checks.delete(profile.name));
    }
    return check;
  }

  /**
   * The profile `account` selects, with its token and download directory (the configured one, else
   * `~/Downloads/sevdesk/<name>`), or the error that stops the call.
   */
  async function profileFor(
    account: string | undefined,
  ): Promise<{ ok: true; profile: Profile } | { ok: false; error: SnippetError }> {
    if (!reachable.ok) return reachable;
    const selected = selectProfile(reachable.profiles, account);
    if (!selected.ok) return selected;
    const { name, token } = selected.profile;
    const downloadDir = selected.profile.downloadDir ?? defaultDownloadDir(name);
    if (token !== undefined) return { ok: true, profile: { name, token, downloadDir } };
    const read = await readToken(name);
    return read.ok ? { ok: true, profile: { name, token: read.token, downloadDir } } : read;
  }

  server.registerTool(
    'execute',
    {
      description: description(config),
      inputSchema: inputSchema(reachable.ok ? reachable.profiles : []),
    },
    async ({ code, account }) => {
      if (!loaded.ok) return errorResult(loaded.error);
      const resolved = await profileFor(account);
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
        downloadDir: profile.downloadDir,
      });
      const outcome = await runSnippet(code, {}, config.limits, { sevdesk });
      return toToolResult(outcome, config.limits.outputChars);
    },
  );
}
