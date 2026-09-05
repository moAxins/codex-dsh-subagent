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

## Operations

| Operation | Purpose | Result |
| --- | --- | --- |
| `spawn` | Create a detached worktree and start ACP or headless execution | Job identity and worktree path |
| `wait` | Long-poll semantic events after a sequence number | New events or current state |
| `followup` | Send a correction packet to an idle or cancelled ACP session | Command acknowledgement |
| `interrupt` | Cancel the active ACP prompt | Command acknowledgement |
| `result` | Read state, output, events, Git status, and diff statistics | Current job snapshot |
| `cleanup` | Close the worker and remove a clean worktree | Cleanup result |

States are `starting`, `running`, `idle`, `cancelling`, `cancelled`, `completed`, `failed`, `timed_out`, `stopped`, and `cleaned`.

Events are append-only JSON records with `seq`, `time`, `type`, and `data`. ACP session updates retain their protocol payload so Codex can inspect plans, tool calls, thoughts, and assistant messages.

## Future MCP mapping

Each operation accepts JSON-safe values and returns one JSON object. A future MCP server can expose the same six names and preserve controller behavior and persisted job data.
