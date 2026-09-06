# Delegation

## Who does what

DeepSeek is the substantive execution owner: it plans its own steps inside the delegated worktree, runs tools, streams its complete observable ACP process, and returns a proposed result. Codex is the control-plane owner: it scopes the task, prepares the packet, supervises every observable ACP event, decides when to interrupt or correct, reviews the uncommitted diff, verifies evidence, and runs the final checks. Codex never lets delegated output bypass review.

## When to delegate

Use this skill for bounded implementation or analysis in a Git repository when DeepSeek execution plus Codex supervision adds value. Confirm the current project is a Git repository and read the project's instructions before preparing a packet.

## Task packet

A packet is a JSON object with six required fields. String arrays may be empty when a category does not apply.

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

Packets without the optional fields below run exactly as in v0.1.

### Optional: evidenceRequirements

```json
{
  "evidenceRequirements": {
    "required": true,
    "kinds": ["fact", "citation", "image"]
  }
}
```

When present, `required` must be a boolean and `kinds` must be a subset of `fact`, `citation`, `image`. Absent, or `required: false`, means evidence is not required. A required-evidence job runs only in ACP mode; the controller rejects a headless spawn for it.

## Modes

- **ACP (default):** persistent session, full observable event trace, interrupt and correction, optional evidence. Use for implementation, supervision, or follow-up work.
- **Headless:** bounded one-shot analysis with no session, no interrupts, and no evidence. Select it explicitly with `--mode headless`.

## Worktree isolation

Every job gets a detached worktree of the repository at `HEAD`. Delegated edits stay in that worktree and never touch the primary checkout. The controller rejects permission requests that mutate anything outside the worktree, except the job's exact evidence file when evidence is required.

## Before you spawn

1. Inspect the affected code and read project instructions.
2. Prepare the packet with all six fields plus `evidenceRequirements` only when the task must be proven.
3. Choose ACP for implementation or follow-up work; choose headless only for a bounded one-shot analysis.
4. Keep the packet self-contained. Include only what DeepSeek needs; never the conversation transcript.
