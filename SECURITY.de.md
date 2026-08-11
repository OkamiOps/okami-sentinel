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
- Das Produkt ist standardmäßig local-first. Der Start eines Scans autorisiert die ausgewählte Provider-Verbindung ausdrücklich, die für die Methodik benötigten Prompts und begrenzten Repository-Belege zu empfangen. Eine GitHub-Veröffentlichung bleibt eine separate Aktion.
- Operative Fehler dürfen nie zu einer positiven Sicherheitsentscheidung werden.
- Provider-Secrets und OAuth-Tokens sind über die lokale API nur schreibbar und werden im Credential Vault des Betriebssystems gespeichert. SQLite enthält nur undurchsichtige Referenzen; öffentliche DTOs geben keine Credentials zurück.
- Scanner-Manifeste, Telemetrie, SSE-Ereignisse und persistierte Logs durchlaufen die gemeinsame Redaktionsgrenze. Lokale Subscription-Prozesse erhalten nur eine minimale Umgebung.
- Benutzerdefinierte kompatible Endpunkte sind nicht vertrauenswürdige Konfiguration. Das exakt gespeicherte Tupel aus Verbindung, Modell und Protokoll muss URL-, Transport-, Redirect-, Größen- und Capability-Prüfungen bestehen, bevor dieses Modell für Scans freigegeben wird; Sentinel ersetzt das Tupel nicht stillschweigend.
- Das Löschen verwalteter Scans steht nur für terminale Läufe zur Verfügung. Es kann den lokalen Datensatz und ein von Sentinel verwaltetes Artefaktverzeichnis entfernen, niemals jedoch das analysierte Repository oder einen externen Pfad; Ziel und Wirkung müssen in der UI explizit sein.

Keine echten Secrets, privaten Quellen, vollständigen Scanner-States, Datenbanken oder persönlichen Pfade an öffentliche Issues anhängen. Logs redigieren und nur das kleinste reproduzierbare Artefakt bereitstellen.
