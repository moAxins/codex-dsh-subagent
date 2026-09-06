# ACP supervision

## Reading the full observable trace

Codex supervises the ACP session by polling `wait` and reading every event the protocol exposes. The observable thought process is exactly the set of ACP session updates Harness streams: `plan`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk`, and `usage_update`. "Complete thought process" always means every observable ACP event, never hidden internal reasoning. A valid turn may emit any subset of these kinds; do not require all six.

The controller persists each event as an append-only record with a monotonically increasing `seq`. `wait` returns:

- `latestSeq`: the highest persisted event sequence at the poll snapshot.
- `events`: records with `seq` greater than `--after`.
- `nextAfter`: the last `seq` actually returned in `events`.

Pass `--after <nextAfter>` to the next `wait`. If `latestSeq` is greater than `nextAfter`, call `wait` again to drain the remaining events. `result` returns a deterministic trace summary computed from the persisted records: it is `complete` only when the records are unique and contiguous from seq 1 through the state `eventSeq`, and it reports duplicate, missing, and out-of-order detection plus per-kind observable update counts.

## Supervision loop

1. Call `spawn` and keep `jobId` and `worktreePath`.
2. Call `wait --after <nextAfter>` repeatedly, draining until the run leaves `running`.
3. Inspect plan entries, thought chunks, tool calls and updates, messages, and usage.
4. Call `interrupt` when the work departs from the task packet or project constraints.
5. After the run settles as `cancelled`, call `followup` with a correction packet. The ACP session and worktree stay the same.
6. Call `result` at `idle`, `cancelled`, `completed`, `failed`, or `timed_out`, then review the diff and evidence.

## Correction threshold

The controller reports `correctionCount`, `correctionLimitReached`, and `maxCorrections` on `result`. `maxCorrections` is 2. The threshold governs automatic supervision only: after two corrections Codex stops auto-correcting and escalates to the user. The controller does not reject further `followup` calls, because the user may authorize another delegation round.

## Permission model

The worker answers ACP permission requests itself:

- Read-only tools (`read`, `search`, `fetch`, `think`) are always allowed.
- A mutation must keep every target path inside the delegated worktree.
- When the job requires evidence, exactly one outside path is additionally allowed: the job's `artifacts/evidence.json` file. Nothing else outside the worktree — including the artifacts directory itself — is granted.

Requests outside that scope are answered with `cancelled`, and each decision is recorded as a `permission` event for Codex to audit.

## Timeouts and shutdown

Each prompt runs against the job timeout. On expiry the worker cancels the prompt and marks the job `timed_out`. `cleanup` asks the worker to stop, then removes the worktree only when it is clean; a dirty worktree is preserved and cleanup fails.
