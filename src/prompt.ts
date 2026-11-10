import type { Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { type Readable, Writable } from 'node:stream';

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

/** Asks the user questions on a terminal, one line per answer. */
export interface Prompter {
  /**
   * Shows `question` and resolves to the line the user enters, without its line break. With
   * `hidden`, nothing the user types is shown. Resolves to undefined once the user cancels (Ctrl+C)
   * or the input ends (Ctrl+D), for this question and every later one.
   */
  ask(question: string, options?: { hidden?: boolean }): Promise<string | undefined>;
  /**
   * Shows `title` and `items` as a menu, the first item marked, and resolves to the item the user
   * picks: arrow keys move the mark and Enter picks it, the numbers 1 to 9 pick that item at once,
   * Esc or q resolve to `back`. Resolves to undefined once the user cancels (Ctrl+C) or the input
   * ends, as `ask` does.
   */
  choose(title: string, items: string[]): Promise<Choice>;
  /** Releases the terminal; call it once the questions are done. */
  close(): void;
}

/**
 * A prompter on `input` and `output` with Node's readline in terminal mode (raw input on a TTY),
 * without a line history. Hidden input routes readline's echo through a muted stream while the line
 * is typed: the question is written before the stream is muted, a line break after, and no typed
 * character reaches `output`.
 */
export function createPrompter(input: Readable, output: Writable): Prompter {
  let muted = false;
  const echo = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  // readline lays out the line by the terminal's width, which it reads from its output.
  Object.defineProperty(echo, 'columns', { get: () => (output as { columns?: number }).columns });
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

  /** The menu lines: the marked item with `>`, plain text so it never depends on colour. */
  const render = (items: string[], marked: number) =>
    items.map((item, at) => `${at === marked ? '>' : ' '} ${String(at + 1)}) ${item}\n`).join('');

  return {
    async ask(question, { hidden = false } = {}) {
      if (cancelled) return undefined;
      pending = new AbortController();
      if (hidden) {
        output.write(question);
        muted = true;
      }
      try {
        return await lines.question(hidden ? '' : question, { signal: pending.signal });
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
    async choose(title, items) {
      if (cancelled) return undefined;
      const controller = new AbortController();
      pending = controller;
      let marked = 0;
      let onKey: ((text: string | undefined, key: Key | undefined) => void) | undefined;
      output.write(`${title}\n${render(items, marked)}`);
      // readline still reads the keys into its line; muted, nothing it echoes reaches `output`.
      muted = true;
      try {
        return await new Promise<Choice>((resolve) => {
          controller.signal.addEventListener('abort', () => {
            resolve(undefined);
          });
          onKey = (text, key) => {
            const picked = keyChoice(text, key, items.length, marked);
            if (picked === 'up' || picked === 'down') {
              marked = (marked + (picked === 'up' ? items.length - 1 : 1)) % items.length;
              // Back to the first menu line, clear to the end, draw the menu again.
              output.write(`\x1b[${String(items.length)}F\x1b[J${render(items, marked)}`);
            } else if (picked !== undefined) {
              resolve(picked);
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
    },
    close() {
      lines.close();
    },
  };
}
