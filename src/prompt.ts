import type { Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { type Readable, Writable } from 'node:stream';
import { MARKS, stylesFor, widthOf } from './terminal.ts';

/** The outcome of a menu: the index of the chosen item, `back` (Esc or q), or undefined (Ctrl+C). */
export type Choice = number | 'back' | undefined;

// What the named keys do in a menu. A lone Esc comes as meta + escape.
const MENU_KEYS = new Map<string, 'up' | 'down' | 'pick' | 'back'>([
  ['up', 'up'],
  ['down', 'down'],
  ['return', 'pick'],
  ['enter', 'pick'],
  ['escape', 'back'],
  ['q', 'back'],
]);

/** What a named key does in a menu; Ctrl combinations, Ctrl+C among them, do nothing here. */
function namedKey(key: Key | undefined) {
  return key?.ctrl === true ? undefined : MENU_KEYS.get(key?.name ?? '');
}

/** The item a typed number 1 to 9 picks in a menu of `count` items, if any. */
function numberKey(text: string | undefined, count: number): number | undefined {
  const number = Number(text);
  return Number.isInteger(number) && number >= 1 && number <= Math.min(count, 9)
    ? number - 1
    : undefined;
}

/**
 * What a key does in a menu of `count` items whose item `marked` is marked: move the mark `up` or
 * `down`, pick an item (Enter, or its number 1 to 9), go `back` (Esc or q), or nothing (undefined).
 */
function keyChoice(
  text: string | undefined,
  key: Key | undefined,
  count: number,
  marked: number,
): Choice | 'up' | 'down' {
  const action = namedKey(key);
  if (action === 'pick') return marked;
  return action ?? numberKey(text, count);
}

/**
 * The rows the whole lines of `text` take on a terminal `columns` wide, each wrapping on its own; an
 * unknown width counts one row per line.
 */
function rowsOf(text: string, columns: number | undefined): number {
  const lines = text.split('\n').slice(0, -1);
  if (columns === undefined || columns <= 0) return lines.length;
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(widthOf(line) / columns)), 0);
}

// Moves to the start of the line `rows` rows up and clears from there to the end of the screen.
const erase = (rows: number) => `\x1b[${String(rows)}F\x1b[J`;

/** Asks the user questions on a terminal, one line per answer. */
export interface Prompter {
  /**
   * Shows `question` after a `?` and resolves to the line the user enters, without its line break.
   * With `hidden`, nothing the user types is shown. Resolves to undefined once the user cancels
   * (Ctrl+C) or the input ends (Ctrl+D), for this question and every later one.
   */
  ask(question: string, options?: { hidden?: boolean }): Promise<string | undefined>;
  /**
   * Shows `title` after a `?` and `items` as a menu, the first item marked, with `hint` below them,
   * and resolves to the item the user picks: arrow keys move the mark and Enter picks it, the numbers
   * 1 to 9 pick that item at once, Esc or q resolve to `back`. Resolves to undefined once the user
   * cancels (Ctrl+C) or the input ends, as `ask` does. A pick leaves of the menu its empty line and
   * `✔ title › item`; going back or cancelling leaves nothing of it.
   */
  choose(title: string, items: string[], options?: { hint?: string }): Promise<Choice>;
  /** Releases the terminal; call it once the questions are done. */
  close(): void;
}

/**
 * A prompter on `input` and `output` with Node's readline in terminal mode (raw input on a TTY),
 * without a line history. Hidden input routes readline's echo through a muted stream while the line
 * is typed: the question is written before the stream is muted, a line break after, and no typed
 * character reaches `output`. Marks and the gutter are plain text; colour comes only when `output`
 * has it (`hasColors()`, decision 19).
 */
export function createPrompter(input: Readable, output: Writable): Prompter {
  const style = stylesFor(output);
  const width = () => (output as { columns?: number }).columns;
  let muted = false;
  const echo = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  // readline lays out the line by the terminal's width, which it reads from its output.
  Object.defineProperty(echo, 'columns', { get: width });
  // No history: Up at a later question would otherwise bring back a hidden answer, shown in clear.
  const lines = createInterface({ input, output: echo, terminal: true, historySize: 0 });
  let cancelled = false;
  let pending: AbortController | undefined;
  const cancel = () => {
    cancelled = true;
    pending?.abort();
  };
  lines.on('SIGINT', cancel);
  lines.on('close', cancel);

  /** `text` after the `?` that marks a question or a menu title. */
  const question = (text: string) => `${style.cyan(MARKS.ask)} ${text}`;

  /**
   * The menu as whole lines: an empty line, the title, the items (the marked one after `❯`, the
   * others on the gutter) and the hint. The mark is text, so the menu never depends on colour.
   */
  const render = (title: string, items: string[], marked: number, hint?: string) => {
    const lines = [
      '',
      question(style.bold(title)),
      ...items.map((item, at) => {
        const line = `${String(at + 1)}) ${item}`;
        return at === marked ? style.cyan(`${MARKS.pointer} ${line}`) : `  ${line}`;
      }),
      ...(hint === undefined ? [] : [`  ${style.dim(hint)}`]),
    ];
    return `${lines.join('\n')}\n`;
  };

  /** The line a picked menu leaves behind: `✔ title › item`. */
  const picked = (title: string, item: string) =>
    `${style.green(MARKS.success)} ${title} ${style.dim(MARKS.picked)} ${style.cyan(item)}\n`;

  return {
    async ask(text, { hidden = false } = {}) {
      if (cancelled) return undefined;
      pending = new AbortController();
      const shown = question(text);
      if (hidden) {
        output.write(shown);
        muted = true;
      }
      try {
        return await lines.question(hidden ? '' : shown, { signal: pending.signal });
      } catch {
        // The question was aborted by Ctrl+C or the end of the input.
        return undefined;
      } finally {
        pending = undefined;
        if (hidden) {
          muted = false;
          output.write('\n');
        }
      }
    },
    async choose(title, items, { hint } = {}) {
      if (cancelled) return undefined;
      const controller = new AbortController();
      pending = controller;
      let marked = 0;
      let drawn = render(title, items, marked, hint);
      let onKey: ((text: string | undefined, key: Key | undefined) => void) | undefined;
      output.write(drawn);
      // readline still reads the keys into its line; muted, nothing it echoes reaches `output`.
      muted = true;
      let choice: Choice;
      try {
        choice = await new Promise<Choice>((resolve) => {
          controller.signal.addEventListener('abort', () => {
            resolve(undefined);
          });
          onKey = (text, key) => {
            const action = keyChoice(text, key, items.length, marked);
            if (action === 'up' || action === 'down') {
              marked = (marked + (action === 'up' ? items.length - 1 : 1)) % items.length;
              // Back to the menu's first row, clear to the end, draw the menu again.
              const previous = drawn;
              drawn = render(title, items, marked, hint);
              output.write(erase(rowsOf(previous, width())) + drawn);
            } else if (action !== undefined) {
              resolve(action);
            }
          };
          input.on('keypress', onKey);
        });
      } finally {
        if (onKey !== undefined) input.off('keypress', onKey);
        pending = undefined;
        // Drop what readline collected in its line meanwhile, so the next question starts empty.
        lines.write(null, { ctrl: true, name: 'e' });
        lines.write(null, { ctrl: true, name: 'u' });
        muted = false;
      }
      // The menu gives way to its outcome: after its empty line the picked item, or nothing at all
      // after back or cancel.
      const item = typeof choice === 'number' ? items[choice] : undefined;
      const rows = rowsOf(drawn, width());
      output.write(item === undefined ? erase(rows) : erase(rows - 1) + picked(title, item));
      return choice;
    },
    close() {
      lines.close();
    },
  };
}
