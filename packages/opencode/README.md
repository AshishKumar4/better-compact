# Better Compact for OpenCode

> Edited and maintained by Claude. Provided as-is.

Staged context pruning for OpenCode 1.17.13 and newer.

## Install

```bash
opencode plugin better-compact --global
```

Restart OpenCode after installation.

The installer updates:

```text
~/.config/opencode/opencode.json
~/.config/opencode/tui.json
```

JSONC files are preserved when present.

## Commands

| Command                    | Action                 |
| -------------------------- | ---------------------- |
| `/better-compact`          | Run Better Compact now |
| `/better-compact context`  | Show context usage     |
| `/better-compact stats`    | Show the active plan   |
| `/better-compact help`     | List commands          |
| `/better-compact-settings` | Open settings          |

## Configuration

Better Compact reads these files in order:

1. `~/.config/opencode/better-compact.jsonc` or `.json`
2. `$OPENCODE_CONFIG_DIR/better-compact.jsonc` or `.json`
3. `.opencode/better-compact.jsonc` or `.json`

Project settings override global settings.

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/AshishKumar4/better-compact/master/packages/opencode/better-compact.schema.json",
    "enabled": true,
    "compaction": {
        "automatic": true,
        "preset": "light",
        "summaryEffort": "inherit",
    },
}
```

| Preset     | Trigger | Target | Recent tool budget |
| ---------- | ------: | -----: | -----------------: |
| `light`    |     85% |    35% |         40k tokens |
| `moderate` |     75% |    25% |         30k tokens |
| `max`      |     60% |    15% |         12k tokens |

Changes made in `/better-compact-settings` apply to later runs without restarting OpenCode.

## Upgrade

Use an explicit version to force a fresh OpenCode package cache entry:

```bash
opencode plugin better-compact@0.2.6 --global
```

If the plugin is missing after a failed or stale install, clear its cache and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/better-compact*
```

## Uninstall

Remove `better-compact` from the `plugin` arrays in:

```text
~/.config/opencode/opencode.json
~/.config/opencode/tui.json
```

Restart OpenCode.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter better-compact typecheck
pnpm --filter better-compact test
pnpm --filter better-compact build
pnpm --filter better-compact check:package
```

Use the checkout directly:

```json
{
    "plugin": ["file:///path/to/better-compact/packages/opencode/index.ts"]
}
```

Add the TUI entry to `~/.config/opencode/tui.json`:

```json
{
    "plugin": ["file:///path/to/better-compact/packages/opencode/tui.tsx"]
}
```

## Architecture

OpenCode runs Better Compact through two bundled entrypoints:

```text
dist/index.js   server hooks and pruning runtime
dist/tui.js     commands, settings, reports, progress UI
```

The server applies a virtual plan to each outgoing request. OpenCode session history remains unchanged.

The pruning order is:

1. Remove loaded skill text.
2. Supersede repeated reads and remove stale failed-tool inputs.
3. Replace old tool calls and results with action stubs.
4. Remove old reasoning if more space is needed.
5. Remove remaining old tool traffic if more space is needed.
6. Collapse selected assistant runs and summarize them.
7. Use a rolling prefix summary as a last resort.

Raw history for each planned range is stored under:

```text
.opencode/better-compact/sessions/<session-id>/<range-hash>.md
```

The model receives a reference to that file. Plans are range-hashed and replayed until prefix edits or context regrowth require a new plan.

## License

AGPL-3.0-or-later
