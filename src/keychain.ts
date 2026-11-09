import type { EntryOptions } from '@napi-rs/keyring';
import type { SnippetError } from './sandbox.ts';

// Where the tokens live (decision 4): one keychain entry per profile under this service, with the
// profile name as its account. `setup` writes them the same way.
const SERVICE = 'sevdesk-mcp';

// On Linux only the Secret Service counts. Without it the library would fall back to the kernel
// keyring, which forgets every key on reboot; pinned, a missing Secret Service is an error instead.
const ENTRY_OPTIONS: EntryOptions = { linux: { store: 'secret-service' } };

/**
 * The API token of `profile` from the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service), read anew on every call. The keychain library is loaded only here, so a
 * server that never needs a keychain token never touches it. A missing entry and an unavailable
 * keychain are errors naming the profile.
 */
export async function readToken(
  profile: string,
): Promise<{ ok: true; token: string } | { ok: false; error: SnippetError }> {
  let token: string | null;
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    token = await new AsyncEntry(SERVICE, profile, ENTRY_OPTIONS).getPassword();
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'keychain_unavailable',
        message: `The OS keychain could not be read for profile ${profile}: ${error instanceof Error ? error.message : String(error)}`,
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
