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

// Menus: arrow keys move the mark, Enter or a number picks, Esc or q goes back, Ctrl+C cancels.
const ITEMS = ['Toggle read-only', 'Check the connection', 'Back'];

test('a menu is plain text with the first item marked, and Enter picks the marked item', async () => {
  const { input, prompter, shown } = terminal();

  const choice = prompter.choose('Profile acme:', ITEMS);
  input.write('\r');

  expect(await choice).toBe(0);
  expect(shown()).toBe(
    'Profile acme:\n> 1) Toggle read-only\n  2) Check the connection\n  3) Back\n',
  );
});

test('arrow keys move the mark, wrapping around, and redraw the menu without colour', async () => {
  const { input, prompter, shown } = terminal();

  const choice = prompter.choose('Profile acme:', ITEMS);
  // Down, down, down (back to the first), up (to the last), Enter.
  input.write('\u001b[B\u001b[B\u001b[B\u001b[A\r');

  expect(await choice).toBe(2);
  expect(shown()).toContain('\u001b[3F\u001b[J  1) Toggle read-only\n> 2) Check the connection\n');
  expect(shown().endsWith('  1) Toggle read-only\n  2) Check the connection\n> 3) Back\n')).toBe(
    true,
  );
  // No colour or other text attribute (SGR), so NO_COLOR has nothing to turn off.
  const sequences = shown().split('\u001b[').slice(1);
  expect(sequences.filter((sequence) => /^[0-9;]*m/.test(sequence))).toEqual([]);
});

test('a number picks its item at once, and the next question starts empty', async () => {
  const { input, prompter } = terminal();

  const choice = prompter.choose('Profile acme:', ITEMS);
  input.write('2');
  expect(await choice).toBe(1);

  const answer = prompter.ask('Download directory: ');
  input.write('/srv\r');
  expect(await answer).toBe('/srv');
});

test('a number beyond the menu is ignored', async () => {
  const { input, prompter } = terminal();

  const choice = prompter.choose('Profile acme:', ITEMS);
  input.write('7\u001b[B\r');

  expect(await choice).toBe(1);
});

test.each([
  ['q', 'q'],
  ['Esc', '\u001b'],
])('%s goes back', async (_key, keys) => {
  const { input, prompter } = terminal();

  const choice = prompter.choose('Profile acme:', ITEMS);
  input.write(keys);

  expect(await choice).toBe('back');
});

test('Ctrl+C cancels the menu and every later question', async () => {
  const { input, prompter } = terminal();

  const choice = prompter.choose('Profile acme:', ITEMS);
  input.write('\u0003');

  expect(await choice).toBeUndefined();
  expect(await prompter.choose('Main menu', ITEMS)).toBeUndefined();
  expect(await prompter.ask('Download directory: ')).toBeUndefined();
});
