# @better-compact/pi

> Edited and maintained by Claude. Provided as-is.

Better Compact for [Oh My Pi](https://omp.sh) and [pi](https://pi.dev).

It prunes old tool output and reasoning, keeps recent work intact, stores removed context on disk, and summarizes assistant turns only when needed.

## Install

### Oh My Pi

Requires version 0.3.0 or newer.

```bash
omp plugin install @better-compact/pi
omp plugin doctor
```

### pi

```bash
pi install npm:@better-compact/pi
```

### Local development

```bash
pnpm build
omp plugin install ./packages/pi
```

OMP links the local directory, so later builds are used without reinstalling.

Install the package through one source only. Do not combine a plugin install with a manual drop-in.

## Commands

| Command                                         | OMP | pi  | Action               |
| ----------------------------------------------- | :-: | :-: | -------------------- |
| `/better-compact`                               | yes | yes | Compact now          |
| `/better-compact-report`                        | yes | no  | Show the active plan |
| `/better-compact-settings`                      | yes | yes | Open settings        |
| `/better-compact-preset <light\|moderate\|max>` | yes | yes | Change the preset    |

OMP commits `/better-compact` through its normal compaction lifecycle. pi stores a plan that starts on the next request.

## Presets

| Preset     | Trigger | Target | Recent tool budget |
| ---------- | ------: | -----: | -----------------: |
| `light`    |     85% |    35% |         40k tokens |
| `moderate` |     75% |    25% |         30k tokens |
| `max`      |     60% |    15% |         12k tokens |

The trigger starts a pruning pass. The target is the desired context size after the pass.

## Configuration

Create `<agent-dir>/better-compact.json`:

```json
{
    "automatic": true,
    "preset": "moderate",
    "summaryEffort": "inherit"
}
```

OMP reads the global file only. pi also reads a trusted project override from `.pi/better-compact.json`.

### OMP compaction strategy

Use one of these OMP strategies:

```yaml
compaction:
    strategy: snapcompact
```

- `snapcompact` and `context-full` call Better Compact directly.
- `handoff` and `shake` run their OMP mechanism first, then call Better Compact on fallback.
- `off` disables compaction.

### pi native compaction

pi cannot accept a custom compaction result. Disable its native compaction if Better Compact should be the only context reducer:

```json
{
    "compaction": {
        "enabled": false
    }
}
```

## Behavior

### Oh My Pi

Better Compact runs at two points:

1. The `context` hook applies a virtual pruning plan to outgoing requests.
2. The `session_before_compact` hook supplies OMP's committed compaction result.

OMP keeps control of compaction timing, retry, rollback, headroom checks, continuation, and provider history. Better Compact supplies the compacted context.

The committed context contains:

- user turns kept as written;
- dropped tool calls reduced to short action stubs;
- selected assistant runs replaced by summaries;
- a reference to the raw transcript on disk;
- the recent tail unchanged.

OMP uses its native result only when Better Compact cannot produce a valid whole-turn boundary.

### pi

Better Compact stores a branch-local plan and applies it to outgoing requests. The plan survives resume and forks when the stored prefix still matches the live branch.

## Files

Transcripts are written under the host session directory:

```text
<session-dir>/better-compact/<session-id>/<range-hash>.md
```

Configuration is stored at:

```text
<agent-dir>/better-compact.json
```

Plans are stored as `better-compact-plan` custom session entries.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @better-compact/pi typecheck
pnpm --filter @better-compact/pi test
pnpm --filter @better-compact/pi build
pnpm --filter @better-compact/pi smoke:omp
```

`smoke:omp` loads the built OMP artifact against the real host runtime and exercises request pruning and committed compaction.

## Architecture

One npm package ships two entrypoints:

| Host | Entry               | Manifest         |
| ---- | ------------------- | ---------------- |
| OMP  | `dist/omp.js`       | `omp.extensions` |
| pi   | `dist/extension.js` | `pi.extensions`  |

OMP prefers the `omp` manifest. pi reads the `pi` manifest. Each bundle imports only its host package scope.

Most code is shared:

```text
src/
├── runtime.ts       config, plans, pruning, summaries, widget state
├── codec.ts         shared pi-family codec
├── messages.ts      shared message model
├── ownership.ts     one active instance per session
├── plan-store.ts    branch-local plan persistence
├── config.ts        config loading and writing
├── transcripts.ts   transcript storage
├── tui/             report, settings, widget
├── extension.ts     pi host wiring
├── omp.ts           OMP host wiring and compaction hook
└── omp/             OMP conventions and summary transport
```

### Pruning order

1. Supersede repeated reads and remove stale failed-tool inputs.
2. Replace old tool calls and results with short action stubs.
3. Remove old reasoning if more space is needed.
4. Remove remaining old tool traffic if more space is needed.
5. Collapse selected assistant runs and summarize them.
6. Replace the old prefix with a rolling summary as a last resort.

Tool calls and results are paired before pruning. The latest OMP todo state is preserved when its tool result leaves the request.

A range hash validates each stored plan before replay. Prefix edits invalidate it. Tail growth reuses it until the context crosses the trigger again.

## License

AGPL-3.0-or-later
