import { afterEach, expect, test, vi } from 'vitest';
import { resolveLocale, t } from '../src/i18n/index.ts';

function stubLocale(vars: { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string }) {
  vi.stubEnv('LC_ALL', vars.LC_ALL ?? '');
  vi.stubEnv('LC_MESSAGES', vars.LC_MESSAGES ?? '');
  vi.stubEnv('LANG', vars.LANG ?? '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test('LC_ALL wins over LC_MESSAGES and LANG', () => {
  stubLocale({ LC_ALL: 'de_AT.UTF-8', LC_MESSAGES: 'en_US', LANG: 'en_US' });
  expect(resolveLocale()).toBe('de');

  stubLocale({ LC_ALL: 'en_GB.UTF-8', LANG: 'de_DE.UTF-8' });
  expect(resolveLocale()).toBe('en');
});

test('empty variables are skipped', () => {
  stubLocale({ LANG: 'de_CH.UTF-8' });
  expect(resolveLocale()).toBe('de');
});

test('non-German locales get English', () => {
  stubLocale({ LANG: 'C' });
  expect(resolveLocale()).toBe('en');

  stubLocale({ LANG: 'fr_FR.UTF-8' });
  expect(resolveLocale()).toBe('en');
});

test('substitutes placeholders', () => {
  expect(t('en', 'cli.unknownCommand', { command: 'x' })).toBe('Unknown command: x');
});
