import type { SnippetError } from './sandbox.ts';

/** A sevDesk account the server acts for: its profile name and API token. */
export interface Profile {
  name: string;
  token: string;
}

// Profile names (decision 18); a name later becomes a directory name.
const PROFILE_NAME = /^[a-z0-9-]{1,32}$/;

/**
 * The profile from the environment (decision 2): `SEVDESK_API_TOKEN`, named by `SEVDESK_PROFILE`
 * (default `env`). An empty variable counts as unset. Without a token there is no profile, and
 * the error says how to set one up.
 */
export function resolveEnvProfile():
  { ok: true; profile: Profile } | { ok: false; error: SnippetError } {
  const token = process.env.SEVDESK_API_TOKEN;
  if (token === undefined || token === '') {
    return {
      ok: false,
      error: {
        kind: 'setup_required',
        message: 'No sevDesk account is set up for this server.',
        hint: 'Set SEVDESK_API_TOKEN (a sevDesk API token) in the environment of this MCP server and restart it.',
      },
    };
  }
  const named = process.env.SEVDESK_PROFILE;
  const name = named === undefined || named === '' ? 'env' : named;
  if (!PROFILE_NAME.test(name)) {
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
