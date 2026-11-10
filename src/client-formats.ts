import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, patch as patchToml } from '@decimalturn/toml-patch';
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
  printParseErrorCode,
} from 'jsonc-parser';
import { isRecord, parseJsonObject } from './json-file.ts';

/** A client config's servers by name. */
export type Servers = Record<string, unknown>;

/**
 * How a client's config file holds its MCP servers by name (decision 18). `text` is the file's
 * content without a byte-order mark, or undefined when there is no file yet.
 */
export interface ConfigFormat {
  /** The servers in `text`, none when it has none yet. Throws when the file `path` cannot be used. */
  servers(text: string | undefined, path: string): Servers;
  /** `text` with `servers` as its servers and everything else kept. Throws like `servers`. */
  write(text: string | undefined, servers: Servers, path: string): string;
}

/** The servers under `key` of `document`, the content of `path`, which must be a `kind` if set. */
function serversIn(
  document: Record<string, unknown>,
  key: string,
  kind: string,
  path: string,
): Servers {
  const value = document[key];
  const servers = value === undefined ? {} : value;
  if (!isRecord(servers)) throw new Error(`${key} in ${path} is not a ${kind}`);
  return servers;
}

const CLAUDE_SERVERS = 'mcpServers';

/** Claude Desktop's and Claude Code's JSON: the servers are under `mcpServers`. */
export const CLAUDE_JSON: ConfigFormat = {
  servers(text, path) {
    return text === undefined
      ? {}
      : serversIn(parseJsonObject(text, path), CLAUDE_SERVERS, 'JSON object', path);
  },
  // The whole file is written anew, two-space indented; JSON holds no comments to keep.
  write(text, servers, path) {
    const json = text === undefined ? {} : parseJsonObject(text, path);
    return `${JSON.stringify({ ...json, [CLAUDE_SERVERS]: servers }, null, 2)}\n`;
  },
};

/** The first and the last line of `message`: the parser's position and its complaint. */
function brief(message: string): string {
  const lines = message.split('\n');
  return lines.length > 1 ? `${lines[0] ?? ''} ${lines.at(-1) ?? ''}` : message;
}

/** The TOML document in `text` as a JS object; an empty one when there is no file. */
function tomlDocument(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let document: unknown;
  try {
    document = parseToml(text);
  } catch (error) {
    throw new Error(brief(error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  // A TOML document is always a table.
  return document as Record<string, unknown>;
}

/** `value` with every table a plain object, so two documents compare by their content alone. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (!isRecord(value) || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
}

const TOML_SERVERS = 'mcp_servers';

/**
 * The TOML of ChatGPT Desktop and the Codex CLI: the servers are the tables under `mcp_servers`.
 * Only what changed is rewritten, so comments and formatting stay; a new entry becomes a
 * `[mcp_servers.<name>]` section where the file's layout allows. The written text must parse back
 * to the intended document, else nothing is written.
 */
export const CODEX_TOML: ConfigFormat = {
  servers(text, path) {
    return serversIn(tomlDocument(text), TOML_SERVERS, 'table', path);
  },
  write(text, servers, path) {
    const intended = { ...tomlDocument(text), [TOML_SERVERS]: servers };
    // An existing file keeps its final line break or its lack of one; a new file gets one.
    const format =
      text === undefined ? { inlineTableStart: 2, trailingNewline: 1 } : { inlineTableStart: 2 };
    const written = patchToml(text ?? '', intended, format);
    if (!isDeepStrictEqual(plain(tomlDocument(written)), plain(intended))) {
      throw new Error(`the change to ${path} did not come out as intended`);
    }
    return written;
  },
};

/** The JSON object in `text`, which may hold comments and trailing commas (JSONC). */
function jsoncDocument(text: string | undefined, path: string): Record<string, unknown> {
  if (text === undefined) return {};
  const errors: ParseError[] = [];
  const document: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  const [error] = errors;
  if (error !== undefined) {
    const line = text.slice(0, error.offset).split('\n').length;
    throw new Error(`${printParseErrorCode(error.error)} in line ${String(line)}`);
  }
  if (!isRecord(document)) throw new Error(`${path} does not hold a JSON object`);
  return document;
}

/**
 * Whether `value`, found under `mcp.servers`, is OpenCode 2's envelope of servers rather than a
 * server named `servers`; OpenCode's own test: a server has a `type` or `enabled` that is no object.
 */
function isEnvelope(value: unknown): boolean {
  return (
    isRecord(value) &&
    !['type', 'enabled'].some((key) => Object.hasOwn(value, key) && !isRecord(value[key]))
  );
}

/** OpenCode's servers under `mcp`; a file in OpenCode 2's `mcp.servers` layout is not used. */
function openCodeServers(text: string | undefined, path: string): Servers {
  const servers = serversIn(jsoncDocument(text, path), 'mcp', 'JSON object', path);
  if (isEnvelope(servers.servers)) {
    throw new Error(
      `mcp.servers in ${path} is the layout of OpenCode 2, which setup does not edit`,
    );
  }
  return servers;
}

// How `opencode mcp add` formats the entries it writes.
const OPENCODE_EDIT = { formattingOptions: { tabSize: 2, insertSpaces: true } };

/**
 * OpenCode's JSONC: the servers are under `mcp`. Each changed entry is edited in place, as
 * `opencode mcp add` does, so comments and the rest of the file stay.
 */
export const OPENCODE_JSONC: ConfigFormat = {
  servers: openCodeServers,
  write(text, servers, path) {
    const current = openCodeServers(text, path);
    let written = text ?? '{}\n';
    for (const name of new Set([...Object.keys(current), ...Object.keys(servers)])) {
      if (!isDeepStrictEqual(current[name], servers[name])) {
        written = applyEdits(written, modify(written, ['mcp', name], servers[name], OPENCODE_EDIT));
      }
    }
    return written;
  },
};
