import { stripVTControlCharacters } from 'node:util';
import type { SetupOutput } from './setup.ts';

// How the interactive commands (`setup`, `config`) look on a terminal (decision 19): plain text in
// which a mark and the words carry every status, and colour only where the stream has it.
// `hasColors()` already answers false for NO_COLOR, FORCE_COLOR=0, NODE_DISABLE_COLORS, TERM=dumb
// and anything that is not a TTY, so nothing here reads the environment.

/** The marks before a line; everything after a mark starts in the third column, the gutter's end. */
export const MARKS = { ask: '?', pointer: '❯', success: '✔', picked: '›', fail: '✖' } as const;

// The indent of a line without a mark: as wide as a mark and its space.
const GUTTER = '  ';

/** A stream the commands write to; a TTY says through `hasColors()` whether it shows colour. */
export interface TextStream {
  write(text: string): unknown;
  hasColors?: () => boolean;
}

type Paint = (text: string) => string;

/** The text attributes the commands use, each with its SGR on and off codes. */
const SGR = {
  bold: [1, 22],
  dim: [2, 22],
  cyan: [36, 39],
  green: [32, 39],
  red: [31, 39],
} as const;

export type Styles = Record<keyof typeof SGR, Paint>;

/** The styles for `stream`: SGR sequences when it shows colour, the text as it is otherwise. */
export function stylesFor(stream: TextStream): Styles {
  const colour = typeof stream.hasColors === 'function' && stream.hasColors();
  const paint = ([on, off]: readonly [number, number]): Paint =>
    colour ? (text) => `\x1b[${String(on)}m${text}\x1b[${String(off)}m` : (text) => text;
  return {
    bold: paint(SGR.bold),
    dim: paint(SGR.dim),
    cyan: paint(SGR.cyan),
    green: paint(SGR.green),
    red: paint(SGR.red),
  };
}

// Splits text into the characters a reader sees (grapheme clusters).
const graphemes = new Intl.Segmenter();

/** The width of `text` on a terminal, in characters without SGR; wide characters count as one. */
export function widthOf(text: string): number {
  return [...graphemes.segment(stripVTControlCharacters(text))].length;
}

/**
 * The lines of `text` laid out on the gutter, each painted with `paint`: the first after `mark` and a
 * space when there is a mark, every other one indented by the gutter. An empty line stays empty.
 */
function block(text: string, paint: Paint, mark?: string): string {
  return text
    .split('\n')
    .map((line, at) => {
      if (at === 0 && mark !== undefined) return `${mark} ${paint(line)}`;
      return line === '' ? '' : GUTTER + paint(line);
    })
    .join('\n');
}

/**
 * Where `setup` and `config` write on a terminal: info and headings (bold) indented by the gutter on
 * `out`, successes after `✔` on `out`, failures after `✖` on `err`. Colour only where the stream has
 * it.
 */
export function createOutput(out: TextStream, err: TextStream): SetupOutput {
  const style = stylesFor(out);
  const errStyle = stylesFor(err);
  const plain: Paint = (text) => text;
  return {
    print: (text) => {
      out.write(`${block(text, plain)}\n`);
    },
    heading: (text) => {
      out.write(`${block(text, style.bold)}\n`);
    },
    success: (text) => {
      out.write(`${block(text, plain, style.green(MARKS.success))}\n`);
    },
    fail: (text) => {
      err.write(`${block(text, plain, errStyle.red(MARKS.fail))}\n`);
    },
  };
}

/**
 * `rows` as aligned text lines: every column but the last padded to its widest cell and two spaces,
 * so no line ends in spaces.
 */
export function columns(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, at) => {
      widths[at] = Math.max(widths[at] ?? 0, widthOf(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, at) =>
        at === row.length - 1 ? cell : cell + ' '.repeat((widths[at] ?? 0) - widthOf(cell) + 2),
      )
      .join(''),
  );
}
