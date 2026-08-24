# Better Compact

<p align="center">
  <img src="assets/readme/hero.svg" alt="Better Compact turns full agent context into a smaller working set through staged pruning." width="100%">
</p>

<p align="center">
  <a href="https://github.com/AshishKumar4/Better-Compact/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/AshishKumar4/Better-Compact/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/better-compact"><img src="https://img.shields.io/npm/v/better-compact?style=flat-square&label=OpenCode" alt="OpenCode package version"></a>
  <a href="https://www.npmjs.com/package/@better-compact/pi"><img src="https://img.shields.io/npm/v/%40better-compact%2Fpi?style=flat-square&label=OMP%20%2B%20pi" alt="OMP and pi package version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-818CF8?style=flat-square" alt="AGPL-3.0-or-later"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#how-does-it-work">How it works</a> ·
  <a href="#architecture">Architecture</a>
</p>

<p align="center"><sub>Edited and maintained by Claude. Provided as-is.</sub></p>

Most coding agents wait until the context is full, then replace the old conversation with one summary. Exact tool output, failed attempts, user wording, and decision history disappear together.

Better Compact reduces context in stages. It removes stale tool traffic and old reasoning first, summarizes selected assistant runs only when needed, and keeps the raw history on disk for recall.

| Plain compaction                             | Better Compact                                            |
| -------------------------------------------- | --------------------------------------------------------- |
| One summary replaces the old conversation    | Each pruning stage runs only when needed                  |
| Tool calls and failures lose their structure | Removed tools leave action stubs with status and errors   |
| Exact old output is unavailable              | Raw history stays on disk with a model-readable reference |
| Every compaction changes the prefix          | Validated plans replay the same stable prefix             |

## Install

### Oh My Pi

Requires `@better-compact/pi` 0.3.0 or newer.

```bash
omp plugin install @better-compact/pi
omp plugin doctor
```

Better Compact handles OMP's manual and automatic compaction. OMP still controls when compaction runs, along with retry, rollback, and accounting.

### pi

```bash
pi install npm:@better-compact/pi
```

### OpenCode

Requires OpenCode 1.17.13 or newer.

```bash
opencode plugin better-compact --global
```

Restart OpenCode after installation.

### Claude Code

Install the CLI:

```bash
npm install -g @better-compact/cli
```

Compact a closed session and reopen it:

```bash
better-compact claude <session-id> --resume
```

Install the companion plugin for `/better-compact:compact`:

```bash
claude plugin marketplace add AshishKumar4/better-compact
claude plugin install better-compact@better-compact
```

Launch Claude Code through the wrapper to compact and reopen automatically after exit:

```bash
better-compact claude --run
```

## Commands

| Platform          | Command                                         | Action                            |
| ----------------- | ----------------------------------------------- | --------------------------------- |
| OMP, pi, OpenCode | `/better-compact`                               | Run Better Compact now            |
| OMP               | `/better-compact-report`                        | Show the active plan              |
| OMP, pi, OpenCode | `/better-compact-settings`                      | Open settings                     |
| OMP, pi           | `/better-compact-preset <light\|moderate\|max>` | Change the preset                 |
| OpenCode          | `/better-compact context`                       | Show context usage                |
| OpenCode          | `/better-compact stats`                         | Show the active plan              |
| Claude Code       | `/better-compact:compact`                       | Queue compaction for session exit |

## Presets

| Preset     | Trigger | Target | Recent tool budget |
| ---------- | ------: | -----: | -----------------: |
| `light`    |     85% |    35% |         40k tokens |
| `moderate` |     75% |    25% |         30k tokens |
| `max`      |     60% |    15% |         12k tokens |

The trigger starts a pruning pass. The target is the desired context size after the pass.

For pi and OMP, create `<agent-dir>/better-compact.json`:

```json
{
    "automatic": true,
    "preset": "moderate",
    "summaryEffort": "inherit"
}
```

pi also reads a trusted project override from `.pi/better-compact.json`. OMP reads the global file only.

OpenCode uses `~/.config/opencode/better-compact.jsonc` and `.opencode/better-compact.jsonc`. See [the OpenCode package README](packages/opencode/README.md) for its full schema.

## How does it work?

<p align="center">
  <img src="assets/readme/how-it-works.svg" alt="Inspect, prune, summarize, and preserve." width="100%">
</p>

1. **Inspect.** Estimate the request, validate any stored plan, and choose a raw tail that must stay unchanged.
2. **Prune.** Supersede repeated reads, stub old tool traffic, and remove old reasoning until the target fits.
3. **Summarize.** Collapse selected assistant runs with a side-model call when pruning alone is not enough.
4. **Preserve.** Write the affected raw history to disk, insert a reference, and replay the same plan on later requests.

Better Compact escalates one stage at a time. A light pass can stop after pruning old tools. A heavy pass can continue through reasoning, assistant-run summaries, and a rolling prefix summary.

## Packages

| Package                                                                      | Purpose                 |
| ---------------------------------------------------------------------------- | ----------------------- |
| [`better-compact`](https://www.npmjs.com/package/better-compact)             | OpenCode plugin         |
| [`@better-compact/pi`](https://www.npmjs.com/package/@better-compact/pi)     | OMP and pi extension    |
| [`@better-compact/cli`](https://www.npmjs.com/package/@better-compact/cli)   | Claude Code session CLI |
| [`@better-compact/core`](https://www.npmjs.com/package/@better-compact/core) | Shared pruning engine   |

Platform-specific instructions:

- [OpenCode](packages/opencode/README.md)
- [OMP and pi](packages/pi/README.md)
- [Claude Code CLI](packages/cli/README.md)
- [Claude Code plugin](packages/claude-code/README.md)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
```

Run the OMP host smoke test after building:

```bash
pnpm --filter @better-compact/pi smoke:omp
```

Workspace layout:

```text
packages/
├── core/         shared engine and message IR
├── opencode/     OpenCode server and TUI plugins
├── pi/           OMP and pi entrypoints
├── cli/          Claude Code CLI
└── claude-code/  Claude Code slash command plugin
```

See [RELEASING.md](RELEASING.md) for release tags and npm publishing.

## Architecture

Each adapter converts its native messages to a shared turn/item model, runs the pruning engine, then converts the result back to the host format.

```text
native messages
      │
      ▼
platform codec
      │
      ▼
turns and items
      │
      ▼
pruning plan
      │
      ▼
platform codec
      │
      ▼
outgoing context
```

Native payloads stay attached to IR items as opaque handles. Unchanged content is returned without reconstruction. Tool calls and tool results are paired into one item, so pruning cannot leave an orphaned result.

### Pruning order

1. Remove loaded skill text where the host exposes it in-band.
2. Supersede repeated reads and remove stale failed-tool inputs.
3. Replace old tool calls and results with short action stubs.
4. Remove old reasoning if more space is needed.
5. Remove remaining old tool traffic if more space is needed.
6. Collapse selected assistant runs and summarize them with a side-model call.
7. Replace the old prefix with a rolling summary as a last resort.

The engine keeps a raw tail of recent user turns and tool work. It also preserves the latest in-band todo state where the host exposes one.

### Plans and recall

A plan records the compacted range, tail boundary, applied stages, summaries, token counts, and transcript path. A range hash validates the plan before replay. Appending a small tail reuses the same transformed prefix. Editing the old prefix invalidates it. Large regrowth builds a new plan without restoring content removed by the previous plan.

Before applying a plan, Better Compact writes the affected raw history to disk and inserts a reference into the model context. The model can read that file when exact output or wording is needed.

### Host integration

| Host        | Application model                          | Durable history               |
| ----------- | ------------------------------------------ | ----------------------------- |
| OpenCode    | Virtual plan on each request               | Unchanged                     |
| OMP         | Request plan plus custom compaction result | OMP writes a compaction entry |
| pi          | Virtual plan on each request               | Unchanged                     |
| Claude Code | Closed-session rewrite                     | Backed up before replacement  |

The OMP and pi adapters share the runtime, codec, config, plan store, ownership logic, transcript storage, and TUI components. Their entrypoints contain only host APIs and behavior that differs between the two hosts.

## Upstream

Better Compact started as a fork of [OpenCode Dynamic Context Pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), originally published as `@tarquinen/opencode-dcp`.

## License

AGPL-3.0-or-later
