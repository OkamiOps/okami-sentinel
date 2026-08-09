# Sicherheitsrichtlinie

[English](SECURITY.md) · [Português (Brasil)](SECURITY.pt-BR.md) · [Deutsch](SECURITY.de.md) · [Français](SECURITY.fr.md)

## Unterstützte Version

Sicherheitskorrekturen zielen derzeit auf den neuesten Commit von `main`. Vor einer stabilen Version besteht keine Backport-Garantie für ältere Commits oder lokale Forks.

## Schwachstelle melden

Ausnutzbare Details dürfen **nicht** in einem öffentlichen Issue veröffentlicht werden. Wenn verfügbar, **Security → Report a vulnerability** verwenden oder den Repository-Verantwortlichen privat über GitHub kontaktieren.

Die Meldung sollte enthalten:

- betroffene Komponente und Commit;
- Reproduktionsschritte oder minimalen Proof of Concept;
- erwartete Auswirkungen und Angriffsvoraussetzungen;
- mögliche Exposition von Scanner-State, GitHub Checks oder Repository-Daten;
- bereits getestete Gegenmaßnahmen.

Vor öffentlicher Veröffentlichung muss Zeit für die Validierung bleiben. Solange das Projekt nicht stabil ist, gibt es kein zugesagtes Reaktions-SLA; umsetzbare Meldungen werden jedoch priorisiert.

## Sicherheitsgrenzen

- Scanner-Ausgabe, Findings, Pfade, Logs und Repository-Inhalte sind nicht vertrauenswürdige Eingaben.
- Das Produkt ist standardmäßig local-first. Daten verlassen den Rechner nur durch ausdrücklich angeforderte Integrationen wie GitHub Checks oder API-gestützte Actions-Läufe.
- Operative Fehler dürfen nie zu einer positiven Sicherheitsentscheidung werden.
- `OPENAI_API_KEY` ist ein GitHub-Actions-Secret. Die Anwendung prüft nur die Verfügbarkeit und speichert den Wert nicht.
- Das Löschen verwalteter Scans kann lokale Ausgaben entfernen; Ziel und Wirkung müssen in der UI explizit sein.

Keine echten Secrets, privaten Quellen, vollständigen Scanner-States, Datenbanken oder persönlichen Pfade an öffentliche Issues anhängen. Logs redigieren und nur das kleinste reproduzierbare Artefakt bereitstellen.
