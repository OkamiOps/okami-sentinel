# Produktprinzipien

[English](PRODUCT.md) · [Português (Brasil)](PRODUCT.pt-BR.md) · [Deutsch](PRODUCT.de.md) · [Français](PRODUCT.fr.md)

<!-- impeccable:product-schema 1 -->

## Plattform

Webanwendung mit lokaler API.

## Nutzer

Entwickler, DevSecOps-Fachleute, Security Reviewer und AI Engineers verwenden das Produkt einzeln zum Ausführen von Scans und gemeinsam zur Bewertung von Belegen, Kosten und technischer Effizienz.

## Produktzweck

OKAMI Sentinel ist eine lokale Workbench zum Ausführen von Codex-Security-, Google-Mantis- und Capital-One-VulnHunter-Scans, zum Verfolgen der Ausführung, Untersuchen von Findings, Messen geschätzter Kosten und Vergleichen von Modell-/Effort-Kombinationen. Codex Security löst vor dem Start entweder den Native-Upstream-Vertrag oder das von Sentinel verwaltete defensive Portable-Profil auf. Erfolg bedeutet, relevantes Risiko mit genügend Handlungskontext zu finden und zugleich Kosten und Ausführungsgrenze jeder Scanstrategie zu verstehen.

## Positionierung

Das Produkt verbindet Sicherheitsbelege und Ausführungstelemetrie. Findings, Schweregrad, Modell, Effort, Dauer, Tokens und geschätzte Kosten leben in einem vergleichbaren Ablauf.

## Betriebskontext

Das Produkt wird während Entwicklung und Sicherheitsreview an lokalen Repositories eingesetzt. Scans können lange laufen, partiell oder teuer sein; Ergebnisse müssen während und nach der Ausführung lesbar bleiben. Der Hauptfluss lautet Übersicht → neuer Scan → Aktivität/Detail → Vergleich → Bericht.

## Fähigkeiten und Grenzen

- Lokale React/Vite-Oberfläche, Hono-API und in SQLite gespiegelte Metadaten.
- Vorhandene kompatible Scans werden aus dem konfigurierten lokalen Scanner-State und aus von Sentinel verwalteten Ausgaben indexiert.
- Engine, Verbindung, Protokoll, Ausführungsprofil und Modellauswahl werden vor dem Start aufgelöst und festgeschrieben. Ein Scan verwendet entweder ein Modell aus dem Live-Katalog oder, nur wenn der Adapter dies deklariert, einen expliziten Runtime-Default. Ein Tupel, das eine Capability-Probe erfordert, ist erst nach einer frischen passenden erfolgreichen Probe berechtigt; Sentinel fällt nie still auf eine andere Route, ein anderes Modell oder Profil zurück.
- Modelle und Reasoning-Effort-Optionen stammen aus dem Katalog des ausgewählten Runtime/Providers. Veröffentlicht ein Provider keine Effort-Metadaten, bleibt der Effort providerverwaltet, statt dass Sentinel Optionen erfindet.
- UI in PT-BR, Englisch, Spanisch, Deutsch und Französisch mit erkannter und lokal gespeicherter Auswahl.
- Eine Baseline und bis zu fünf Kandidaten pro Vergleich.
- Unterbrochene Scans mit Findings bleiben als klar markierte Teilergebnisse verfügbar.
- Einzel- und Vergleichsberichte verwenden dasselbe Beleg-, Kosten- und Effizienzmodell und können gedruckt oder als PDF exportiert werden.
- Kosten erscheinen nur, wenn gemeldete Usage und passende Preisdaten vorliegen; andernfalls bleiben sie nicht verfügbar, niemals ein erfundenes Nullergebnis oder eine Abo-Rechnung.
- High pro Dollar ist eine Heuristik, kein Genauigkeitsbeweis.
- Scanner-Belege bleiben zur Wahrung der technischen Bedeutung in ihrer Quellsprache.
- Das Run-Ledger zeigt die Engine- und Modellidentität sowie High+ und die Gesamtzahl der Findings, damit eine Zeile ohne das Öffnen der Detailansicht verständlich bleibt.
- Nur terminale Scans können nach einer Bestätigung explizit entfernt werden. Sentinel entfernt den lokalen Datensatz und gegebenenfalls seine verwalteten Artefakte, niemals jedoch das analysierte Repository oder externe Pfade.
- Desktop, Mobile, Tastatur, sichtbarer Fokus und Reduced Motion sind Anforderungen.

## Markenversprechen

Name und technischer Security-Benchmark-Charakter von OKAMI Sentinel bleiben erhalten. Das Hauptthema ist dunkel. Die Oberfläche vermeidet generische SaaS-Muster und verhält sich wie ein Sicherheitsinstrument, ohne andere Produkte zu kopieren oder Behauptungen zu erfinden.

## Vorhandene Belege

- Reale Scanmetadaten, Metriken und Findings aus der lokalen API.
- Visuelle Referenzen aus dem Redesign im August 2026.
- Bereitgestellte OKAMI-Sentinel-Identität für Produkt und Berichte; keine nicht freigegebenen Varianten oder kommerziellen Aussagen.

## Prinzipien

- Signal vor Dekoration.
- Risiko und Kosten in derselben Entscheidung lesbar halten.
- Betriebszustand, Beleg und Schätzung trennen.
- Schnelle Einzellektüre und klare Teamübergabe ermöglichen.
- Rohdaten bewahren und destruktive Aktionen explizit machen.
- Fehlende Belege nie ohne Bestätigung als Behebung bezeichnen.

## Barrierefreiheit und Inklusion

WCAG-AA-Kontrast, Tastaturnavigation, nicht nur farbbasierte Statuslabels, komfortable Ziele, lange deutsche/französische Texte und `prefers-reduced-motion` sind Anforderungen.
