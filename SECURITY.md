# Security policy

[English](SECURITY.md) · [Português (Brasil)](SECURITY.pt-BR.md) · [Deutsch](SECURITY.de.md) · [Français](SECURITY.fr.md)

## Supported version

Security fixes currently target the latest commit on `main`. Before a stable release, older commits and local forks are not covered by a backport guarantee.

## Report a vulnerability

Do **not** disclose exploitable details in a public issue. Use the repository’s **Security → Report a vulnerability** flow when available, or contact the repository owner privately through GitHub.

Include:

- affected component and commit;
- reproduction steps or a minimal proof of concept;
- expected impact and attack prerequisites;
- whether local scanner output, GitHub Checks, or repository data is exposed;
- any mitigation already tested.

Please allow time for validation before public disclosure. No response-time SLA is promised while the project remains pre-stable, but actionable reports will be triaged as a priority.

## Security boundaries

- Scanner output, findings, paths, logs, and repository content are untrusted input.
- The default product is local-first. Starting a scan explicitly authorizes the selected provider connection to receive the prompts and bounded repository evidence required by that methodology. GitHub publication remains a separate explicit action.
- Remote Guardrails requires an explicitly selected private GitHub App installation and repository. The server resolves refs to immutable SHAs, reads policy from the protected branch, and rejects implicit remote `HEAD`. Sentinel never commits or pushes to the target; only the pinned repository workflow may publish a Check. Installation tokens remain server-side and are never returned to the browser.
- Operational failures must never become passing security decisions.
- Provider secrets and OAuth tokens are write-only through the local API and stored through the OS credential vault. SQLite stores opaque credential references, never secret values, and public connection DTOs never return a credential.
- Scanner manifests, telemetry, SSE events, and persisted logs must pass through the shared redaction boundary. Local subscription children receive a minimal environment rather than the API process environment.
- Custom compatible endpoints are untrusted configuration. The exact persisted connection, model, and protocol tuple must pass the fixed URL, transport, redirect, response-size, and capability checks before that model becomes scanner-eligible; Sentinel does not silently substitute another tuple.
- Portable stage artifacts and private report pages are untrusted input. Before accepting an artifact write, the server validates a strict contract and the pinned snapshot anchors. A rejected artifact gets only a bounded repair window within the scan's existing global turn, tool, elapsed-time, and configured-cost limits.
- The server derives rejected-candidate coverage, keeps report pages private, and writes one final report only after every page validates and consolidates. A failed page or repair never publishes a partial final report.
- The public Portable normalization boundary is whole-report aware: it accepts at most 512 findings, 20 anchors per finding, and a 4 MiB canonical output. Public text and evidence pass through redaction, and limits fail closed instead of truncating a report silently.
- Managed scan deletion is available only for terminal runs. It may remove the local record and a Sentinel-managed artifact directory, but never the analyzed repository or an external path; the target and effect must remain explicit in the UI.

## Sensitive data

Never attach real secrets, private source code, full scanner state, database files, or personal filesystem paths to a public issue. Redact logs and provide the smallest artifact that reproduces the problem.
