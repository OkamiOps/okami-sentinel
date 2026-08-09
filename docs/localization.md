# Interface localization

[English](localization.md) · [Português (Brasil)](localization.pt-BR.md) · [Deutsch](localization.de.md) · [Français](localization.fr.md)

The OKAMI Sentinel frontend supports five locales:

- `pt-BR` — Brazilian Portuguese and fallback;
- `en` — English;
- `es` — Spanish;
- `de` — German;
- `fr` — French.

## Behavior

On the first visit, `resolveLocale` matches the browser language against supported locales. The language selected in the top command bar is stored in `localStorage` as `okami-sentinel.locale` and updates the document `lang` attribute.

Dates and numbers use `Intl` with the active locale. Currency remains in USD because scan cost is a product metric, not an exchange-rate conversion.

## Architecture

- `apps/web/src/i18n.tsx`: locale types, dictionaries, resolution, persistence, and React provider.
- `apps/web/src/components/LanguageSwitcher.tsx`: accessible selector built on the shared dropdown primitive.
- `apps/web/src/format.ts`: localized dates, numbers, and USD formatting.
- `apps/web/src/lib/i18n.test.ts`: fallback, browser variants, and interpolation tests.

Add a key to the canonical dictionary, then provide a value in all remaining dictionaries. The `TranslationKey` type prevents references to unknown keys.

## Deliberate boundary

Interface commands, states, and operational guidance are localized. Scanner-produced titles, finding summaries, evidence, code, paths, and logs remain in the source language. Automatic translation could change evidence used in a security decision.

## Minimum verification

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Visual validation must cover desktop and mobile. Pay particular attention to German and French because their labels are often longer, and verify that no action overlaps or becomes unreachable.
