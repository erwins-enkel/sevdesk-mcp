# Files: PDFs and exports

[Deutsch](../de/dateien.md) · **English** · [Overview](../../README.md#english)

PDFs and exports never pass through the assistant's context: the server saves them in the
profile's download directory and returns only the path. That directory is
`~/Downloads/sevdesk/<profile>/` unless the profile sets
[`downloadDir`](configuration.md); the profile of `SEVDESK_API_TOKEN` is named by
`SEVDESK_PROFILE` (default `env`).

- `sevdesk.savePdf(type, id)` saves the PDF of an order (offer), invoice or credit note as
  `<document number>.pdf`, or as `<Type>-<id>.pdf` when it has no number, and replaces an older
  copy of the same name. It always asks sevdesk not to mark the document as sent
  (`preventSendBy=true`). sevdesk keeps the PDF it rendered last, so `savePdf` renders a draft
  again first (`POST /{Type}/{id}/render` with `forceReload`, listed in `writes` and the
  [audit log](safety.md#audit-log)): its PDF always shows the draft as it is now. That costs 3
  calls. Any other document gets the PDF sevdesk stored, the one it sent, in 2 calls. It returns
  the path and file name with the PDF's `bytes`, `sha256`, `pdfCreated` (its `/CreationDate`) and
  `documentUpdated` (the document's `update`), both in UTC.
- A `getPdf` of an order, invoice or credit note through `sevdesk.request` (with
  `preventSendBy=true`) is saved as a new file named after the path, e.g. `Order-7-getPdf.pdf`,
  whether sevdesk answers JSON or, with `download=true`, the PDF itself. It reads the document
  first (2 calls) and returns the same fields. Changes through the API do not update the PDF
  sevdesk stored, and this call returns that stored PDF; only `savePdf` renders a draft again.
- When a draft's PDF predates the draft's last change, the result adds `stale: true` and a hint,
  and the `execute` result's `notes` name the file. The file is saved all the same. Documents
  that are no drafts are never flagged: a status change such as sending moves `update` too.
- Any other response that is not JSON, such as a CSV export, is saved as a new file named after the
  request path, e.g. `Export-datevCSV.csv`. An existing file is kept; the new one gets `-2`, `-3`,
  … appended.
