# Zu OKAMI Sentinel beitragen

[English](CONTRIBUTING.md) · [Português (Brasil)](CONTRIBUTING.pt-BR.md) · [Deutsch](CONTRIBUTING.de.md) · [Français](CONTRIBUTING.fr.md)

Danke für die Verbesserung von OKAMI Sentinel. Beiträge müssen drei Eigenschaften bewahren: Local-first-Betrieb, Belegtreue und explizite Sicherheitsergebnisse.

## Vor dem Start

- Für große Verhaltens-, Schema- oder Workflow-Änderungen zuerst ein Issue eröffnen.
- Pull Requests fokussiert halten; unabhängige Bereinigung gehört in eine eigene Änderung.
- Niemals Scanner-State, Datenbanken, Logs, Zugangsdaten, Secrets oder persönliche Pfade committen.
- Generierte Findings sind nicht vertrauenswürdige Eingaben und müssen an jeder Darstellungs- oder Veröffentlichungsgrenze begrenzt werden.

## Lokales Setup

```bash
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm dev
```

Voraussetzungen und Authentifizierung stehen im [README](README.de.md#voraussetzungen).

## Erforderliche Prüfungen

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Pull-Request-Checkliste

- [ ] Die Änderung verfolgt einen klaren Zweck.
- [ ] Tests decken neues Verhalten und Fehlerfälle ab.
- [ ] Typecheck, Tests und Build laufen lokal erfolgreich.
- [ ] UI-Texte sind in allen fünf Wörterbüchern vorhanden.
- [ ] Datum, Zahlen und USD verwenden die gemeinsamen Formatierer.
- [ ] Desktop und Mobile wurden auf Überlagerung, Abschneiden und Tastaturbedienung geprüft.
- [ ] Längere deutsche und französische Texte wurden visuell geprüft.
- [ ] Operative Fehler können nicht als positives Sicherheitsergebnis erscheinen.
- [ ] Dokumentation und Screenshots sind bei Workflow-Änderungen aktualisiert.

## UI und Design

- Dark-Test-Bench-Identität und Evidence Spectrum bewahren.
- Gemeinsame shadcn/daisyUI-Primitives verwenden; Buttons, Inputs, Dialoge und Tabellen nicht in eigenem CSS nachbauen.
- Recharts oder vorhandene Chart-Primitives verwenden.
- Farbe darf Bedeutung unterstützen, aber nie der einzige Statushinweis sein.
- `prefers-reduced-motion`, sichtbaren Fokus und WCAG-AA-Kontrast beachten.
- Druck/PDF-Änderungen mit einem tatsächlich erzeugten PDF prüfen.

Siehe [Designsystem](apps/web/DESIGN.de.md) und [Produktprinzipien](apps/web/PRODUCT.de.md).

## Lokalisierung

Neue Schlüssel müssen im selben Change PT-BR-, englische, spanische, deutsche und französische Werte erhalten. Vom Scanner erzeugte Titel, Zusammenfassungen, Codes, Pfade, Belege und Logs werden nicht automatisch übersetzt.

Siehe [Lokalisierungsarchitektur](docs/localization.de.md).

Commit-Meldungen sollten kurz und imperativ sein. Der Pull Request beschreibt Problem, gewähltes Verhalten, Validierung, Screenshots und verbleibende Grenzen.

Mit einem Beitrag gilt die [Sicherheitsrichtlinie](SECURITY.de.md).
