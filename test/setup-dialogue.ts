import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { Locale } from '../src/i18n/index.ts';
import type { Prompter } from '../src/prompt.ts';
import { runRemove, runSetup, type SetupIO, type SetupOutput } from '../src/setup.ts';
import { type MockRoutes, startMockSevdesk } from './mock-sevdesk.ts';

// Drives the `setup` dialogue (PRD §7, decisions 4, 18, 19) through a scripted prompter against the
// fake keychain, a mock sevDesk and the temporary home of test/setup.ts.

export const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const CHECK = 'GET /Tools/bookkeepingSystemVersion';
export const COMPANY = 'GET /SevClient';
const acme = { objects: [{ id: '1', objectName: 'SevClient', name: 'Acme GmbH' }] };
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a mock sevDesk whose account is Acme GmbH on system 2.0, with `routes` over that. */
export async function mock(routes: MockRoutes = {}) {
  const sevdesk = await startMockSevdesk({
    [COMPANY]: () => ({ json: acme }),
    'GET /Contact': () => ({ json: { objects: [{ id: '9', objectName: 'Contact' }] } }),
    ...routes,
  });
  closers.push(sevdesk.close);
  return sevdesk;
}

/** The answer to a menu that goes back, as Esc or q do. */
export const BACK = Symbol('back');

/**
 * An answer: the line, undefined to cancel, or a function run when the question comes. A menu takes
 * a text its item holds (the first such item is picked), `BACK`, or undefined to cancel.
 */
type Answer = string | undefined | typeof BACK | (() => string | undefined);

/**
 * Runs `run` (by default `setup`, which adds a profile) in `locale` with `answers` given in turn,
 * questions and menus alike; a question beyond them, or a menu answer that matches no item, fails
 * the test.
 */
export async function setup(
  answers: Answer[],
  locale: Locale = 'en',
  run: (locale: Locale, io: SetupIO) => Promise<boolean> = runSetup,
) {
  const asked: { question: string; hidden: boolean; items?: string[]; hint?: string }[] = [];
  const next = (question: string): Answer => {
    if (asked.length > answers.length) throw new Error(`Unexpected question: ${question}`);
    return answers[asked.length - 1];
  };
  const prompter: Prompter = {
    ask(question, { hidden = false } = {}) {
      asked.push({ question, hidden });
      const answer = next(question);
      if (answer === BACK) throw new Error(`A question got a menu answer: ${question}`);
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
    choose(title, items, { hint } = {}) {
      asked.push({
        question: title,
        hidden: false,
        items,
        ...(hint === undefined ? {} : { hint }),
      });
      const answer = next(title);
      if (answer === undefined || answer === BACK) {
        return Promise.resolve(answer === BACK ? 'back' : undefined);
      }
      const label = typeof answer === 'function' ? answer() : answer;
      const index = items.findIndex((item) => label !== undefined && item.includes(label));
      if (index === -1) throw new Error(`No item holds ${String(label)}: ${items.join(' | ')}`);
      return Promise.resolve(index);
    },
    close: () => undefined,
  };
  const { output, lines } = recordOutput();
  const done = await run(locale, { prompter, ...output });
  return { done, asked, ...lines() };
}

/**
 * An output that records what it is given, unmarked: marks and the gutter belong to the terminal edge
 * (test/terminal.test.ts). `lines()` gives every line but the failures in order (`out`), the successes
 * alone (`successes`) and the failures (`err`).
 */
export function recordOutput() {
  const out: string[] = [];
  const successes: string[] = [];
  const err: string[] = [];
  const output: SetupOutput = {
    print: (text) => out.push(text),
    heading: (text) => out.push(text),
    success: (text) => {
      out.push(text);
      successes.push(text);
    },
    fail: (text) => err.push(text),
  };
  const lines = () => ({
    out: out.join('\n'),
    successes: successes.join('\n'),
    err: err.join('\n'),
  });
  return { output, lines };
}

/** Runs `setup --remove <name>` in `locale` with `answers` given in turn. */
export function remove(name: string, answers: Answer[], locale: Locale = 'en') {
  return setup(answers, locale, (language, io) => runRemove(language, io, name));
}

/** The files under the temporary home whose content holds `text`. */
export function filesHolding(text: string): string[] {
  return readdirSync(homedir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file, 'utf8').includes(text));
}

/** Writes a client config `file` (a string as it is, anything else as JSON), directory included. */
export function writeClient(file: string, content: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

/** The JSON in `file`. */
export function json(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The backups setup left next to `file`. */
export function backupsOf(file: string): string[] {
  return readdirSync(dirname(file))
    .filter((name) => name.startsWith(`${basename(file)}.sevdesk-mcp-`) && name.endsWith('.bak'))
    .map((name) => join(dirname(file), name));
}
