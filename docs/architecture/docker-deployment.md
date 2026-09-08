# Docker deployment decisions

Implemented September 2026. Operator instructions are in [Docker](../docker.md)
and [Dokploy](../dokploy.md). The original execution plan remains in Git at
`bce4a98:docs/architecture/2026-09-08-docker-deployment-plan.md`.

## Distribution and execution boundary

- Local installation remains Node 24 + pnpm 11.5.2, with the existing desktop
  credential store and local CLI/session integrations.
- Docker uses a Linux amd64 image containing the compiled web app, the API,
  TypeScript workers and their production dependencies. The API serves the web
  app and `/api` under one origin. No Vite development server runs in production.
- Server scans use HTTP inference connections: Codex Security Portable, Mantis
  HTTP and VulnHunter HTTP. Native/local-session profiles and legacy launches
  without a registered connection are rejected before provider execution.
- Workers still consume CPU, RAM and disk on the Docker host. Default scan
  concurrency is one. This is one trusted installation, not a multi-tenant SaaS.

## Access and storage

`CSB_RUNTIME_MODE=server` requires an explicit public origin, administrative
Basic authentication and an encrypted credential vault. HTTPS is required for
non-loopback origins. Authentication covers HTML, assets, API and SSE. Mutations
also require the configured Origin and a process-scoped CSRF token; the web client
refreshes this token once after a server restart. `/healthz` and `/readyz` expose
only inexpensive, unauthenticated health/admission state.

The application runs as UID 1000 with a read-only root filesystem. An ephemeral
root initializer prepares five fixed directories in the named state volume.
SQLite, reports, temporary snapshots, private home and managed runtimes persist
there. Repository mounts live under `/repos`, are read-only and pass a canonical
path boundary check. Symlinks cannot escape the configured repository roots.
Git operations authorize the exact canonical checkout per invocation in server
mode because bind mounts retain the host UID. No global `safe.directory=*`
exception is installed. Docker CI exercises a repository owned by UID 1001
while the application remains UID 1000.

The vault stores AES-256-GCM ciphertext under the data volume; its 32-byte key
is supplied separately as a mounted secret file. Authentication binds each
encrypted record to its namespace and reference. A key sentinel detects a
wrong key before server admission. Connection, GitHub App and xAI credential
adapters share this backend in server mode. No host keychain or home is mounted.
The API and trusted workers share a Unix identity: this is not isolation between
mutually untrusted users or processes.

GitHub App manifest flows use the explicit HTTPS `/api` callback in server mode
and persist expiring, one-use state. Local callback behavior remains unchanged.

## Lifecycle

SIGTERM stops admission, cancels active scans, permits child termination and
closes SQLite. On the next server boot, any remaining active rows are reconciled
with terminal artifacts; interrupted work becomes incomplete, without an
automatic paid retry. Local API restarts retain their existing detached-worker
behavior. Backups require a consistent stopped volume and the separately stored
vault key. Never share one SQLite volume across active replicas.

The image pins its runtime fallbacks. The updater can activate verified versions
under the persistent volume and blocks installation while scans are active.
Image updates and runtime updates have separate rollback lifecycles.

## Verification boundaries

Docker CI builds the image, checks non-root authenticated startup and runs the
three real worker pipelines against an isolated HTTP fixture. It verifies
capability negotiation, structured artifacts, findings, reports, SSE,
cancellation and restart behavior without paid model calls. This demonstrates
packaging and wire integration, not model quality or every provider's behavior.

Arm64, Windows host installation, native CLI sessions inside Docker and a live
Dokploy domain deployment are separate validation gates; Compose documentation
does not by itself establish those results.
