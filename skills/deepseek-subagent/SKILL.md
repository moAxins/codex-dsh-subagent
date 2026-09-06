---
name: deepseek-subagent
description: "Delegate bounded coding or analysis tasks to DeepSeek Harness as a supervised subagent. Use when Codex should give DeepSeek a structured task packet, isolate implementation in a detached Git worktree, observe the full ACP event trace, interrupt or correct the run, require verifiable evidence, and review the resulting uncommitted diff. Also supports explicit $deepseek-subagent invocation. Requires a Git repository for implementation jobs."
---

# DeepSeek Subagent

Delegate a well-scoped task to DeepSeek Harness. DeepSeek owns substantive execution inside a detached Git worktree. Codex owns the control plane: it plans, supervises the observable ACP trace, reviews the diff, verifies evidence, and performs final validation before presenting results.

## Responsibilities

- **DeepSeek (executor):** implements the task packet in the delegated worktree, exposes its complete observable ACP process, and returns proposed work.
- **Codex (controller):** prepares the plan, supervises the ACP trace, interrupts or corrects drift, reviews and validates the outcome, and reports only verified results.

## Before delegating

Read [delegation.md](references/delegation.md) to prepare a task packet, choose ACP or headless mode, and decide whether the task requires verifiable evidence. Do not send the conversation transcript.

## Controller operations

Run `node <skill-dir>/scripts/dsh-subagent.mjs <operation> ...`. The controller returns JSON.

```text
spawn     --repo <git-repo> --mode acp|headless --task <task.json> [--timeout-ms <n>]
wait      --job <job-id> [--after <sequence>] [--timeout-ms <n>]
followup  --job <job-id> --task <task.json>
interrupt --job <job-id>
result    --job <job-id>
cleanup   --job <job-id>
```

Read [protocol.md](references/protocol.md) for the task schema, states, event model, trace semantics, evidence schema, and limits. At most three jobs may run concurrently; followups count toward a two-correction automatic-supervision threshold.

## Supervision loop

1. `spawn` the job and retain `jobId`, `worktreePath`, and `evidencePath`.
2. `wait` with `--after` set to the last returned `nextAfter`; read every observable ACP event.
3. `interrupt` when the run departs from the packet; after it settles, `followup` with a correction packet.
4. `result` when the run reaches a terminal or idle state, then review the diff and evidence.
5. `cleanup` only after the delegated worktree is clean or its changes are preserved.

The controller refuses to remove a dirty worktree. Discarding delegated changes requires the user's explicit authorization.

Read [acp-supervision.md](references/acp-supervision.md) for the wait/event contract, correction threshold, and permission model, and [evidence-verification.md](references/evidence-verification.md) for evidence status and schema v1 validation.

## Review and hand back

Treat DeepSeek output as proposed work until you verify it. Read [review-validation.md](references/review-validation.md) for diff review, final checks, and the user-approved takeover procedure.

## Harness discovery

The controller uses the first valid source in this order:

1. `dsh` on `PATH`
2. the source checkout named by `DEEPSEEK_HARNESS_ROOT`
3. `%CODEX_HOME%/deepseek-subagent/config.json` or `~/.codex/deepseek-subagent/config.json`

Read [configuration.md](references/configuration.md) when discovery fails or a source checkout needs configuration.
