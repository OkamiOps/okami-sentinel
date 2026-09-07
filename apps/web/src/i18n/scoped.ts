import { useCallback } from "react";
import { translate, useI18n, type Locale, type TranslationKey } from "../i18n";

export type ScopedMessages<Key extends string> = Record<Locale, Record<Key, string>>;

/** Keep large route-specific catalogues inside the route's lazy bundle. */
export function translateScoped<Key extends string>(
  dictionaries: ScopedMessages<Key>, locale: Locale, key: Key | TranslationKey,
  variables: Record<string, string | number> = {},
): string {
  const messages = dictionaries[locale];
  if (!Object.hasOwn(messages, key)) return translate(locale, key as TranslationKey, variables);
  return messages[key as Key].replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name] ?? `{${name}}`));
}

export function useScopedI18n<Key extends string>(dictionaries: ScopedMessages<Key>) {
  const { locale, setLocale } = useI18n();
  const t = useCallback((key: Key | TranslationKey, variables?: Record<string, string | number>) =>
    translateScoped(dictionaries, locale, key, variables), [dictionaries, locale]);
  return { locale, setLocale, t };
}
