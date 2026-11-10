import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isRecord, readJsonFile, writeJsonFile } from './json-file.ts';
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
  /** The configured profiles, in the order of the file. */
  profiles: ProfileSettings[];
  /** Whether `execute` writes the audit log (decision 16); `"audit": false` turns it off. */
  audit: boolean;
}

/** A profile of the config file (decision 13). Its token is never here: it lives in the OS keychain. */
export interface ProfileSettings {
  /** 1 to 32 characters a-z, 0-9 and -; also the account of its keychain entry. */
  name: string;
  /** The sevDesk company name, listed next to the name so the model can tell the accounts apart. */
  company: string;
  /** Read-only profile (decision 3): `execute` rejects its writes and irreversible calls. */
  readonly: boolean;
  /** Where its files land, an absolute path; without it `~/Downloads/sevdesk/<name>` (decision 14). */
  downloadDir?: string;
}

// Profile names (decision 18); a name later becomes a directory name.
const PROFILE_NAME = /^[a-z0-9-]{1,32}$/;

/** Whether `name` is a valid profile name: 1 to 32 characters a-z, 0-9 and -. */
export function isProfileName(name: string): boolean {
  return PROFILE_NAME.test(name);
}

/** What applies without a config file, and for every key the file leaves out. */
export const DEFAULT_CONFIG: Config = {
  baseUrl: DEFAULT_BASE_URL,
  limits: DEFAULT_LIMITS,
  maxCalls: DEFAULT_CALL_BUDGET,
  profiles: [],
  audit: true,
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

const TOP_LEVEL_KEYS = new Set(['baseUrl', 'limits', 'profiles', 'audit']);

const HINT = 'Fix the file or delete it to use the defaults, then restart the MCP server.';

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

/**
 * `downloadDir` of the profile at `at`: `{ downloadDir }` when it is an absolute path, `{}` when it
 * is unset, and undefined when it is anything else, which adds a problem to `problems`.
 */
function readDownloadDir(
  at: string,
  value: unknown,
  problems: string[],
): { downloadDir?: string } | undefined {
  if (value === undefined) return {};
  if (typeof value === 'string' && isAbsolute(value)) return { downloadDir: value };
  problems.push(`${at}.downloadDir must be an absolute path`);
  return undefined;
}

/**
 * The profile `name` of the file, or undefined when it is unusable; each problem is added to
 * `problems`. Any key but `company`, `readonly` and `downloadDir`, a token among them, is unknown: no
 * token is ever read from a plain file (decision 4). Values are never echoed, so a misplaced token
 * cannot reach an error message.
 */
function readProfile(
  name: string,
  value: unknown,
  problems: string[],
): ProfileSettings | undefined {
  const at = `profiles.${name}`;
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`);
    return undefined;
  }
  const { company, readonly = false, downloadDir, ...extra } = value;
  for (const key of Object.keys(extra)) problems.push(`unknown key "${at}.${key}"`);
  const hasCompany = typeof company === 'string' && company.trim() !== '';
  if (!hasCompany) problems.push(`${at}.company must be a non-empty string`);
  if (typeof readonly !== 'boolean') problems.push(`${at}.readonly must be true or false`);
  const dir = readDownloadDir(at, downloadDir, problems);
  return hasCompany && typeof readonly === 'boolean' && dir
    ? { name, company, readonly, ...dir }
    : undefined;
}

/** `profiles` of the file; each problem is added to `problems`. */
function readProfiles(value: unknown, problems: string[]): ProfileSettings[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    problems.push('profiles must be an object of profiles by name');
    return [];
  }
  return Object.entries(value).flatMap(([name, entry]) => {
    if (isProfileName(name)) return readProfile(name, entry, problems) ?? [];
    problems.push(`profile name ${JSON.stringify(name)} must be 1 to 32 characters a-z, 0-9 and -`);
    return [];
  });
}

/** `audit` of the file: true or false, on by default; a problem is added to `problems`. */
function readAudit(value: unknown, problems: string[]): boolean {
  if (value === undefined) return DEFAULT_CONFIG.audit;
  if (typeof value === 'boolean') return value;
  problems.push('audit must be true or false');
  return DEFAULT_CONFIG.audit;
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
  const profiles = readProfiles(json.profiles, problems);
  const config: Config = {
    baseUrl: baseUrl ?? DEFAULT_CONFIG.baseUrl,
    limits: {
      timeoutMs: timeoutSeconds === undefined ? DEFAULT_LIMITS.timeoutMs : timeoutSeconds * 1000,
      memoryBytes: memoryMb === undefined ? DEFAULT_LIMITS.memoryBytes : memoryMb * 1024 * 1024,
      outputChars: outputChars ?? DEFAULT_LIMITS.outputChars,
    },
    maxCalls: callsPerRun ?? DEFAULT_CONFIG.maxCalls,
    profiles,
    audit: readAudit(json.audit, problems),
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

/**
 * Adds `profile` to the config file, or updates the profile of that name (`setup`): its company and
 * read-only flag are set, and every other key of the file, of the other profiles and of the profile
 * itself (such as `downloadDir`) stays as it is. Without a file it creates one, directory included.
 * A failed write never leaves a half-written file. Throws when the file cannot be read or written or
 * is not a JSON object; `loadConfig` has checked it before.
 */
export function saveProfile(
  { name, company, readonly }: Pick<ProfileSettings, 'name' | 'company' | 'readonly'>,
  file = configFile(),
): void {
  const json = readJsonFile(file) ?? {};
  const profiles = isRecord(json.profiles) ? json.profiles : {};
  const existing = profiles[name];
  profiles[name] = { ...(isRecord(existing) ? existing : {}), company, readonly };
  json.profiles = profiles;
  writeJsonFile(file, json);
}

/**
 * Removes the profile `name` from the config file (`setup --remove`); every other key of the file
 * and the other profiles stay as they are, an empty `profiles` object included. A failed write never
 * leaves a half-written file. Throws when the file cannot be read or written or is not a JSON
 * object; `loadConfig` has checked it before.
 */
export function deleteProfile(name: string, file = configFile()): void {
  const json = readJsonFile(file) ?? {};
  if (isRecord(json.profiles)) {
    json.profiles = Object.fromEntries(
      Object.entries(json.profiles).filter(([profile]) => profile !== name),
    );
  }
  writeJsonFile(file, json);
}

/**
 * Sets `key` of the profile `name` in the config file to `value`, or removes the key when `value`
 * is undefined (`config`); every other key of the file and of the profile stays as it is. A failed
 * write never leaves a half-written file. Throws when the file cannot be read or written, is not a
 * JSON object or has no profile `name`.
 */
export function setProfileKey(
  name: string,
  key: 'readonly' | 'downloadDir',
  value: boolean | string | undefined,
  file = configFile(),
): void {
  const json = readJsonFile(file) ?? {};
  const profile = isRecord(json.profiles) ? json.profiles[name] : undefined;
  if (!isRecord(profile)) throw new Error(`the config file has no profile ${name}`);
  if (value === undefined) Reflect.deleteProperty(profile, key);
  else profile[key] = value;
  writeJsonFile(file, json);
}

/**
 * Sets `audit` in the config file (`config`), creating the file when there is none; every other key
 * stays as it is. A failed write never leaves a half-written file. Throws when the file cannot be
 * read or written or is not a JSON object.
 */
export function setAudit(audit: boolean, file = configFile()): void {
  const json = readJsonFile(file) ?? {};
  json.audit = audit;
  writeJsonFile(file, json);
}
