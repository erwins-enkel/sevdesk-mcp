import { createInterface } from 'node:readline/promises';
import { type Readable, Writable } from 'node:stream';

/** Asks the user questions on a terminal, one line per answer. */
export interface Prompter {
  /**
   * Shows `question` and resolves to the line the user enters, without its line break. With
   * `hidden`, nothing the user types is shown. Resolves to undefined once the user cancels (Ctrl+C)
   * or the input ends (Ctrl+D), for this question and every later one.
   */
  ask(question: string, options?: { hidden?: boolean }): Promise<string | undefined>;
  /** Releases the terminal; call it once the questions are done. */
  close(): void;
}

/**
 * A prompter on `input` and `output` with Node's readline in terminal mode (raw input on a TTY).
 * Hidden input routes readline's echo through a muted stream while the line is typed: the question
 * is written before the stream is muted, a line break after, and no typed character reaches
 * `output`.
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
  const lines = createInterface({ input, output: echo, terminal: true });
  let cancelled = false;
  let pending: AbortController | undefined;
  const cancel = () => {
    cancelled = true;
    pending?.abort();
  };
  lines.on('SIGINT', cancel);
  lines.on('close', cancel);

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
    close() {
      lines.close();
    },
  };
}
