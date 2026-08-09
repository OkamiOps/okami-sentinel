---
name: OKAMI Sentinel / Test Bench
description: Dunkle Security-Instrumentierungsumgebung auf Basis von Belegkanälen
---

# Designsystem: Test Bench

[English](DESIGN.md) · [Português (Brasil)](DESIGN.pt-BR.md) · [Deutsch](DESIGN.de.md) · [Français](DESIGN.fr.md)

## Leitbild

Das Produkt ist ein Security-Benchmark-Prüfstand, kein SaaS-Dashboard. Arbeit wird als Kanäle, Signale, Traces, Patch Bays, Manifeste und Inspektoren organisiert. Die Bildsprache nutzt dichte Heatmaps, Multi-Panel-Workspaces, operative Listen, persistente Befehlsleisten und Instrumentenanzeigen.

## Signatur

Das **Evidence Spectrum** ist das proprietäre Visual. Jeder Lauf wird zu einem Kanal mit normalisiertem Schweregradband. Dieses Band vergleicht Verteilung, Volumen, Kosten und Zustand, ohne Belege in KPI-Karten oder dekorativen Donuts zu verstecken.

## Shell

- Kompakte horizontale Befehlsleiste; keine permanente Sidebar.
- Nummerierte Module und Engine-Status auf derselben Leiste.
- Kompakter Sprachselektor mit Eigennamen und expliziter Auswahl.
- Persistentes Command Dock zum Starten oder Zurückkehren zu aktiver Arbeit.
- Nahezu schwarzer Canvas mit zurückhaltendem Strukturraster.
- Verbundene Panels und 2px Radius nur dort, wo das Primitive ihn verlangt.

## Farbrollen

- **Orange:** Befehl, Start, destruktive Bestätigung und primäre Aktion.
- **Cyan:** Beleg, Auswahl, Fokus und Effizienz.
- **Magenta:** Critical/High-Priorität und relevante Abweichung.
- **Amber:** Medium, Warnung und Teilergebnis.
- **Grün:** abgeschlossen, bereit und operativ verifiziert.

Farbe trägt nie allein Bedeutung; Status und Schweregrad haben immer ein Textlabel.

## Routen

- **Übersicht:** Kanalindex, Evidence Spectrum, Sample Readout und Kosten-/Beleg-Traces.
- **Runs:** dichtes Ledger; abgebrochene und fehlgeschlagene Läufe werden bewusst gefiltert, nie still gelöscht.
- **Ausführen:** verbundener Target-, Strategy- und Authorization-Sequencer.
- **Vergleichen:** Run-Bibliothek, Baseline/Kandidaten, Effizienzebene, Entscheidungscockpit und Diff.
- **Berichte:** redaktionelle Print/PDF-Ansicht mit OKAMI-Identität, Summary, Metriken und begrenztem Finding-Detail.
- **Aktivität:** Live Bus und kontinuierlicher Event Trace.
- **Scan-Detail:** Channel Header, Index, Liste, Inspector, Telemetrie und Profil.
- **Guardrails:** Repository-Portfolio, Pipeline, Policy Editor und Decision Graph.
- **System:** Engine Matrix, Capacity Envelope, Authentifizierung und Indexbetrieb.

## Komponentenrichtlinie

shadcn liefert Primitives für Aktionen, Inputs, Dropdowns, Sheets, Dialoge und Infrastruktur. daisyUI liefert kompatible Form-, Tabellen- und Lade-Primitives. Recharts zeichnet Traces und Vergleichsebenen. Eigenes CSS bleibt auf Tokens, Canvas-Raster, Druckkomposition und produktspezifische verbundene Layouts beschränkt.

## Regeln

1. Keine Route beginnt mit vier generischen KPI-Karten.
2. Dekoration konkurriert nie mit operativem Signal.
3. Finanzwerte zeigen USD explizit.
4. Diagramme zeigen absolute Werte oder die Normalisierungsregel.
5. Breite Inhalte verwenden lokalen Overflow; kein globaler horizontaler Scroll.
6. Mobile stapelt Module in Entscheidungsreihenfolge.
7. Bewegung respektiert `prefers-reduced-motion`.
8. Deutsche und französische Texte dürfen keine wesentlichen Aktionen abschneiden.
9. Datum und Zahlen folgen dem Locale; USD und Scanner-Codes bleiben explizit.
10. Scanner-Belege werden nicht automatisch übersetzt.
11. Drucklayouts werden in einem echten A4-PDF geprüft und dürfen Overflow nicht verstecken.
12. Operative Fehler sehen nie wie eine Sicherheitsfreigabe aus.
