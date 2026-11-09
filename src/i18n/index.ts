import de from './de.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export type MessageKey = keyof typeof en;
export type Locale = 'en' | 'de';

// en is the reference catalog; scripts/check-i18n.ts enforces exact key parity.
const catalogs: Record<Locale, Record<MessageKey, string>> = { en, de };

/**
 * Picks the CLI language from the POSIX locale variables (LC_ALL > LC_MESSAGES > LANG),
 * falling back to the runtime's default locale (macOS/Windows often set no LANG).
 * German locales get German, everything else English.
 */
export function resolveLocale(): Locale {
  const tag =
    [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find(
      (value) => value !== undefined && value !== '',
    ) ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return tag.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/** Looks up a message and substitutes `{name}` placeholders from `params`. */
export function t(locale: Locale, key: MessageKey, params: Record<string, string> = {}): string {
  return catalogs[locale][key].replace(
    /\{(\w+)\}/g,
    (match, name: string) => params[name] ?? match,
  );
}
