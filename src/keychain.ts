import type { AsyncEntry, EntryOptions } from '@napi-rs/keyring';
import type { SnippetError } from './sandbox.ts';

// Where the tokens live (decision 4): one keychain entry per profile under this service, with the
// profile name as its account. `setup` writes them the same way.
export const SERVICE = 'sevdesk-mcp';

// On Linux only the Secret Service counts. Without it the library would fall back to the kernel
// keyring, which forgets every key on reboot; pinned, a missing Secret Service is an error instead.
const ENTRY_OPTIONS: EntryOptions = { linux: { store: 'secret-service' } };

/**
 * The keychain entry of `profile`. The keychain library is loaded only here, so a server that never
 * needs a keychain token never touches it. Rejects when the library cannot open the keychain.
 */
async function entry(profile: string): Promise<AsyncEntry> {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return new AsyncEntry(SERVICE, profile, ENTRY_OPTIONS);
}

/** The message of a keychain failure, never anything else the error carries. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The API token of `profile` from the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service), read anew on every call. A missing entry and an unavailable keychain are
 * errors naming the profile.
 */
export async function readToken(
  profile: string,
): Promise<{ ok: true; token: string } | { ok: false; error: SnippetError }> {
  let token: string | null;
  try {
    token = await (await entry(profile)).getPassword();
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'keychain_unavailable',
        message: `The OS keychain could not be read for profile ${profile}: ${reasonOf(error)}`,
        hint: 'Unlock the keychain and try again. Where there is none (headless Linux, WSL, Docker), set SEVDESK_API_TOKEN for this MCP server instead.',
      },
    };
  }
  if (token === null || token === '') {
    return {
      ok: false,
      error: {
        kind: 'keychain_entry_missing',
        message: `The OS keychain holds no sevDesk API token for profile ${profile}.`,
        hint: `Store it under service "${SERVICE}", account "${profile}", or set SEVDESK_API_TOKEN for this MCP server.`,
      },
    };
  }
  return { ok: true, token };
}

/**
 * Whether the OS keychain can be used for `profile`: undefined when its entry can be read (it need
 * not exist), otherwise why not. `setup` asks this before it asks for a token.
 */
export async function probeKeychain(profile: string): Promise<string | undefined> {
  try {
    await (await entry(profile)).getPassword();
    return undefined;
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * Stores `token` as the API token of `profile` in the OS keychain, replacing an older one: undefined
 * when it is stored, otherwise why not.
 */
export async function storeToken(profile: string, token: string): Promise<string | undefined> {
  try {
    await (await entry(profile)).setPassword(token);
    return undefined;
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * Deletes the API token of `profile` from the OS keychain: undefined when the keychain holds none
 * any more (deleted, or there was none), otherwise why not.
 */
export async function deleteToken(profile: string): Promise<string | undefined> {
  try {
    await (await entry(profile)).deletePassword();
    return undefined;
  } catch (error) {
    return reasonOf(error);
  }
}
