# Review, validation, and takeover

## Review the delegated work

1. Call `result` and read the returned state, `result.result`, `trace`, `correctionCount`, and `evidence`.
2. Inspect the diff in the returned worktree (`git diff` inside `worktreePath`). Never copy it into the primary checkout before review.
3. Run the required checks yourself in the worktree and confirm each acceptance criterion against the actual changes.
4. When evidence is required, verify it as described in [evidence-verification.md](evidence-verification.md).
5. Selectively apply acceptable changes to the primary checkout, then re-run the checks there.

Treat DeepSeek's output as proposed work until these steps pass. Report what was delegated, what changed, which checks Codex ran, and any remaining risk to the user.

## Preserving and cleaning up

The controller refuses to remove a dirty worktree. Call `cleanup` only after the delegated worktree is clean, or after its changes are preserved elsewhere. Discarding delegated changes always requires explicit user authorization.

## Takeover procedure

Codex supervises automatically: observe, interrupt on drift, and correct with a followup packet. `result` reports `correctionLimitReached` when the run has consumed the two automatic corrections (see [acp-supervision.md](acp-supervision.md)).

When the threshold is reached or the task repeatedly fails validation:

1. Codex ends automatic correction and reports the state to the user: what DeepSeek produced, the trace summary, and why it is not acceptable.
2. Ask the user how to proceed: authorize another delegated round, adjust scope, or have Codex take over substantive execution.
3. Codex takes over substantive execution only after the user approves. Under takeover Codex may edit the primary checkout or the delegated worktree directly and owns the full lifecycle through final validation.

Codex never silently takes over a delegated task, discards delegated work, or presents unverified DeepSeek output as final.
