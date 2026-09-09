# Changelog

Notable user-facing changes to OKAMI Sentinel are recorded here. This log starts
with the Docker and engine-update work; earlier history remains in
[Git commits](https://github.com/OkamiOps/okami-sentinel/commits/main/).

## Unreleased

### Fixed

- Portable Standard runs one bounded complementary discovery pass before assessment, even when the first pass finds a candidate. It prioritizes different trust boundaries and unexamined scope, retains both artifacts and total usage, and leaves Deep's exhaustive partitions unchanged.
- Discovery scope repair now returns a bounded server-observed list of successful source reads, so the model can correct an invalid artifact directly instead of spending turns rediscovering files. Candidate telemetry counts unique carried IDs across both Standard discovery passes.
- Portable source-read guidance now explains full-file reads and hard byte limits, with actionable recovery instructions instead of repeated undersized reads. Rejected workspace tools expose safe error codes in telemetry without recording source content or arguments.
- Portable stages reuse their source map, avoid repeated reads within a stage and focus assessment/report work on the carried candidates. Independent validation and mandatory Deep coverage remain required; tool and turn budgets are ceilings rather than exploration targets.
- Portable Standard no longer accepts a discovery placeholder as a successful zero-finding review. Live discovery requires a substantive summary and explicit file scope backed by successful source reads; listings, search hits and failed reads do not count. Standard exploration uses the normal finalization reserve, and Portable finalization/repair guidance preserves candidate context instead of requesting an empty completion.
- Portable discovery requires an explicit candidate array and preserves each new candidate's hypothesis, attacker, prerequisites, expected impact and suspected control failure. Missing candidate output can no longer silently become a successful zero-finding Standard scan.
- Portable validation can inspect callers and controls across the immutable snapshot, including paginated Deep assessments. Unsupported confirmation reasons are rejected; new high/critical report findings require a severity rationale. These checks strengthen the evidence contract and do not replace security review.
- Deep discovery conservatively consolidates repeated claims at the same control location while retaining affected anchors. Assessment pages retain a usable bounded turn allowance regardless of the total page count, avoiding a late failure caused solely by a dense candidate set.
- Local API mutations require the process CSRF token and reject untrusted browser origins. The UI supplies the token automatically; CLI clients must obtain it from `/api/security-session`.
- Local gate history is scoped to the repository checkout, preventing another repository's findings from changing lifecycle classification.
- Dot-segment scan names remain inside the configured scan output root.

- Portable Codex Security refreshes xAI OAuth credentials before each inference request, including subsequent turns in one stage. Authentication, access-denied and provider-unreachable errors retain their specific failure codes.

- Portable workers tolerate closed API output pipes and persist their redacted events independently, so a development API reload does not lose metrics or terminate a scan through a broken output pipe.

- Portable Codex Security scans no longer expire after a fixed elapsed time in Standard or Deep mode. Manual cancellation and configured cost, turn, tool and byte limits remain enforced.

- Registering an already enrolled repository now returns a conflict instead of overwriting its name, executor or settings. GitHub repositories already enrolled are identified and disabled in the registration picker.

### Added

- Local operators can resume interrupted Portable Deep discovery with `pnpm --filter @csb/api exec tsx src/scanners/resume-portable-scan.ts SCAN_ID`. Add `--dry-run` to verify the snapshot and checkpoints without launching. Recovery creates a separate run, preserves accumulated usage and original evidence, refreshes provider capability checks, and reuses validated discovery batches. Later-stage interruptions are not supported by this recovery command.

- Scan details now show live snapshot files, physical LOC, source size, discovery batches, provisional candidates, rejected result writes, output rate and provider-reported reasoning tokens. Missing metrics remain unavailable; the panel refreshes during active scans.

- Search repository names and organizations during GitHub enrollment, with result counts and archived-state preservation.
- Wider desktop enrollment panel with expand/collapse control and a full-width repository picker.

- Follow all current and future branches without maintaining a fixed selection. Initial state and duplicate heads do not trigger redundant scans.
- New GitHub enrollment and monitoring flows use Sentinel execution with supported subscription/API connections; existing Actions configurations remain compatible.

- Searchable GitHub branch lists for monitoring and Actions filters, with multiple selection, retry and preserved saved selections.
- Actions executor descriptions identify Codex Security, its CLI execution on the runner and the required repository credential.

- A dedicated GitHub workspace for repository enrollment, observed PR/branch
  activity, recent external Actions runs, and persisted automation rules.
- Opt-in automatic Codex Security scans with per-scan ceilings, daily budget
  reservations, frozen commit identity, and restart-safe event deduplication.
  Actions automation uses the protected repository policy and rejects ceilings
  above the configured rule budget.
- Manual fetch and fast-forward-only pull for enrolled local checkouts, with
  clean-worktree checks and scan/maintenance admission protection.
- Optional branch filters for generated Actions callers, including PR target
  branches. See [GitHub monitoring](docs/github-monitoring.md) for setup and
  the difference between monitoring, automatic scans, and local Git operations.

- Optional Docker Compose installation for Linux amd64, alongside the existing
  pnpm installation. Docker setup does not require Node or pnpm on the host.
- A production image serving the UI, API, and scan workers, with non-root
  execution, a read-only root filesystem, persistent SQLite and engine state,
  and lightweight health/readiness checks.
- Authenticated server mode with explicit origin validation, CSRF protection,
  an encrypted credential vault, and read-only access to authorized repository
  mounts. Local pnpm mode continues to use the OS credential store.
- Docker execution for Codex Security Portable, Mantis HTTP, and VulnHunter HTTP,
  subject to the selected connection/model capability checks.
- Installation, backup, restoration, update, and HTTPS deployment instructions
  in the [Docker](docs/docker.md) and [Dokploy](docs/dokploy.md) guides.
- Engine update controls for checking, installing, and activating verified
  Codex Security and Codex CLI versions in private managed storage. Upstream
  Mantis and VulnHunter revisions are surfaced for review and integrated through
  Sentinel releases, rather than installed as independent CLIs.
- Automated Docker CI covering startup, authentication, all three HTTP scan
  workflows, reports, cancellation, concurrency, and interrupted-run recovery.

### Changed

- The English, Portuguese, German, and French READMEs now explain the pnpm and
  Docker installation choices, server credentials, mounted repository paths,
  and Docker support boundaries.
- Server shutdown drains or cancels active work. After an abrupt restart,
  orphaned runs are reconciled as incomplete without automatically retrying
  paid provider calls.
- Managed runtime updates persist across container recreation and are blocked
  while scans or preflights are active. Temporary installation caches are removed.

### Fixed

- Server Git operations can read explicitly authorized repositories owned by a
  different host UID, without globally trusting all repositories or changing
  their ownership. Docker CI exercises this case with host UID 1001 and app UID 1000.
- Stale worker state no longer turns an interrupted server run back into a
  running scan after startup recovery.

### Compatibility and validation

- Docker validation covers Linux amd64 and the three HTTP execution routes using
  a controlled provider fixture. It verifies integration behavior, not real-model
  finding accuracy. No paid model calls were required for this QA.
- Native and host-local CLI sessions remain available through pnpm and are not
  supported in the initial Docker release. Apple Silicon, Windows, and Linux
  arm64 have not been validated.
- Dokploy deployment is documented; an actual Dokploy domain deployment was not
  exercised in the initial Docker QA.
- Each deployment is a single installation with its own data and credentials;
  Docker support does not introduce multi-tenant SaaS functionality.
- Preserve the external vault key separately from the data-volume backup.
  Removing the volume with `docker compose down -v` deletes persisted state.

Implementation: [Docker and server mode](https://github.com/OkamiOps/okami-sentinel/commit/9efc80ff81255e5272b1d8656f69ca6982a56fca),
[repository ownership fix](https://github.com/OkamiOps/okami-sentinel/commit/8ac8725bf5cef5a122f0f57fd1e50a03d0ad4434).
