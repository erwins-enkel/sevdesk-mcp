import { type CallToolResult, fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { type Config, DEFAULT_CONFIG, type LoadedConfig } from './config.ts';
import { createConfirmations, previewHeld } from './confirm.ts';
import { confirmedResult, errorResult, toToolResult } from './envelope.ts';
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
import {
  bookkeepingSystemError,
  createClient,
  PAGE_SIZE,
  PDF_TYPES,
  READ_ONLY_HINT,
  replay,
} from './sevdesk.ts';

/** The tool description, with the configured call budget and output limit. */
const description = ({
  maxCalls,
  limits,
}: Config) => `Call the sevDesk REST API. \`code\` is the body of an async JavaScript function, run in a sandbox with \`console.log\`, \`sevdesk.request(method, path, { query, body })\`, \`sevdesk.paginate(path, query)\` and \`sevdesk.savePdf(type, id)\`; no other network or file access. \`path\` is relative to the API base (e.g. '/Contact'), \`body\` a JSON object; a request resolves to the parsed JSON or throws an Error with \`status\`, \`sevdeskMessage\` and \`hint\`. A non-JSON response (e.g. a CSV export) is saved as a new file in the profile's download folder and resolves to \`{ path, contentType, bytes }\`. \`paginate\` resolves to all objects of a list as one array, fetched in pages of ${String(PAGE_SIZE)} (each page is a call). \`savePdf\` saves a document's PDF (type one of ${Object.keys(PDF_TYPES).join(', ')}) in that folder as <number>.pdf, replacing an older copy, without marking it sent; it resolves to \`{ path, fileName }\` and costs 2 calls. File contents never come back. Rate limits (429) and GET server errors (5xx) are retried automatically, at most ${String(maxCalls)} calls per run, held calls and their preview reads included. Reads and the POST/PUT calls that create or change drafts run directly. Irreversible calls are held, not sent, and resolve to { held: true }: DELETE, sending, enshrine, bookAmount, cancel, reset, a status in an Invoice/Order/CreditNote/Voucher body (only a new draft via Factory/save* may carry its draft status), getPdf without preventSendBy=true, write paths not in the spec. A successful run with held calls returns \`confirmation\`: a preview of each and a token. Show the user the preview; only after their yes call execute with \`confirm\` (the token) and no \`code\`: it sends exactly those calls once, in order, stops at the first failure and reports each in \`confirmed\`. A token works once, for 10 minutes. Find paths and parameters with \`search\` first. Only the return value and console output (each cut at ${String(limits.outputChars)} characters) come back, plus \`writes\`: every write sent (method, path, status, objectId), also when the code fails. Return just what you need, e.g.:
const r = await sevdesk.request('GET', '/Contact', { query: { depth: 1, limit: 10 } });
return r.objects.map((c) => ({ id: c.id, name: c.name }))`;

interface Input {
  code?: string;
  confirm?: string;
  account?: string;
}

/**
 * The input schema: `code` or `confirm`, and `account` as an enum of the reachable profiles with
 * their companies when there are any. The schema requires nothing (a top-level `oneOf` is not
 * accepted by every client): the handler checks that exactly one of `code` and `confirm` is given,
 * and asks for `account` with the list of profiles when there are several.
 */
function inputSchema(profiles: ReachableProfile[]) {
  const properties: Record<string, object> = {
    code: { type: 'string', description: 'Body of an async JavaScript function; use return.' },
    confirm: { type: 'string', description: 'Token of a confirmation; replaces code.' },
  };
  if (profiles.length > 0) {
    properties.account = {
      type: 'string',
      enum: profiles.map(({ name }) => name),
      description: `sevDesk profile to use, one of: ${describeProfiles(profiles)}. Required when there are several.`,
    };
  }
  return fromJsonSchema<Input>({ type: 'object', properties });
}

/** What the call asks for: run `code`, or redeem `confirm`; undefined unless exactly one is given. */
function intentOf({ code, confirm }: Input): { code: string } | { confirm: string } | undefined {
  if (code !== undefined && confirm === undefined) return { code };
  if (confirm !== undefined && code === undefined) return { confirm };
  return undefined;
}

const CODE_OR_CONFIRM: SnippetError = {
  kind: 'invalid_request',
  message: 'Pass either code (JavaScript to run) or confirm (a confirmation token), not both.',
};

/**
 * Whether `SEVDESK_READONLY` makes every profile read-only (decision 3): any value but unset,
 * empty, `false` and `0` (case ignored), so a mistyped value errs on the safe side.
 */
function readOnlySwitch(): boolean {
  const value = process.env.SEVDESK_READONLY?.trim().toLowerCase();
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

/**
 * Registers `execute`: the model's code runs in the sandbox with `sevdesk.request`,
 * `sevdesk.paginate` and `sevdesk.savePdf` against the sevDesk account of the profile it selects
 * with `account` (decision 1: among the profiles this server reaches, `pinnedProfile` narrowing them
 * to one), at the configured base URL, within the configured limits and call budget, saving files in
 * the profile's download directory. A keychain profile's token is read on every call. The
 * bookkeeping system is checked on the first call per profile and remembered for the session (this
 * server instance), never at startup. With an invalid config file it returns the config error and
 * sends nothing. Reversible writes run, and the result lists every write the run sent. Irreversible
 * calls are held (decision 5): a run that succeeds returns their previews and a token, which
 * `confirm` (on the same profile, instead of `code`) redeems once to send exactly those calls.
 * Read-only mode (decision 3), from `SEVDESK_READONLY` (read once per server) or the profile's
 * `readonly`, rejects every write and irreversible call, and every `confirm`. The tool carries the
 * read-only annotation when the switch is on or the pinned profile is read-only, otherwise the
 * destructive one.
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
  const confirmations = createConfirmations();
  const envReadOnly = readOnlySwitch();
  // A pin narrows the reachable profiles to the pinned one.
  const pinnedReadOnly =
    pinnedProfile !== undefined && reachable.ok && reachable.profiles[0]?.readonly === true;

  /** Why calls for `profile` are read-only (decision 3), or undefined when it may write. */
  function readOnlyReason({ name, readonly }: Profile): string | undefined {
    if (envReadOnly) return 'SEVDESK_READONLY is on';
    return readonly ? `profile ${name} is read-only` : undefined;
  }

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
    const { name, token, company } = selected.profile;
    const downloadDir = selected.profile.downloadDir ?? defaultDownloadDir(name);
    const readonly = selected.profile.readonly === true;
    if (token !== undefined) {
      return { ok: true, profile: { name, token, downloadDir, company, readonly } };
    }
    const read = await readToken(name);
    return read.ok
      ? { ok: true, profile: { name, token: read.token, downloadDir, company, readonly } }
      : read;
  }

  /**
   * Redeems `token` for `profile`: sends the held calls it stands for, exactly as stored, without
   * running any code (decision 5). The bookkeeping system was checked by the run that held them. A
   * read-only profile is rejected before the token is looked at, so no token gets past read-only.
   */
  async function confirmHeld(token: string, profile: Profile): Promise<CallToolResult> {
    const readOnly = readOnlyReason(profile);
    if (readOnly !== undefined) {
      return errorResult({
        kind: 'read_only',
        message: `The confirmation was rejected: ${readOnly}, so no held call can be sent. Nothing was sent.`,
        hint: READ_ONLY_HINT,
      });
    }
    const taken = confirmations.take(token, profile.name);
    if (!taken.ok) return errorResult(taken.error);
    const signal = AbortSignal.timeout(config.limits.timeoutMs);
    const { token: apiToken, downloadDir } = profile;
    return confirmedResult(await replay(taken.calls, { token: apiToken, downloadDir, signal }));
  }

  /**
   * Runs `code` for `profile`. When the run succeeds with held calls, their previews (reading each
   * document they act on, after the run) and a token come back; when the run or a preview read
   * fails, the held calls are dropped and no token is issued (fail closed).
   */
  async function run(code: string, profile: Profile): Promise<CallToolResult> {
    const { request, paginate, savePdf, writes, held, readDocument } = createClient({
      baseUrl: config.baseUrl,
      token: profile.token,
      maxCalls: config.maxCalls,
      downloadDir: profile.downloadDir,
      readOnly: readOnlyReason(profile),
    });
    const outcome = await runSnippet(code, {}, config.limits, {
      sevdesk: { request, paginate, savePdf },
    });
    const { outputChars, timeoutMs } = config.limits;
    const dropped = { dropped: held.map(({ method, path }) => `${method} ${path}`) };
    if (!outcome.ok || held.length === 0)
      return toToolResult(outcome, outputChars, writes, dropped);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const previews = await previewHeld(held, (path) => readDocument(path, signal));
      const confirmation = confirmations.issue(profile, held, previews);
      return toToolResult(outcome, outputChars, writes, { confirmation });
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      return toToolResult(
        { ...outcome, ok: false, error: error.error },
        outputChars,
        writes,
        dropped,
      );
    }
  }

  server.registerTool(
    'execute',
    {
      description: description(config),
      inputSchema: inputSchema(reachable.ok ? reachable.profiles : []),
      annotations:
        envReadOnly || pinnedReadOnly
          ? { readOnlyHint: true, destructiveHint: false }
          : { destructiveHint: true },
    },
    async (input) => {
      if (!loaded.ok) return errorResult(loaded.error);
      const intent = intentOf(input);
      if (intent === undefined) return errorResult(CODE_OR_CONFIRM);
      const resolved = await profileFor(input.account);
      if (!resolved.ok) return errorResult(resolved.error);
      const { profile } = resolved;
      if ('confirm' in intent) return confirmHeld(intent.confirm, profile);
      try {
        const accountError = await checkAccount(profile);
        if (accountError) return errorResult(accountError);
      } catch (error) {
        if (!(error instanceof HostError)) throw error;
        return errorResult(error.error);
      }
      return run(intent.code, profile);
    },
  );
}
