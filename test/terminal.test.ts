import { stripVTControlCharacters } from 'node:util';
import { expect, test } from 'vitest';
import { columns, createOutput, stylesFor, widthOf } from '../src/terminal.ts';

// The terminal edge of `setup` and `config` (decision 19): marks and the gutter always, colour only
// where the stream says it has it (`hasColors()`, which honours NO_COLOR and TERM=dumb).

/** An in-memory stream; `colour` makes it answer `hasColors()` with true, as a colour TTY does. */
function stream(colour = false) {
  let written = '';
  return {
    write: (text: string) => {
      written += text;
      return true;
    },
    ...(colour ? { hasColors: () => true } : {}),
    written: () => written,
  };
}

test('without colour, info and headings sit on the gutter and outcomes carry a mark', () => {
  const out = stream();
  const err = stream();
  const output = createOutput(out, err);

  output.heading('acme  Acme GmbH');
  output.print('Company: Acme GmbH\n\nBookkeeping system: 2.0');
  output.print('');
  output.success('Profile acme is set up.\nRestart your MCP clients.');
  output.fail('No OS keychain is available.\nSet SEVDESK_API_TOKEN instead.');

  expect(out.written()).toBe(
    '  acme  Acme GmbH\n' +
      '  Company: Acme GmbH\n\n  Bookkeeping system: 2.0\n' +
      '\n' +
      '✔ Profile acme is set up.\n  Restart your MCP clients.\n',
  );
  expect(err.written()).toBe('✖ No OS keychain is available.\n  Set SEVDESK_API_TOKEN instead.\n');
  // No escape sequence at all, so NO_COLOR has nothing to turn off.
  expect(stripVTControlCharacters(out.written() + err.written())).toBe(
    out.written() + err.written(),
  );
});

test('with colour, headings are bold, the success mark green and the failure mark red', () => {
  const out = stream(true);
  const err = stream(true);
  const output = createOutput(out, err);

  output.heading('acme');
  output.print('info');
  output.success('done');
  output.fail('failed');

  expect(out.written()).toBe('  \u001b[1macme\u001b[22m\n  info\n\u001b[32m✔\u001b[39m done\n');
  expect(err.written()).toBe('\u001b[31m✖\u001b[39m failed\n');
});

test('colour follows each stream on its own', () => {
  const out = stream(true);
  const err = stream();

  createOutput(out, err).fail('failed');

  expect(err.written()).toBe('✖ failed\n');
});

test('styles leave the text as it is without colour', () => {
  const plain = stylesFor(stream());
  const coloured = stylesFor(stream(true));

  expect(plain.cyan('x') + plain.dim('y') + plain.bold('z')).toBe('xyz');
  expect(coloured.cyan('x')).toBe('\u001b[36mx\u001b[39m');
  expect(coloured.dim('y')).toBe('\u001b[2my\u001b[22m');
});

test('the width counts the characters a reader sees and skips SGR', () => {
  expect(widthOf('manu·fare')).toBe(9);
  expect(widthOf('\u001b[1m✔ ok\u001b[22m')).toBe(4);
  // e and a combining acute accent are one character.
  expect(widthOf('Cafe\u0301')).toBe(4);
});

test('columns pad every column but the last, so no line ends in spaces', () => {
  expect(
    columns([
      ['acme', 'Acme GmbH', 'read and write'],
      ['manufare', 'manu·fare', 'read-only'],
    ]),
  ).toEqual(['acme      Acme GmbH  read and write', 'manufare  manu·fare  read-only']);
  expect(
    columns([
      ['Config file', '/a'],
      ['Audit log', 'on'],
    ]),
  ).toEqual(['Config file  /a', 'Audit log    on']);
  expect(columns([])).toEqual([]);
});
