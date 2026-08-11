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
- Operational failures must never become passing security decisions.
- Provider secrets and OAuth tokens are write-only through the local API and stored through the OS credential vault. SQLite stores opaque credential references, never secret values, and public connection DTOs never return a credential.
- Scanner manifests, telemetry, SSE events, and persisted logs must pass through the shared redaction boundary. Local subscription children receive a minimal environment rather than the API process environment.
- Custom compatible endpoints are untrusted configuration. The exact persisted connection, model, and protocol tuple must pass the fixed URL, transport, redirect, response-size, and capability checks before that model becomes scanner-eligible; Sentinel does not silently substitute another tuple.
- Managed scan deletion is available only for terminal runs. It may remove the local record and a Sentinel-managed artifact directory, but never the analyzed repository or an external path; the target and effect must remain explicit in the UI.

## Sensitive data

Never attach real secrets, private source code, full scanner state, database files, or personal filesystem paths to a public issue. Redact logs and provide the smallest artifact that reproduces the problem.
