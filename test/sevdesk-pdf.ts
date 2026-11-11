/**
 * A small PDF as sevDesk writes it (issue #52): its Info dictionary holds the creation date as a
 * literal string right after the name, e.g. `/CreationDate(D:20261110105759Z)`. `creationDate` is
 * that string's content; without it the PDF has no `/CreationDate`. The bytes after the header do
 * not survive a text round trip, as in a real PDF.
 */
export function sevdeskPdf(creationDate?: string): Buffer {
  const info = creationDate === undefined ? '<< >>' : `<</CreationDate(${creationDate})>>`;
  return Buffer.from(
    [
      '%PDF-1.4',
      '%\xe2\xe3\xcf\xd3\x00\x80',
      '1 0 obj << /Type /Catalog >> endobj',
      `2 0 obj ${info} endobj`,
      'trailer << /Root 1 0 R /Info 2 0 R >>',
      '%%EOF',
      '',
    ].join('\n'),
    'latin1',
  );
}

/** sevDesk's getPdf answer for `pdf`, as it sends it: wrapped in `objects`, with `base64Encoded`. */
export function getPdfAnswer(pdf: Buffer) {
  return {
    objects: {
      filename: 'x.pdf',
      mimeType: 'application/pdf',
      base64Encoded: true,
      content: pdf.toString('base64'),
    },
  };
}
