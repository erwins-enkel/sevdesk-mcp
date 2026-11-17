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
