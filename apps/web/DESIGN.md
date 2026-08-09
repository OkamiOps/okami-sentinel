---
name: OKAMI Sentinel / Test Bench
description: Dark security instrumentation workspace built around evidence channels
colors:
  canvas: "#08090f"
  machine: "#0d1017"
  alloy: "#171824"
  edge: "#292b3a"
  ink: "#f2f2f4"
  command-orange: "#ff6b24"
  evidence-cyan: "#11cddd"
  priority-magenta: "#f32bc2"
  attention-amber: "#f2b824"
  success-green: "#66d889"
typography:
  display: "Manrope Variable"
  body: "Geist Variable"
  telemetry: "JetBrains Mono Variable"
geometry:
  radius: "2px"
  border: "1px"
---

# Design system: Test Bench

[English](DESIGN.md) · [Português (Brasil)](DESIGN.pt-BR.md) · [Deutsch](DESIGN.de.md) · [Français](DESIGN.fr.md)

## North star

The product is a security benchmark bench, not a SaaS dashboard. Work is organized as channels, signals, traces, patch bays, manifests, and inspectors. The visual language uses dense heatmaps, multi-panel workspaces, operational lists, persistent command bars, and instrument readouts.

## Signature

The **Evidence Spectrum** is the proprietary visual. Each run becomes a channel with a normalized severity band. The band compares distribution, volume, cost, and state without hiding evidence inside KPI-card grids or decorative donuts.

## Shell

- Compact horizontal command bar; no permanent sidebar.
- Numbered modules and engine state share the same rail.
- Compact language selector with native names and explicit selection.
- Persistent bottom command dock for launching or returning to active work.
- Near-black canvas with a restrained structural grid.
- Connected panels with 2px radius only where the primitive requires it.

## Color roles

- **Orange:** command, launch, destructive confirmation, and primary action.
- **Cyan:** evidence, selection, focus, and efficiency.
- **Magenta:** critical/high priority and meaningful divergence.
- **Amber:** medium severity, warning, and partial results.
- **Green:** completed, ready, and verified operational state.

Color never carries meaning alone; status and severity always have a text label.

## Routes

- **Overview:** channel index, Evidence Spectrum, sample readout, and cost/evidence traces.
- **Runs:** dense ledger; canceled and failed runs are filtered deliberately, never silently destroyed.
- **Operate:** connected target, strategy, and authorization sequencer.
- **Compare:** run library, baseline/candidates, efficiency plane, decision cockpit, and evidence diff.
- **Reports:** editorial print/PDF reading with OKAMI identity, executive summary, comparable metrics, and bounded finding detail.
- **Activity:** live bus and continuous event trace.
- **Scan detail:** channel header plus evidence index, list, inspector, telemetry, and profile.
- **Guardrails:** repository portfolio, pipeline state, policy editor, and Decision Graph.
- **System:** engine matrix, capacity envelope, authentication mode, and index operation.

## Component policy

shadcn provides action, input, dropdown, sheet, dialog, and infrastructure primitives. daisyUI provides compatible form, table, and loading primitives. Recharts draws data traces and comparison planes. Custom CSS is restricted to tokens, the canvas grid, print composition, and product-specific connected layouts.

## Rules

1. No route begins with four generic KPI cards.
2. Decorative information never competes with operational signal.
3. Financial values explicitly display USD.
4. Charts expose absolute values or their normalization rule.
5. Wide content uses local overflow; the document never creates page-level horizontal scrolling.
6. Mobile stacks modules in decision order.
7. Motion respects `prefers-reduced-motion`.
8. Components accommodate German and French without clipping essential actions.
9. Dates and numbers follow the active locale; USD and scanner codes remain explicit.
10. Scanner evidence is not translated automatically.
11. Print layouts are validated in a real A4 PDF and may not hide overflow.
12. Operational failure is never styled as security approval.
