import type { EntryOptions } from '@napi-rs/keyring';

/**
 * The in-memory OS keychain every test gets in place of `@napi-rs/keyring` (`test/setup.ts`), so no
 * test reads or writes the real one (foundation decision 7). Tests put tokens into `tokens` by
 * profile name (`setup` stores them there too), find every keychain access in `accesses`, and set
 * `unavailable` to fail like a system without a keychain. `test/setup.ts` empties it before each
 * test.
 */
export const fakeKeychain = {
  tokens: new Map<string, string>(),
  accesses: [] as { service: string; account: string; store: string | undefined }[],
  unavailable: false,
};

/** The part of `@napi-rs/keyring`'s `AsyncEntry` the server uses. */
export class AsyncEntry {
  readonly #account: string;

  constructor(service: string, account: string, options?: EntryOptions | null) {
    fakeKeychain.accesses.push({ service, account, store: options?.linux?.store });
    if (fakeKeychain.unavailable) {
      throw new Error('Platform secure storage failure: no Secret Service is running');
    }
    this.#account = account;
  }

  // Called by src/keychain.ts through the `vi.mock` of `@napi-rs/keyring`, which fallow cannot see.
  // fallow-ignore-next-line unused-class-member
  getPassword(): Promise<string | null> {
    return Promise.resolve(fakeKeychain.tokens.get(this.#account) ?? null);
  }

  // Called by src/keychain.ts through the `vi.mock` of `@napi-rs/keyring`, which fallow cannot see.
  // fallow-ignore-next-line unused-class-member
  setPassword(password: string): Promise<void> {
    fakeKeychain.tokens.set(this.#account, password);
    return Promise.resolve();
  }
}
