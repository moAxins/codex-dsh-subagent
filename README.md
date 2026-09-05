# codex-dsh-subagent

`deepseek-subagent` is a Codex skill that delegates structured tasks to DeepSeek Harness. Codex prepares the plan and acceptance criteria, observes ACP events, interrupts or corrects the run, reviews the uncommitted diff, and runs the final checks.

Implementation jobs run in detached Git worktrees. This keeps delegated edits separate from the primary checkout and preserves unfinished work for review.

## Install in Codex

Ask Codex to install the skill from this repository:

```text
$skill-installer install https://github.com/moAxins/codex-dsh-subagent/tree/main/skills/deepseek-subagent
```

Install the controller dependency, then restart Codex:

```powershell
npm install --prefix "$env:USERPROFILE\.codex\skills\deepseek-subagent"
```

## Configure DeepSeek Harness

The controller discovers Harness in this order:

1. `dsh` on `PATH`
2. `DEEPSEEK_HARNESS_ROOT`
3. the Codex user configuration file

For a source checkout, create `%USERPROFILE%\.codex\deepseek-subagent\config.json`:

```json
{
  "harnessRoot": "E:/path/to/deepseek-harness"
}
```

The source checkout must have its dependencies installed. Harness also needs its normal provider credentials and configuration.

## Use

Invoke the skill explicitly:

```text
$deepseek-subagent implement the validated plan in an isolated worktree, monitor the run, and review the diff
```

Codex may also discover the skill automatically when a task benefits from supervised DeepSeek delegation.

The controller exposes six JSON-oriented operations:

```text
spawn  wait  followup  interrupt  result  cleanup
```

ACP mode supports persistent sessions, semantic progress events, cancellation, and follow-up correction. Headless mode handles bounded one-shot analysis. Up to three jobs may run at the same time.

The first release supports Git projects. Cleanup refuses to remove a dirty delegated worktree, so unfinished changes remain available until they are reviewed or explicitly discarded.

## Develop and test

```powershell
npm install
npm run check
```

The test suite uses fake ACP and headless Harness processes. It exercises lifecycle handling, follow-up correction, permission decisions, concurrency, timeouts, detached worktree isolation, and dirty-worktree cleanup protection.

## License

[MIT](LICENSE)
