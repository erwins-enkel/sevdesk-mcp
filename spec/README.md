# sevDesk API specification

`sevdesk-openapi.json` is the official sevDesk OpenAPI specification, fetched from
<https://api.sevdesk.de/openapi.yaml>, corrected by `patches.json` and stored with all `$ref`s
resolved. The `search` tool runs the model's code against it.

**© sevDesk, not covered by the MIT licence** of this project.

The file is generated. Do not edit it by hand; refresh it with `bun run update-spec`.

## Corrections

`patches.json` corrects known errors and omissions of the official specification. Each patch says
`why` (what is wrong, with the evidence) and lists `changes`, applied in order to the fetched
document before its `$ref`s are resolved, so a corrected component reaches every place that uses
it:

```json
{
  "why": "saveOrder requires 'orderPos', but its positions property is 'orderPosSave'.",
  "changes": [
    {
      "path": "/components/schemas/saveOrder/required",
      "from": ["order", "orderPos"],
      "to": ["order", "orderPosSave"]
    }
  ]
}
```

- `path` is a JSON Pointer into the fetched document. It must not run through a `$ref`; patch the
  referenced component instead.
- `from` is the exact value sevDesk publishes there; leave it out when nothing may be there yet.
  `to` is the corrected value; leave it out to remove the value. An array entry can only be
  appended (index = length) or removed when it is the last.
- `bun run update-spec` stops without writing when a change no longer applies: the value is not
  its `from` (sevDesk fixed or changed it), something is there although `from` is missing, or the
  path is gone. Check the new upstream value, then update or delete the patch.
- After changing `patches.json`, run `bun run update-spec`; until then `test/patch-spec.test.ts`
  fails because the embedded file lacks the change.

The manual E2E run (`bun run test:e2e`) records the shapes of real answers in
`test/sevdesk-shapes.json`, and once it exists, `bun run test` fails when the patched spec lacks a
recorded field or gives it another type. The run's report lists every difference between the real answers and the
patched spec: a starting point for a new patch, with the recording as its evidence.
