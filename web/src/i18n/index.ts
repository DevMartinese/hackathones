// Dictionary loader and locale helpers for the terminal UI. English is the
// default (served at /), Spanish at /es/, Portuguese at /pt/. Commands and
// flags (`list`, `submit`, `--country`, etc.) are intentionally NOT localized
// — they stay in English across every locale to preserve the CLI feel.

import en from "./en.json";
import es from "./es.json";
import pt from "./pt.json";

export type Locale = "en" | "es" | "pt";

export const LOCALES = ["en", "es", "pt"] as const;
export const DEFAULT_LOCALE: Locale = "en";

// Each value is either a plain string or a { one, other } object for plural-
// aware keys (e.g. "1 hackathon found" vs "5 hackathons found"). The t() helper
// on the client picks the branch based on a `count` var.
export type StringValue = string | { one: string; other: string };
export type Dict = Record<string, StringValue>;

const DICTS: Record<Locale, Dict> = {
  en: en as Dict,
  es: es as Dict,
  pt: pt as Dict,
};

export function loadStrings(locale: Locale): Dict {
  return DICTS[locale];
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

// Maps a locale to its URL path prefix. The default locale lives at `/`;
// the others at `/es/` and `/pt/`.
export function localeToPath(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? "/" : `/${locale}/`;
}
