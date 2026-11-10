import { type Config, configFile, isProfileName } from './config.ts';
import type { SnippetError } from './sandbox.ts';

/**
 * A sevDesk account the server acts for: its profile name, API token and download directory, its
 * company when the config file names one (the environment profile has none), and whether the
 * config file makes it read-only (decision 3; the environment profile never is, only
 * `SEVDESK_READONLY` applies to it).
 */
export interface Profile {
  name: string;
  token: string;
  downloadDir: string;
  company?: string;
  readonly: boolean;
}

/**
 * A profile `execute` can act for: a profile of the config file with its company, its read-only
 * flag and, if set, its download directory (its token is in the OS keychain), or the environment
 * profile with its token.
 */
export interface ReachableProfile {
  name: string;
  company?: string;
  token?: string;
  downloadDir?: string;
  readonly?: boolean;
}

type Outcome<T> = ({ ok: true } & T) | { ok: false; error: SnippetError };

/**
 * The profile from the environment (decision 2): `token` from `SEVDESK_API_TOKEN`, named by
 * `SEVDESK_PROFILE` (default `env`). An empty name counts as unset.
 */
function envProfile(token: string): Outcome<{ profile: ReachableProfile }> {
  const named = process.env.SEVDESK_PROFILE;
  const name = named === undefined || named === '' ? 'env' : named;
  if (!isProfileName(name)) {
    return {
      ok: false,
      error: {
        kind: 'invalid_profile',
        message: `SEVDESK_PROFILE "${name}" is not a valid profile name.`,
        hint: 'Use 1 to 32 characters: a-z, 0-9 and -.',
      },
    };
  }
  return { ok: true, profile: { name, token } };
}

/** The profiles as `name (company)`, comma-separated; a profile without a company by its name. */
export function describeProfiles(profiles: ReachableProfile[]): string {
  return profiles
    .map(({ name, company }) => (company === undefined ? name : `${name} (${company})`))
    .join(', ');
}

/** Why the profile `pinned` (`--profile`) is not among `profiles`, the ones the server has. */
function unknownPin(pinned: string, profiles: ReachableProfile[], fromEnv: boolean): SnippetError {
  const [env] = profiles;
  if (fromEnv && env !== undefined) {
    return {
      kind: 'unknown_profile',
      message: `--profile ${pinned} does not match the profile of SEVDESK_API_TOKEN, ${env.name}.`,
      hint: `If the token belongs to profile ${pinned}, set SEVDESK_PROFILE=${pinned}; otherwise remove SEVDESK_API_TOKEN to use the token from the OS keychain. Then restart the MCP server.`,
    };
  }
  return {
    kind: 'unknown_profile',
    message: `Profile ${pinned} (--profile) is not in the config file ${configFile()}.`,
    hint:
      profiles.length > 0
        ? `Configured profiles: ${describeProfiles(profiles)}. Fix --profile in the MCP client's entry for this server, or add the profile to the config file.`
        : 'Add it under "profiles" in the config file and store its token in the OS keychain, then restart the MCP server.',
  };
}

/**
 * The profiles this server can reach (decision 1). With `SEVDESK_API_TOKEN` only the environment
 * profile, and the keychain is never read; otherwise the profiles of the config file. `pinned`
 * (`--profile`) narrows them to that one. An invalid environment profile name, a pin that is not
 * among them and no profile at all are errors.
 */
export function reachableProfiles(
  config: Config,
  pinned: string | undefined,
): Outcome<{ profiles: ReachableProfile[] }> {
  const token = process.env.SEVDESK_API_TOKEN;
  const fromEnv = token !== undefined && token !== '';
  let profiles: ReachableProfile[];
  if (fromEnv) {
    const env = envProfile(token);
    if (!env.ok) return env;
    profiles = [env.profile];
  } else {
    profiles = config.profiles.map(({ name, company, downloadDir, readonly }) => ({
      name,
      company,
      downloadDir,
      readonly,
    }));
  }
  if (pinned !== undefined) {
    const pin = profiles.find((profile) => profile.name === pinned);
    if (pin === undefined) return { ok: false, error: unknownPin(pinned, profiles, fromEnv) };
    return { ok: true, profiles: [pin] };
  }
  if (profiles.length > 0) return { ok: true, profiles };
  return {
    ok: false,
    error: {
      kind: 'setup_required',
      message: 'No sevDesk account is set up for this server.',
      hint: `Add a profile to the config file ${configFile()} and store its token in the OS keychain, or set SEVDESK_API_TOKEN (a sevDesk API token) in the environment of this MCP server; then restart it.`,
    },
  };
}

/**
 * The profile a call acts for (decision 1): the one `account` names, or the only one there is.
 * With several and no `account` the call fails with `account_required`, listing the profiles with
 * their companies; the server never guesses the tenant.
 */
export function selectProfile(
  profiles: ReachableProfile[],
  account: string | undefined,
): Outcome<{ profile: ReachableProfile }> {
  if (account === undefined) {
    const [only, ...others] = profiles;
    if (only !== undefined && others.length === 0) return { ok: true, profile: only };
    return {
      ok: false,
      error: {
        kind: 'account_required',
        message: `Several sevDesk profiles are set up; pass account as one of: ${describeProfiles(profiles)}.`,
        hint: 'If the conversation does not make clear which company is meant, ask the user.',
      },
    };
  }
  const profile = profiles.find(({ name }) => name === account);
  if (profile !== undefined) return { ok: true, profile };
  return {
    ok: false,
    error: {
      kind: 'unknown_profile',
      message: `Profile ${account} is not available on this server.`,
      hint: `Use one of: ${describeProfiles(profiles)}.`,
    },
  };
}
