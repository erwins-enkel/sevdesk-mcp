import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDirs } from './paths.ts';
import { DEFAULT_LIMITS, type SandboxLimits, type SnippetError } from './sandbox.ts';
import { DEFAULT_BASE_URL, DEFAULT_CALL_BUDGET } from './sevdesk.ts';

/** The settings of the config file (decision 13), in the units the code works with. */
export interface Config {
  /** sevDesk's API base: HTTPS, without a trailing slash. */
  baseUrl: string;
  /** The limits of every sandbox run, `search` and `execute` alike. */
  limits: SandboxLimits;
  /** The most sevDesk calls one `execute` run may send. */
  maxCalls: number;
}

/** What applies without a config file, and for every key the file leaves out. */
export const DEFAULT_CONFIG: Config = {
  baseUrl: DEFAULT_BASE_URL,
  limits: DEFAULT_LIMITS,
  maxCalls: DEFAULT_CALL_BUDGET,
};

/** The outcome of reading the config file: the config, or why the file is unusable. */
export type LoadedConfig = { ok: true; config: Config } | { ok: false; error: SnippetError };

// The limits in the file, in its units, with their allowed range. The bounds keep the runtime
// sound: QuickJS needs about 4 MB just to hold the embedded spec for `search`, 4096 MB or more
// breaks its 32-bit heap, and an hour keeps the run's timer far below Node's limit.
const LIMIT_RANGES = {
  timeoutSeconds: { min: 1, max: 3600 },
  memoryMb: { min: 16, max: 2048 },
  callsPerRun: { min: 1, max: Number.MAX_SAFE_INTEGER },
  outputChars: { min: 1, max: Number.MAX_SAFE_INTEGER },
};
type LimitKey = keyof typeof LIMIT_RANGES;

const TOP_LEVEL_KEYS = new Set(['baseUrl', 'limits']);

const HINT = 'Fix the file or delete it to use the defaults, then restart the MCP server.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The path of the config file in the config directory. */
export function configFile(): string {
  return join(localDirs().config, 'config.json');
}

function isLimitKey(key: string): key is LimitKey {
  return Object.hasOwn(LIMIT_RANGES, key);
}

/** `value` as `limits.<key>`, or the problem when it is not an integer in the key's range. */
function readLimit(key: LimitKey, value: unknown): { limit: number } | { problem: string } {
  const { min, max } = LIMIT_RANGES[key];
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return { limit: value };
  }
  const range =
    max === Number.MAX_SAFE_INTEGER
      ? 'a positive integer'
      : `an integer from ${String(min)} to ${String(max)}`;
  return { problem: `limits.${key} must be ${range}, not ${JSON.stringify(value)}` };
}

/** `limits` of the file; each problem is added to `problems`. */
function readLimits(value: unknown, problems: string[]): Partial<Record<LimitKey, number>> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    problems.push('limits must be an object');
    return {};
  }
  const limits: Partial<Record<LimitKey, number>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isLimitKey(key)) {
      problems.push(`unknown key "limits.${key}"`);
      continue;
    }
    const read = readLimit(key, entry);
    if ('problem' in read) problems.push(read.problem);
    else limits[key] = read.limit;
  }
  return limits;
}

/**
 * `baseUrl` of the file without a trailing slash; a problem is added to `problems`. The value is
 * never echoed: it could carry credentials.
 */
function readBaseUrl(value: unknown, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  const url = typeof value === 'string' ? URL.parse(value) : null;
  if (url === null) {
    problems.push('baseUrl must be a URL string');
  } else if (url.protocol !== 'https:') {
    problems.push(
      `baseUrl must use https://, not ${url.protocol}//, so the token never travels in clear text`,
    );
  } else if (url.username !== '' || url.password !== '') {
    problems.push('baseUrl must not contain credentials');
  } else if (url.search !== '' || url.hash !== '') {
    problems.push('baseUrl must not contain a query or fragment');
  } else {
    return url.origin + url.pathname.replace(/\/+$/, '');
  }
  return undefined;
}

/** The config from the file's parsed JSON, or the problems that make it invalid. */
function toConfig(json: unknown): { config: Config; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(json)) {
    return { config: DEFAULT_CONFIG, problems: ['it must hold a JSON object'] };
  }
  for (const key of Object.keys(json)) {
    if (!TOP_LEVEL_KEYS.has(key)) problems.push(`unknown key "${key}"`);
  }
  const baseUrl = readBaseUrl(json.baseUrl, problems);
  const { timeoutSeconds, memoryMb, callsPerRun, outputChars } = readLimits(json.limits, problems);
  const config: Config = {
    baseUrl: baseUrl ?? DEFAULT_CONFIG.baseUrl,
    limits: {
      timeoutMs: timeoutSeconds === undefined ? DEFAULT_LIMITS.timeoutMs : timeoutSeconds * 1000,
      memoryBytes: memoryMb === undefined ? DEFAULT_LIMITS.memoryBytes : memoryMb * 1024 * 1024,
      outputChars: outputChars ?? DEFAULT_LIMITS.outputChars,
    },
    maxCalls: callsPerRun ?? DEFAULT_CONFIG.maxCalls,
  };
  return { config, problems };
}

function invalid(message: string): LoadedConfig {
  return { ok: false, error: { kind: 'invalid_config', message, hint: HINT } };
}

/**
 * Reads the config file. A missing file means the defaults; every key the file leaves out keeps its
 * default. An unreadable file, invalid JSON, an unknown key or an invalid value fails closed with
 * the file's path and every problem found, never with a silent default.
 */
export function loadConfig(file = configFile()): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true, config: DEFAULT_CONFIG };
    return invalid(`The config file ${file} could not be read (${code ?? String(error)}).`);
  }
  let json: unknown;
  try {
    // A leading byte-order mark (some Windows editors write one) is not part of the JSON.
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return invalid(
      `The config file ${file} is invalid: it is not valid JSON (${(error as Error).message}).`,
    );
  }
  const { config, problems } = toConfig(json);
  if (problems.length > 0)
    return invalid(`The config file ${file} is invalid: ${problems.join('; ')}.`);
  return { ok: true, config };
}
