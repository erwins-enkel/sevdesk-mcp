# Contributing

[Overview](README.md#english) · [Übersicht](README.md#deutsch)

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.4.4 and Node.js ≥ 22.18.

```sh
bun install       # dependencies + git hooks
bun run verify    # everything CI checks
bun run build && node dist/cli.js   # start the server on stdio
bun run build:watch   # rebuild dist/ on every change; a --reload entry runs it from the next call
bun run update-spec   # refresh the embedded sevdesk API specification
bun run test:e2e      # by hand only: Priority A against a real sevdesk account
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (checked by
commitlint), and the pre-push hook runs `bun run verify`. To try a change in a real client, see
[beta testing from a local checkout](docs/en/local-checkout.md).

## End-to-end run against a real account

`bun run test:e2e` runs the offer flow against the account of `SEVDESK_E2E_TOKEN` and skips
without it. It is never part of `bun run test`, `bun run verify` or CI. It writes only contacts
and offers, never invoices. Every offer goes to the contact "MCP Test GmbH" and carries
the tag `mcp-test` and the run id in its head text; the contact and the tag are created on the
first run and kept. With `SEVDESK_E2E_MAIL_TO` set, one offer is mailed to that address and only
there. At the end the run deletes its own offers that are still tagged drafts, through the
confirmation flow, and deletes nothing if any of them is not. Mailed offers are no longer drafts:
the report lists them, with anything else left behind, for deletion by hand. The report also
says whether `getPdf` without `preventSendBy=true` changed an offer's status and what a `getPdf`
without a render returns after a change of the draft (its `pdfCreated`, `documentUpdated` and
`stale`), and it contains neither the token nor the mail address. An interrupted run can leave
offers too; find them by the tag and the run id. The run also records the shape (field names and
types, never values) of the real answers the guides and helpers rely on (one existing invoice is
read for its shape) in `test/sevdesk-shapes.json`, which `bun run test` checks the patched spec and
the mock's answers against (skipped while no run has recorded it); commit it after a run. Its
report lists how the real answers differ from the patched spec.

## Releasing

A pushed tag `vX.Y.Z` publishes the package to npm and creates the GitHub release
([`release.yml`](.github/workflows/release.yml)). 0.x releases are the beta; a merged spec update
ships as a patch release.

1. Open a pull request `chore(release): X.Y.Z` that sets `version` in `package.json`.
2. After the merge, tag the merge commit on `main` and push the tag:
   `git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z`.
3. The workflow stops unless the tag is `v` plus the version in `package.json` and points to a
   commit on `main`. It runs `bun run verify`, packs the package, installs the tarball and checks
   that `sevdesk-mcp --version` prints the version, publishes exactly that tarball to npm (public,
   with provenance, dist-tag `latest`) and creates the GitHub release with generated notes and the
   Claude Desktop extension `sevdesk-mcp.mcpb`. The installation guide links
   `releases/latest/download/sevdesk-mcp.mcpb`, so keep that file name and do not mark releases as
   pre-releases.

If the run fails before "Publish to npm", nothing is published: fix the cause on `main`, delete the
tag (`git push origin :refs/tags/vX.Y.Z`, `git tag -d vX.Y.Z`), tag the fixed commit and push it
again. If only the GitHub release fails, create it by hand with the extension from the run's
artifact `extension` (`gh run download <run id> --name extension`):
`gh release create vX.Y.Z sevdesk-mcp.mcpb --verify-tag --generate-notes --title vX.Y.Z`. A
published npm version cannot be replaced; a broken release is fixed by the next patch release. `publishConfig` in
`package.json` requires provenance, so `npm publish` works only from the workflow.

One-time setup:

- npm: the organisation `erwins-enkel`, and 2FA on the publishing account.
- GitHub: the environment `npm` with the deployment rule "tags `v*` only"; the release job runs in
  it.
- First release only (trusted publishing needs an existing package): a granular access token
  limited to "Only select packages and scopes" → `@erwins-enkel`, with "Read and write (publish
  and stage)", "Bypass two-factor authentication" and an expiry of one day, as the secret
  `NPM_TOKEN` of the environment `npm`. After the first publish, delete the token and the secret
  and set the package's publishing access to "Require two-factor authentication and disallow
  tokens".
- From the second release on, npm trusted publishing (OIDC): in the package's settings on
  npmjs.com, add the trusted publisher GitHub Actions with the repository
  `erwins-enkel/sevdesk-mcp`, the workflow `release.yml` and the environment `npm` (case-sensitive,
  not checked on save). Add it right before tagging the next release: a configuration that has not
  published within 2 days expires. Before that,
  [#66](https://github.com/erwins-enkel/sevdesk-mcp/issues/66) removes the bootstrap token from
  the workflow.

`bun run build:mcpb` builds the extension locally into `build/mcpb/sevdesk-mcp.mcpb`
([`scripts/mcpb.ts`](scripts/mcpb.ts)): the package as published, installed under the bundle's
`node_modules`, with a manifest whose form asks for the API token and read-only. CI uploads it as
the artifact `sevdesk-mcp-mcpb`.

## Documentation

- [`README.md`](README.md) is the landing page: German (`## Deutsch`) first, then the English
  mirror (`## English`) with the same sections. It holds no reference tables.
- The details live in page pairs, `docs/de/*.md` and `docs/en/*.md`. Each page starts with a
  line that links its counterpart in the other language. A user-visible change updates both
  languages in the same pull request.
- German follows the CLI's copy rules: "du", short and factual, gender-inclusive with a colon.
- User docs write the brand as "sevdesk"; code, CLI text and quoted program output keep their own
  spelling.
- `bun run check:docs` (part of `verify`) checks the pairs, that each pair and the two README
  halves have the same headings per level, and that every relative link and anchor resolves.

## sevdesk API specification

[`spec/sevdesk-openapi.json`](spec/README.md) is the official sevdesk OpenAPI specification,
fetched from <https://api.sevdesk.de/openapi.yaml> with all `$ref`s resolved and known errors
corrected by [`spec/patches.json`](spec/README.md#corrections). `search` runs the model's code
against it. **© sevdesk, not covered by the MIT licence.**

## Product documents

The product requirements live in [`docs/prd/PRD-sevdesk.md`](docs/prd/PRD-sevdesk.md) (German),
the foundation decisions in [`docs/decisions/0001-foundation.md`](docs/decisions/0001-foundation.md)
and the product decisions in
[`docs/decisions/0002-product-decisions.md`](docs/decisions/0002-product-decisions.md).
