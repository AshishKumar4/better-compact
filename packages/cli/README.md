# @better-compact/cli

<p align="center">
  <img src="https://raw.githubusercontent.com/AshishKumar4/Better-Compact/main/assets/readme/hero.svg" alt="Better Compact staged context pruning." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@better-compact/cli"><img src="https://img.shields.io/npm/v/%40better-compact%2Fcli?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@better-compact/cli"><img src="https://img.shields.io/npm/dm/%40better-compact%2Fcli?style=flat-square" alt="monthly downloads"></a>
</p>

<p align="center"><sub>Edited and maintained by Claude. Provided as-is.</sub></p>

On-disk compaction for Claude Code sessions.

## Install

Requires Node.js 22.15 or newer.

```bash
npm install -g @better-compact/cli
```

## Usage

Compact a closed session:

```bash
better-compact claude <session-id>
```

Compact and reopen it:

```bash
better-compact claude <session-id> --resume
```

Run Claude Code through the wrapper:

```bash
better-compact claude --run
```

The wrapper supports the companion plugin's `/better-compact:compact` command. Exit the session after running the command; the wrapper compacts and reopens it.

## Options

| Option                   | Action                                                  |
| ------------------------ | ------------------------------------------------------- |
| `--resume`               | Reopen the session after compaction                     |
| `--run [claude args...]` | Launch Claude Code and handle queued compaction on exit |
| `--keep-tokens <n>`      | Keep a larger or smaller raw tail; default is 25k       |
| `--from-backup`          | Restore original entries before compacting              |
| `--aggressive`           | Write a compact boundary and summary                    |

Examples:

```bash
better-compact claude <session-id> --keep-tokens 40000 --resume
better-compact claude <session-id> --from-backup
better-compact claude <session-id> --aggressive --resume
```

## Companion plugin

Install the Claude Code slash command:

```bash
claude plugin marketplace add AshishKumar4/better-compact
claude plugin install better-compact@better-compact
```

Then launch Claude Code through the wrapper:

```bash
better-compact claude --run
```

Run `/better-compact:compact` in the session, then exit with Ctrl-D.

## Legacy cleanup

Older Better Compact releases used a local proxy. Remove that configuration with:

```bash
better-compact install claude-code
```

On a fresh installation, this command makes no changes.

## Safety

The CLI operates on closed sessions only. Before replacing a transcript, it:

1. checks that the session is not active;
2. writes a backup under `~/.better-compact/claude-backups/`;
3. compacts a structured copy;
4. validates the rewritten transcript;
5. writes a temporary file and renames it into place.

## Behavior

Normal mode keeps every conversation entry. It replaces old tool output and large tool input with short stubs, removes old reasoning, keeps the recent tail, and resets stale input accounting.

`--aggressive` appends Claude Code-compatible compact boundary and summary entries. Old turns leave the active context after resume.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @better-compact/cli typecheck
pnpm --filter @better-compact/cli test
pnpm --filter @better-compact/cli build
```

## Architecture

Claude Code enforces its context limit before sending the model request. It rebuilds that state from session JSONL when a session resumes. Better Compact edits the closed transcript because an outgoing request transform cannot change that client-side state.

The CLI uses the shared Anthropic codec to pair tool calls with results and preserve unknown content. It uses the shared pruning helpers for estimates, tool targets, and boundary selection.

Session lookup, live-process checks, backup recovery, JSONL parsing, usage reset, atomic replacement, and resume arguments remain Claude Code-specific.

## License

AGPL-3.0-or-later
