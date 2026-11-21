# Sentinel OpenGrep rules

These rules are authored for Sentinel; none are copied from third-party rule packs.
They follow the repository's licensing terms (the repository currently grants no
license; see the root README). No additional third-party rule license applies.

This deliberately small heuristic pack identifies review candidates, not proven
vulnerabilities. It is not a replacement for semantic review or a complete SAST
corpus. Rules contain CWE metadata; only password-named inputs trigger weak-hash
rules. Constant dynamic-code and HTML inputs are excluded where practical.

Run `pnpm --filter @csb/api exec tsx --test src/sast/opengrep-rules.test.ts`.
The fixture-based test skips when OpenGrep is absent; set
`SENTINEL_OPENGREP_BIN` to test a specific installed executable.
