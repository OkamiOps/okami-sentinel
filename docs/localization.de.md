# Lokalisierung der Oberfläche

[English](localization.md) · [Português (Brasil)](localization.pt-BR.md) · [Deutsch](localization.de.md) · [Français](localization.fr.md)

Das OKAMI-Sentinel-Frontend unterstützt fünf Locales:

- `pt-BR` — brasilianisches Portugiesisch und Fallback;
- `en` — Englisch;
- `es` — Spanisch;
- `de` — Deutsch;
- `fr` — Französisch.

## Verhalten

Beim ersten Besuch gleicht `resolveLocale` die Browsersprache mit den unterstützten Locales ab. Die Auswahl in der oberen Befehlsleiste wird als `okami-sentinel.locale` in `localStorage` gespeichert und aktualisiert das `lang`-Attribut des Dokuments.

Datum und Zahlen verwenden `Intl` mit dem aktiven Locale. Die Währung bleibt USD, da Scankosten eine Produktmetrik und keine Wechselkursumrechnung sind.

## Architektur

- `apps/web/src/i18n.tsx`: Locale-Typen, Wörterbücher, Auflösung, Persistenz und React Provider.
- `apps/web/src/components/LanguageSwitcher.tsx`: barrierearmer Selektor auf Basis des gemeinsamen Dropdowns.
- `apps/web/src/format.ts`: lokalisierte Formatierung für Datum, Zahlen und USD.
- `apps/web/src/lib/i18n.test.ts`: Tests für Fallback, Browservarianten und Interpolation.

Neue Schlüssel werden im kanonischen Wörterbuch angelegt und erhalten anschließend Werte in allen weiteren Wörterbüchern. Der Typ `TranslationKey` verhindert Verweise auf unbekannte Schlüssel.

## Bewusste Grenze

Befehle, Zustände und operative Hinweise der Oberfläche werden lokalisiert. Vom Scanner erzeugte Titel, Finding-Zusammenfassungen, Belege, Codes, Pfade und Logs bleiben in der Quellsprache. Eine automatische Übersetzung könnte entscheidungsrelevante Belege verändern.

## Mindestprüfung

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Die visuelle Prüfung muss Desktop und Mobile abdecken. Deutsch und Französisch benötigen wegen längerer Texte besondere Aufmerksamkeit; keine Aktion darf überlagert oder unerreichbar sein.
