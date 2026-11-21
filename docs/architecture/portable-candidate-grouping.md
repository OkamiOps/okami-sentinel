# Portable candidate grouping

Discovery passes (Standard, Deep partitions, the complementary review) often
report the same issue more than once with different wording. Grouping them is
done in code, once, before the first AI assessment stage, so AI review cost and
verdict drift do not scale with duplicate count.

- Rule `same-category-attacker-primary-anchor-v1`: two candidates group only
  with equal normalized category and attacker, a primary anchor (control, else
  sink, else the first anchor) with the same role, file and overlapping lines
  as the group's representative, and at least one overlapping sink when both
  name sinks. Free text is never compared. Candidates without a recorded
  hypothesis/control hypothesis (historical artifacts) are never grouped, and a
  group never exceeds the 20 anchors a finding can carry.
- The first candidate in discovery order is the representative. It carries the
  merged anchors into dataflow, validation and report; the other members are
  removed from the dossier the AI sees.
- `portable-codex-security-candidate-groups.json` is written to
  `portable-codex-security-artifacts/` when grouping runs and copied to
  `portable-codex-security-results/` at normalize. Resume reuses it and fails
  closed when discovery no longer reproduces it; a resumed run that already has
  assessment checkpoints but no grouping file keeps every candidate.
- `GET /scans/:id/candidate-groups` returns the recorded groups, every member,
  and the representative's decisive assessment (validation, else dataflow) as
  the verdict shared by all members. Scans without the file report
  `recorded: false`.
