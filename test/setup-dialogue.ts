import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { Locale } from '../src/i18n/index.ts';
import type { Prompter } from '../src/prompt.ts';
import { runRemove, runSetup, type SetupIO } from '../src/setup.ts';
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

/** An answer: the line, undefined to cancel, or a function run when the question comes. */
type Answer = string | undefined | (() => string | undefined);

/**
 * Runs `run` (by default `setup`, which adds a profile) in `locale` with `answers` given in turn; a
 * question beyond them fails the test.
 */
export async function setup(
  answers: Answer[],
  locale: Locale = 'en',
  run: (locale: Locale, io: SetupIO) => Promise<boolean> = runSetup,
) {
  const asked: { question: string; hidden: boolean }[] = [];
  const prompter: Prompter = {
    ask(question, { hidden = false } = {}) {
      asked.push({ question, hidden });
      if (asked.length > answers.length) throw new Error(`Unexpected question: ${question}`);
      const answer = answers[asked.length - 1];
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
    close: () => undefined,
  };
  const out: string[] = [];
  const err: string[] = [];
  const done = await run(locale, {
    prompter,
    print: (text) => out.push(text),
    fail: (text) => err.push(text),
  });
  return { done, asked, out: out.join('\n'), err: err.join('\n') };
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
