# Better Compact for Claude Code

<p align="center">
  <img src="https://raw.githubusercontent.com/AshishKumar4/Better-Compact/master/assets/readme/hero.svg" alt="Better Compact staged context pruning." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@better-compact/cli"><img src="https://img.shields.io/npm/v/%40better-compact%2Fcli?style=flat-square&label=CLI" alt="CLI npm version"></a>
  <img src="https://img.shields.io/badge/command-%2Fbetter--compact%3Acompact-818CF8?style=flat-square" alt="/better-compact:compact">
</p>

<p align="center"><sub>Edited and maintained by Claude. Provided as-is.</sub></p>

Claude Code slash command for the Better Compact CLI.

## Install

Install the CLI:

```bash
npm install -g @better-compact/cli
```

Add this repository as a Claude Code marketplace:

```bash
claude plugin marketplace add AshishKumar4/better-compact
claude plugin install better-compact@better-compact
```

## Use

Launch Claude Code through the wrapper:

```bash
better-compact claude --run
```

In a long session:

```text
/better-compact:compact
```

Exit with Ctrl-D. The wrapper compacts the closed session and reopens it.

Without the wrapper, the command prints the one-shot command to run after exit:

```bash
better-compact claude <session-id> --resume
```

## Other CLI modes

```bash
better-compact claude <session-id> --keep-tokens 40000
better-compact claude <session-id> --from-backup
better-compact claude <session-id> --aggressive
```

See [the CLI README](../cli/README.md) for all options.

## Legacy cleanup

Remove an old local-proxy configuration with:

```bash
better-compact install claude-code
```

The command is a no-op on a fresh installation.

## Architecture

The plugin does not edit the live session. `/better-compact:compact` writes a queue marker for the current session and asks the user to exit.

`better-compact claude --run` checks the queue after Claude Code exits, compacts the transcript through the CLI, then reopens the same session.

Claude Code rebuilds its context state from the transcript on resume. This is why compaction runs after exit instead of through a request hook.

## License

AGPL-3.0-or-later
