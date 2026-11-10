import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { createPrompter, type Prompter } from '../src/prompt.ts';

// The terminal prompter on in-memory streams: what the user types goes into `input`, everything the
// prompter shows lands in `shown`.

const opened: Prompter[] = [];

afterEach(() => {
  for (const prompter of opened.splice(0)) prompter.close();
});

function terminal(columns?: number) {
  const input = new PassThrough();
  let shown = '';
  const output = Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        shown += chunk.toString();
        done();
      },
    }),
    { columns },
  );
  const prompter = createPrompter(input, output);
  opened.push(prompter);
  return { input, prompter, shown: () => shown };
}

test('a hidden answer is returned but never shown', async () => {
  const { input, prompter, shown } = terminal();

  const answer = prompter.ask('Token: ', { hidden: true });
  input.write('s3cret-token\r');

  expect(await answer).toBe('s3cret-token');
  expect(shown()).toBe('Token: \n');
});

test('a visible answer is shown as it is typed', async () => {
  const { input, prompter, shown } = terminal();

  const answer = prompter.ask('Profile name: ');
  input.write('acme\n');

  expect(await answer).toBe('acme');
  expect(shown()).toContain('Profile name: ');
  expect(shown()).toContain('acme');
});

test("a visible answer longer than the terminal's width is redrawn across its rows", async () => {
  const { input, prompter, shown } = terminal(10);

  const answer = prompter.ask('Name: ');
  // 6 + 8 characters wrap onto a second row of 10. Each backspace redraws the line; the second
  // starts from the row the first one ended on, the second, so it moves up one row first.
  input.write('abcdefgh\u007f\u007f\n');

  expect(await answer).toBe('abcdef');
  expect(shown()).toContain('\u001b[1A');
});

test('a hidden answer never comes back through the history of a later question', async () => {
  const { input, prompter, shown } = terminal();

  const token = prompter.ask('Token: ', { hidden: true });
  input.write('s3cret-token\r');
  expect(await token).toBe('s3cret-token');
  const next = prompter.ask('Read-only? ');
  // Up arrow, then Enter: readline would recall the previous line from its history.
  input.write('\u001b[A\r');

  expect(await next).toBe('');
  expect(shown()).not.toContain('s3cret-token');
});

test('Ctrl+C cancels the question and every later one', async () => {
  const { input, prompter } = terminal();

  const answer = prompter.ask('Token: ', { hidden: true });
  input.write('half\u0003');

  expect(await answer).toBeUndefined();
  expect(await prompter.ask('Read-only? ')).toBeUndefined();
});

test('the end of the input cancels the question', async () => {
  const { input, prompter } = terminal();

  const answer = prompter.ask('Profile name: ');
  input.end();

  expect(await answer).toBeUndefined();
});
