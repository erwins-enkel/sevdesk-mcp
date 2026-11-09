import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { expect, test } from 'vitest';
import { binaryFileName, fileStem, saveFile } from '../src/downloads.ts';
import { HostError } from '../src/sandbox.ts';

// The building blocks of the download directory: safe file names and complete-or-nothing writes.
// Every test has its own temporary home (test/setup.ts), so these directories lie inside it.

const live = { signal: new AbortController().signal };

test.each([
  ['AN-1042', 'AN-1042'],
  ['RE 2026/001', 'RE_2026_001'],
  ['../../outside', '_.._outside'],
  ['a/b\\c', 'a_b_c'],
  ['C:\\Windows\\x', 'C__Windows_x'],
  ['/etc/passwd', '_etc_passwd'],
  ['.hidden.', 'hidden'],
  ['Gutschrift-Müller', 'Gutschrift-Müller'],
  ['tab\tnew\nline\u0000', 'tab_new_line_'],
])('fileStem(%j) is %j', (text, stem) => {
  expect(fileStem(text)).toBe(stem);
});

test.each(['', '.', '..', '...', 'CON', 'nul', 'com1', 'LPT9.x'])(
  'fileStem(%j) leaves nothing usable',
  (text) => {
    expect(fileStem(text)).toBeUndefined();
  },
);

test('a non-JSON response is named after its path and content type', () => {
  expect(binaryFileName('/Export/datevCSV', 'text/csv; charset=utf-8')).toBe('Export-datevCSV.csv');
  expect(binaryFileName('/Export/invoiceZip', 'Application/ZIP')).toBe('Export-invoiceZip.zip');
  expect(binaryFileName('/Invoice/1/getXml', 'application/xml')).toBe('Invoice-1-getXml.xml');
  expect(binaryFileName('/Report/x', 'application/octet-stream')).toBe('Report-x.bin');
  expect(binaryFileName('/Report/x', 'constructor')).toBe('Report-x.bin');
  expect(binaryFileName('/CON', 'text/plain')).toBe('download.txt');
});

test('saveFile replaces a file of the same name, or keeps it and picks the next free name', async () => {
  const dir = join(homedir(), 'Downloads', 'sevdesk', 'env');
  const bytes = (text: string) => new TextEncoder().encode(text);

  const first = await saveFile(dir, 'AN-1.pdf', bytes('one'), { replace: true, ...live });
  const replaced = await saveFile(dir, 'AN-1.pdf', bytes('two!'), { replace: true, ...live });
  const kept = [
    await saveFile(dir, 'x.csv', bytes('a'), { replace: false, ...live }),
    await saveFile(dir, 'x.csv', bytes('bb'), { replace: false, ...live }),
    await saveFile(dir, 'x.csv', bytes('ccc'), { replace: false, ...live }),
  ];

  expect(first).toEqual({ path: join(dir, 'AN-1.pdf'), bytes: 3 });
  expect(replaced).toEqual({ path: join(dir, 'AN-1.pdf'), bytes: 4 });
  expect(readFileSync(replaced.path, 'utf8')).toBe('two!');
  expect(kept).toEqual([
    { path: join(dir, 'x.csv'), bytes: 1 },
    { path: join(dir, 'x-2.csv'), bytes: 2 },
    { path: join(dir, 'x-3.csv'), bytes: 3 },
  ]);
  expect(kept.map(({ path }) => readFileSync(path, 'utf8'))).toEqual(['a', 'bb', 'ccc']);
  expect(readdirSync(dir).sort()).toEqual(['AN-1.pdf', 'x-2.csv', 'x-3.csv', 'x.csv']);
});

test('a stream that fails midway leaves nothing behind and keeps the earlier file', async () => {
  const dir = join(homedir(), 'Downloads', 'sevdesk', 'env');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AN-1.pdf'), 'previous');
  const failing = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new Error('connection reset'));
      },
    });

  const errors: unknown[] = [];
  for (const replace of [true, false]) {
    await saveFile(dir, 'AN-1.pdf', failing(), { replace, ...live }).catch((error: unknown) => {
      errors.push(error);
    });
  }

  expect(errors).toHaveLength(2);
  for (const error of errors) {
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({
      error: {
        kind: 'download_error',
        message: `AN-1.pdf could not be saved in ${dir}.`,
        hint: expect.stringContaining('downloadDir') as string,
      },
    });
  }
  expect(readdirSync(dir)).toEqual(['AN-1.pdf']);
  expect(readFileSync(join(dir, 'AN-1.pdf'), 'utf8')).toBe('previous');
});

test('an aborted write and a directory that cannot be created are download errors', async () => {
  const file = join(homedir(), 'not-a-directory');
  writeFileSync(file, 'x');
  const aborted = AbortSignal.abort();
  const dir = join(homedir(), 'Downloads');

  const blocked = await saveFile(join(file, 'sub'), 'a.pdf', new Uint8Array([1]), {
    replace: true,
    ...live,
  }).catch((error: unknown) => error);
  const stopped = await saveFile(dir, 'a.pdf', new Uint8Array([1]), {
    replace: true,
    signal: aborted,
  }).catch((error: unknown) => error);

  expect(blocked).toMatchObject({ error: { kind: 'download_error' } });
  expect((blocked as HostError).message).toMatch(/^a\.pdf could not be saved in .+ \(E[A-Z]+\)\.$/);
  expect(stopped).toMatchObject({ error: { kind: 'download_error' } });
  expect(readdirSync(dir)).toEqual([]);
  expect(readdirSync(dirname(file))).toContain('not-a-directory');
});
