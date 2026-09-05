# Controller protocol

## Task packet

```json
{
  "goal": "Concrete outcome",
  "plan": ["Ordered implementation step"],
  "constraints": ["Repository or product constraint"],
  "acceptanceCriteria": ["Observable acceptance condition"],
  "relevantPaths": ["src/example.ts"],
  "requiredChecks": ["npm test"]
}
```

All six fields are required. String arrays may be empty when a category does not apply.

### Optional evidenceRequirements

```json
{
  "evidenceRequirements": {
    "required": true,
    "kinds": ["fact", "citation", "image"]
  }
}
```

`required` is a boolean; `kinds` is a subset of `fact`, `citation`, `image` and defaults to all three when omitted. Absent requirements mean evidence is not required. Evidence-required jobs run only in ACP mode; a headless spawn of such a job is rejected.

## Operations

| Operation | Purpose | Result |
| --- | --- | --- |
| `spawn` | Create a detached worktree, artifacts directory, and start ACP or headless execution | Job identity, worktree path, and evidence path |
| `wait` | Long-poll semantic events after a sequence number | New events plus `latestSeq` and `nextAfter` |
| `followup` | Send a correction packet to an idle or cancelled ACP session | Command acknowledgement |
| `interrupt` | Cancel the active ACP prompt | Command acknowledgement |
| `result` | Read state, output, events, trace summary, evidence, Git status, and diff statistics | Current job snapshot |
| `cleanup` | Close the worker and remove a clean worktree | Cleanup result |

### wait

Returns `events` with `seq` greater than the `--after` argument, `latestSeq` (highest persisted event sequence at the snapshot), and `nextAfter` (last sequence actually returned). Pass `nextAfter` as the next `--after`. When `latestSeq` exceeds `nextAfter`, call `wait` again to drain remaining events. Long-polls up to the timeout, returning earlier on new events or on `idle`, `cancelled`, or terminal states.

### result

Returns the job state plus:

- `events` — the complete event log.
- `trace` — deterministic trace summary (see below).
- `correctionCount`, `correctionLimitReached`, `maxCorrections` — automatic-supervision threshold state.
- `evidenceStatus`, `evidence` — the evidence file status and parsed records.

## States

`starting`, `running`, `idle`, `cancelling`, `cancelled`, `completed`, `failed`, `timed_out`, `stopped`, and `cleaned`.

## Events

Events are append-only JSON records with `seq`, `time`, `type`, and `data`, persisted under the job directory. ACP session updates are recorded verbatim under `type: "acp_update"` with their full protocol payload (`plan`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk`, `usage_update`, or other session updates), so Codex can inspect plans, tool calls, thoughts, and messages exactly as Harness streamed them.

Other event types: `started`, `prompt_started` (with `correction` flag), `prompt_finished`, `prompt_failed`, `permission` (with `toolCall` and `allowed`), `interrupt_requested`, `evidence` (status changes), `completed`, `failed`, `timed_out`, `stopped`.

## Trace summary

`result.trace` is derived deterministically from the persisted events and the state `eventSeq`:

- `complete` — true only when records are unique and contiguous from seq 1 through `eventSeq`.
- `duplicateSeqs`, `missingSeqs`, `outOfOrder` — deterministic anomaly lists.
- `counts` — per-kind counts of observable ACP updates actually captured. Completeness never requires every kind, because a valid turn may omit kinds.
- `corrections` — `{ count, max, limitReached }`. `max` is 2; the limit gates automatic supervision only and does not reject further `followup` calls.

## Evidence schema version 1

The per-job evidence file is `<job dir>/artifacts/evidence.json`:

```json
{ "version": 1, "items": [] }
```

Every item requires `id` (non-empty, unique), `kind` (`fact`, `citation`, or `image`), `selected` (boolean), `useLocations` (string array; selected items need at least one), `claim` (non-empty), `sourceUrl` (absolute http(s)), `publisher` (non-empty), `publishedAt` (non-empty string or null), `verificationNotes` (non-empty), and `uncertainties` (string array). Image items additionally require absolute http(s) `imageUrl` and `caption` (non-empty string or null).

Status is `not_required`, `missing`, `invalid`, or `ready`. A `ready` file is valid schema v1 and contains every kind requested by the task packet. The evidence file is outside the delegated worktree, so it never appears in the repository diff.

## Permissions

The worker answers permission requests itself. Read-only tools always pass. Mutations must keep every target inside the worktree; evidence-required jobs additionally allow exactly the job's `artifacts/evidence.json` file. Anything else is cancelled and recorded as a `permission` event.

## Limits and modes

`MAX_CONCURRENT_JOBS` is 3 and `MAX_CORRECTIONS` is 2, centralized in `scripts/lib/policy.mjs`. Default mode is ACP; headless is allowed only by explicit `--mode headless` and cannot carry evidence requirements.

## Future MCP mapping

Each operation accepts JSON-safe values and returns one JSON object. A future MCP server can expose the same six names and preserve controller behavior and persisted job data.
