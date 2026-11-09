/**
 * A `fetch` that sends calls for `baseUrl` to the mock sevDesk at `origin`
 * (`http://127.0.0.1:<port>`) and throws for any other URL, so a test never reaches sevDesk while
 * the code under test keeps its HTTPS base URL. `startMockSevdesk` stubs the test's own `fetch` with
 * it, and a spawned server gets it through its `--import` module (`serverImport`). It imports
 * nothing, so a spawned server can load it outside vitest.
 */
export function redirectFetch(baseUrl: string, origin: string, realFetch: typeof fetch) {
  const base = new URL(baseUrl);
  return (url: string, init?: RequestInit) => {
    if (!url.startsWith(`${baseUrl}/`)) {
      throw new Error(`The test fetch reaches only the mock sevDesk, not ${url}`);
    }
    return realFetch(`${origin}${url.slice(base.origin.length)}`, init);
  };
}
