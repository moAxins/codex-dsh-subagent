# Harness configuration

The controller discovers DeepSeek Harness in this order:

1. `dsh` on `PATH`
2. `DEEPSEEK_HARNESS_ROOT`
3. a user configuration file

The user configuration file is `%CODEX_HOME%/deepseek-subagent/config.json` when `CODEX_HOME` is set. Otherwise it is `~/.codex/deepseek-subagent/config.json`.

Use a source checkout:

```json
{
  "harnessRoot": "E:/path/to/deepseek-harness"
}
```

Use a custom installed command:

```json
{
  "command": "C:/path/to/dsh.cmd",
  "args": []
}
```

The source checkout must contain `apps/cli/src/bin.ts`, `node_modules/tsx/dist/loader.mjs`, `tsconfig.json`, and its installed dependencies. The controller passes that `tsconfig.json` to `tsx`, so source imports resolve correctly when Harness runs inside a delegated worktree.
