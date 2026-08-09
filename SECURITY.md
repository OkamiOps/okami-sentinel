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
- The default product is local-first. Data leaves the machine only through an explicitly requested integration such as GitHub Checks or an API-backed GitHub Actions run.
- Operational failures must never become passing security decisions.
- `OPENAI_API_KEY` is a GitHub Actions secret. The application diagnoses its presence but does not read or persist its value.
- Managed scan deletion may remove local scan output; the target and effect must remain explicit in the UI.

## Sensitive data

Never attach real secrets, private source code, full scanner state, database files, or personal filesystem paths to a public issue. Redact logs and provide the smallest artifact that reproduces the problem.
