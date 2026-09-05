# Changelog

## [0.2.0] - 2026-09-06

Local maintainability upgrade for the `deepseek-subagent` Codex Skill.

- Split `SKILL.md` into a thin procedural entrypoint plus focused responsibility references: delegation, ACP supervision, evidence verification, and review/validation/takeover.
- Made DeepSeek the substantive execution owner while Codex plans, supervises the full observable ACP trace, reviews, verifies evidence, and performs final validation. Codified the two-correction automatic-supervision threshold and the user-approved takeover procedure.
- Extracted centralized `policy`, `trace`, and `evidence` modules under `scripts/lib/` with explicit inputs and outputs and no new runtime dependencies.
- Kept the six controller operations and the six required task fields; added an optional `evidenceRequirements` field that defaults to not required.
- Added a per-job `artifacts/` directory with an exact `evidence.json` path outside the delegated worktree; mutation permission covers only the worktree and that exact evidence file, and evidence-required tasks run only in ACP mode.
- Correlated ACP permission requests with their preceding tool-call events, so ID-only escalation requests retain the target path needed for exact-file authorization.
- Added evidence schema v1 validation with `not_required`, `missing`, `invalid`, and `ready` statuses.
- Added sequence-based trace completeness: `wait` returns `latestSeq` and `nextAfter`; `result` returns a deterministic trace summary, `correctionCount`, `evidenceStatus`, and parsed evidence.
- Preserved existing lifecycle, concurrency, timeout, permission, worktree isolation, and dirty-worktree cleanup protection.
- Validated with `npm run check` (19 tests), the official Skill validator, copy lint, and a real ACP evidence job. The real job produced 123 contiguous events, reached `idle` after two supervised corrections, returned `evidenceStatus: ready`, and kept its delegated worktree clean.

## [0.1.0] - Initial release

- Controller with `spawn`, `wait`, `followup`, `interrupt`, `result`, and `cleanup` operations over ACP and headless DeepSeek Harness profiles.
- Detached Git worktree isolation, three-job concurrency cap, and dirty-worktree cleanup protection.
