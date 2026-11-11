import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { pdfFreshness } from '../src/pdf-freshness.ts';
import { sevdeskPdf } from './sevdesk-pdf.ts';

// The stale-PDF check of issue #52: the PDF's /CreationDate against the document's `update`,
// compared as instants, flagged for a draft only.

const DRAFT = { update: undefined, draft: true };

/** The `pdfCreated` that `pdfFreshness` reads from a PDF whose /CreationDate is `date`. */
function created(date?: string): string | null {
  return pdfFreshness(sevdeskPdf(date), DRAFT).pdfCreated;
}

describe('pdfCreated', () => {
  test('reads a UTC creation date as sevDesk writes it', () => {
    expect(created('D:20261110105759Z')).toBe('2026-11-10T10:57:59.000Z');
    expect(created("D:20261110105759Z00'00'")).toBe('2026-11-10T10:57:59.000Z');
  });

  test('turns an offset into the same instant', () => {
    for (const date of [
      "D:20261110115759+01'00'",
      "D:20261110115759+01'00",
      'D:20261110115759+0100',
      "D:20261110085759-02'00'",
    ]) {
      expect(created(date), date).toBe('2026-11-10T10:57:59.000Z');
    }
  });

  test('a date it cannot place as an instant gives null', () => {
    for (const date of [
      undefined,
      'D:20261110105759',
      'D:202611101057Z',
      'D:20261310105759Z',
      'D:20260230105759Z',
      'D:20261110245759Z',
      "D:20261110105759+24'00'",
      "D:20261110105759+01'60'",
      '20261110105759Z',
    ]) {
      expect(created(date), String(date)).toBeNull();
    }
    const hex = Buffer.from('%PDF-1.4\n<</CreationDate<443A32303236>>>\n%%EOF\n', 'latin1');
    expect(pdfFreshness(hex, DRAFT).pdfCreated).toBeNull();
  });

  test('the last creation date wins, as an incremental update writes a newer one', () => {
    const pdf = Buffer.concat([sevdeskPdf('D:20261109144400Z'), sevdeskPdf('D:20261110105759Z')]);
    expect(pdfFreshness(pdf, DRAFT).pdfCreated).toBe('2026-11-10T10:57:59.000Z');
  });
});

describe('pdfFreshness', () => {
  const pdf = sevdeskPdf('D:20261110095759Z');

  test("the sha256 is the hex digest of the PDF's bytes", () => {
    expect(pdfFreshness(pdf, DRAFT).sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
  });

  test("a draft's PDF older than its last change is stale; equal or newer is not", () => {
    expect(pdfFreshness(pdf, { update: '2026-11-10T10:57:59+01:00', draft: true })).toEqual({
      sha256: expect.any(String) as string,
      pdfCreated: '2026-11-10T09:57:59.000Z',
      documentUpdated: '2026-11-10T09:57:59.000Z',
    });
    expect(
      pdfFreshness(pdf, { update: '2026-11-10T10:57:58+01:00', draft: true }),
    ).not.toHaveProperty('stale');
    expect(pdfFreshness(pdf, { update: '2026-11-10T10:58:00+01:00', draft: true })).toEqual({
      sha256: expect.any(String) as string,
      pdfCreated: '2026-11-10T09:57:59.000Z',
      documentUpdated: '2026-11-10T09:58:00.000Z',
      stale: true,
    });
  });

  test('a document that is no draft is never stale', () => {
    const freshness = pdfFreshness(pdf, { update: '2026-11-10T16:04:00+01:00', draft: false });
    expect(freshness).not.toHaveProperty('stale');
    expect(freshness.documentUpdated).toBe('2026-11-10T15:04:00.000Z');
  });

  test('without a creation date or a readable update there is no flag', () => {
    const later = { update: '2026-11-10T16:04:00+01:00', draft: true };
    expect(pdfFreshness(sevdeskPdf(), later)).toMatchObject({ pdfCreated: null });
    expect(pdfFreshness(sevdeskPdf(), later)).not.toHaveProperty('stale');
    for (const update of [
      undefined,
      null,
      1794178800,
      '',
      'yesterday',
      '2026-11-10T16:04:00',
      '2026-13-45T16:04:00+01:00',
    ]) {
      const freshness = pdfFreshness(pdf, { update, draft: true });
      expect(freshness.documentUpdated, String(update)).toBeNull();
      expect(freshness, String(update)).not.toHaveProperty('stale');
    }
  });
});
