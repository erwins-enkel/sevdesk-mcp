import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { createPrompter, type Prompter } from '../src/prompt.ts';

// The terminal prompter on in-memory streams: what the user types goes into `input`, everything the
// prompter shows lands in `shown`. A stream without `hasColors()` stands for NO_COLOR, TERM=dumb or a
// terminal without colour.

const opened: Prompter[] = [];

afterEach(() => {
  for (const prompter of opened.splice(0)) prompter.close();
});

function terminal(columns?: number, colour = false) {
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
    colour ? { hasColors: () => true } : {},
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
  expect(shown()).toBe('? Token: \n');
});

test('a visible answer is shown as it is typed', async () => {
  const { input, prompter, shown } = terminal();

  const answer = prompter.ask('Profile name: ');
  input.write('acme\n');

  expect(await answer).toBe('acme');
  expect(shown()).toContain('? Profile name: ');
  expect(shown()).toContain('acme');
});

test("a visible answer longer than the terminal's width is redrawn across its rows", async () => {
  const { input, prompter, shown } = terminal(10);

  const answer = prompter.ask('Name: ');
  // 8 + 8 characters (with the `? ` before the question) wrap onto a second row of 10. Each backspace redraws the line; the second
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
const HINT = 'arrow keys or 1-9, Enter to choose, Esc or q to go back';
// The menu of ITEMS under `Profile acme` with the hint, the first item marked: six rows.
const MENU =
  '\n? Profile acme\n❯ 1) Toggle read-only\n  2) Check the connection\n  3) Back\n' + `  ${HINT}\n`;
// Back to the menu's first row, or to the row after its empty line, and clear to the end of the screen.
const ERASE_MENU = '\u001b[6F\u001b[J';
const ERASE_BELOW_EMPTY = '\u001b[5F\u001b[J';

/** The SGR sequences (colour and other text attributes) in `text`, without their ESC [. */
function sgr(text: string): string[] {
  return text
    .split('\u001b[')
    .slice(1)
    .filter((sequence) => /^[0-9;]*m/.test(sequence));
}

test('a menu is plain text with the first item marked, and a pick leaves its empty line and one line', async () => {
  const { input, prompter, shown } = terminal();

  const choice = prompter.choose('Profile acme', ITEMS, { hint: HINT });
  input.write('\r');

  expect(await choice).toBe(0);
  expect(shown()).toBe(`${MENU}${ERASE_BELOW_EMPTY}✔ Profile acme › Toggle read-only\n`);
});

test('a menu without a hint ends with its last item', async () => {
  const { input, prompter, shown } = terminal();

  const choice = prompter.choose('Profile acme', ITEMS);
  input.write('3');

  expect(await choice).toBe(2);
  expect(shown()).toBe(
    '\n? Profile acme\n❯ 1) Toggle read-only\n  2) Check the connection\n  3) Back\n' +
      '\u001b[4F\u001b[J✔ Profile acme › Back\n',
  );
});

test('arrow keys move the mark, wrapping around, and redraw the whole menu without colour', async () => {
  const { input, prompter, shown } = terminal();

  const choice = prompter.choose('Profile acme', ITEMS, { hint: HINT });
  // Down, down, down (back to the first), up (to the last), Enter.
  input.write('\u001b[B\u001b[B\u001b[B\u001b[A\r');

  expect(await choice).toBe(2);
  expect(shown()).toContain(
    `${ERASE_MENU}\n? Profile acme\n  1) Toggle read-only\n❯ 2) Check the connection\n`,
  );
  expect(shown()).toContain(`  2) Check the connection\n❯ 3) Back\n  ${HINT}\n${ERASE_MENU}`);
  expect(shown().endsWith(`${ERASE_BELOW_EMPTY}✔ Profile acme › Back\n`)).toBe(true);
  // No colour or other text attribute (SGR), so NO_COLOR has nothing to turn off.
  expect(sgr(shown())).toEqual([]);
});

test('on a narrow terminal, redrawing and erasing count the rows each line wraps onto', async () => {
  // 10 columns: the empty line 1 row, `? Profile acme` (14) 2, `❯ 1) Toggle read-only` (21) 3,
  // `  2) Check the connection` (25) 3, `  3) Back` (9) 1: 10 rows.
  const { input, prompter, shown } = terminal(10);

  const choice = prompter.choose('Profile acme', ITEMS);
  input.write('\u001b[B\r');

  expect(await choice).toBe(1);
  // The move redraws all 10 rows. After it `  1) Toggle read-only` (21) and
  // `❯ 2) Check the connection` (25) still take 3 each, so the pick erases the 9 below the empty line.
  expect(shown().split('\u001b[10F\u001b[J')).toHaveLength(2);
  expect(shown().endsWith('\u001b[9F\u001b[J✔ Profile acme › Check the connection\n')).toBe(true);
});

test('with colour, the title is bold, the marked item cyan, the hint dim and the pick mark green', async () => {
  const { input, prompter, shown } = terminal(undefined, true);

  const choice = prompter.choose('Profile acme', ITEMS, { hint: HINT });
  input.write('\r');

  expect(await choice).toBe(0);
  expect(shown()).toContain('\u001b[36m?\u001b[39m \u001b[1mProfile acme\u001b[22m\n');
  expect(shown()).toContain('\u001b[36m❯ 1) Toggle read-only\u001b[39m\n');
  expect(shown()).toContain(`  \u001b[2m${HINT}\u001b[22m\n`);
  expect(shown()).toContain(
    '\u001b[32m✔\u001b[39m Profile acme \u001b[2m›\u001b[22m \u001b[36mToggle read-only\u001b[39m\n',
  );
});

test('with colour, the question mark of a question is cyan', async () => {
  const { input, prompter, shown } = terminal(undefined, true);

  const answer = prompter.ask('Token: ', { hidden: true });
  input.write('s3cret-token\r');

  expect(await answer).toBe('s3cret-token');
  expect(shown()).toBe('\u001b[36m?\u001b[39m Token: \n');
});

test('a number picks its item at once, and the next question starts empty', async () => {
  const { input, prompter } = terminal();

  const choice = prompter.choose('Profile acme', ITEMS);
  input.write('2');
  expect(await choice).toBe(1);

  const answer = prompter.ask('Download directory: ');
  input.write('/srv\r');
  expect(await answer).toBe('/srv');
});

test('a number beyond the menu is ignored', async () => {
  const { input, prompter } = terminal();

  const choice = prompter.choose('Profile acme', ITEMS);
  input.write('7\u001b[B\r');

  expect(await choice).toBe(1);
});

test.each([
  ['q', 'q'],
  ['Esc', '\u001b'],
])('%s goes back and leaves nothing of the menu', async (_key, keys) => {
  const { input, prompter, shown } = terminal();

  const choice = prompter.choose('Profile acme', ITEMS, { hint: HINT });
  input.write(keys);

  expect(await choice).toBe('back');
  expect(shown()).toBe(`${MENU}${ERASE_MENU}`);
});

test('Ctrl+C cancels the menu, leaves nothing of it, and cancels every later question', async () => {
  const { input, prompter, shown } = terminal();

  const choice = prompter.choose('Profile acme', ITEMS, { hint: HINT });
  input.write('\u0003');

  expect(await choice).toBeUndefined();
  expect(shown()).toBe(`${MENU}${ERASE_MENU}`);
  expect(await prompter.choose('Main menu', ITEMS)).toBeUndefined();
  expect(await prompter.ask('Download directory: ')).toBeUndefined();
});
