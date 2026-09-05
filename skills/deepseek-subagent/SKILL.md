---
name: deepseek-subagent
description: "Delegate bounded coding or analysis tasks to DeepSeek Harness as a supervised subagent. Use when Codex should give DeepSeek a structured task packet, isolate implementation in a detached Git worktree, observe ACP progress, interrupt or correct the run, and review the resulting uncommitted diff. Also supports explicit $deepseek-subagent invocation. Requires a Git repository for implementation jobs."
---

# DeepSeek Subagent

Use the bundled controller to delegate a well-scoped task while Codex remains responsible for planning, supervision, review, and verification.

## Before spawning

1. Confirm the current project is a Git repository.
2. Read the relevant project instructions and inspect the affected code.
3. Prepare a JSON task packet with `goal`, `plan`, `constraints`, `acceptanceCriteria`, `relevantPaths`, and `requiredChecks`.
4. Choose `acp` for implementation, persistent supervision, or follow-up work. Choose `headless` for bounded one-shot analysis.

Do not send the conversation transcript. Include only the context DeepSeek needs to complete the task.

## Controller

Run `node <skill-dir>/scripts/dsh-subagent.mjs <operation> ...`. The controller returns JSON.

```text
spawn     --repo <git-repo> --mode acp|headless --task <task.json> [--timeout-ms <n>]
wait      --job <job-id> [--after <sequence>] [--timeout-ms <n>]
followup  --job <job-id> --task <task.json>
interrupt --job <job-id>
result    --job <job-id>
cleanup   --job <job-id>
```

At most three jobs may run concurrently. See [protocol.md](references/protocol.md) for the task schema, states, event model, and future MCP mapping.

## Supervision loop

1. Call `spawn` and retain the returned `jobId` and `worktreePath`.
2. Call `wait` with the most recent event sequence.
3. Inspect ACP plan, thought, tool-call, permission, and message events.
4. Call `interrupt` if the work departs from the task packet or project constraints.
5. After cancellation settles, call `followup` with a correction packet. The ACP session and worktree remain the same.
6. Call `result` when the run becomes idle, completed, cancelled, failed, or timed out.
7. Review the diff in the returned worktree. Selectively apply acceptable changes to the primary checkout and run the required checks yourself.
8. Call `cleanup` only after the delegated worktree is clean or its changes have been preserved elsewhere.

The controller refuses to remove a dirty worktree. Discarding delegated changes requires the user's explicit authorization.

## Harness discovery

The controller uses the first valid source in this order:

1. `dsh` on `PATH`
2. the source checkout named by `DEEPSEEK_HARNESS_ROOT`
3. `%CODEX_HOME%/deepseek-subagent/config.json` or `~/.codex/deepseek-subagent/config.json`

Read [configuration.md](references/configuration.md) when discovery fails or a local source checkout needs configuration.

## Boundaries

- Use this skill only inside a Git repository for implementation work.
- Treat DeepSeek output as proposed work until Codex reviews and verifies it.
- Keep edits inside the delegated worktree. Permission requests for mutation outside it are rejected.
- Preserve dirty worktrees for inspection.
- Report DeepSeek's result, the reviewed diff, checks Codex ran, and any remaining risk to the user.
