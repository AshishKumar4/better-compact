# @better-compact/core

<p align="center">
  <img src="https://raw.githubusercontent.com/AshishKumar4/Better-Compact/master/assets/readme/hero.svg" alt="Better Compact staged context pruning." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@better-compact/core"><img src="https://img.shields.io/npm/v/%40better-compact%2Fcore?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@better-compact/core"><img src="https://img.shields.io/npm/dm/%40better-compact%2Fcore?style=flat-square" alt="monthly downloads"></a>
</p>

<p align="center"><sub>Edited and maintained by Claude. Provided as-is.</sub></p>

Shared context-pruning engine for Better Compact adapters.

## Install

```bash
npm install @better-compact/core
```

The OpenCode, OMP, pi, and Claude Code packages bundle or consume this engine through their platform adapters.

## Public API

Everything is exported from [`src/index.ts`](src/index.ts).

| Module                             | Main exports                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| [`ir.ts`](src/ir.ts)               | `Turn`, `Item`, `Codec`, `CodecOps`, `Conventions`                                |
| [`ladder.ts`](src/ladder.ts)       | `createEngine`, `buildPlan`, `transformTurns`, `replayPlanSnapshot`, `LadderSpec` |
| [`stages.ts`](src/stages.ts)       | pruning stages and `Stage`                                                        |
| [`plan.ts`](src/plan.ts)           | `BoundaryContextPlan`, `PlanSnapshot`, `toPlanSnapshot`                           |
| [`ports.ts`](src/ports.ts)         | `EnginePorts`, `TranscriptStore`, `PlanStore`, `Summarizer`, `Logger`             |
| [`summarize.ts`](src/summarize.ts) | `createSummaryScheduler`                                                          |
| [`profiles.ts`](src/profiles.ts)   | presets and config types                                                          |
| [`identity.ts`](src/identity.ts)   | stable keys and range hashes                                                      |

## Adapter setup

An adapter supplies:

1. a native message codec;
2. platform conventions for tools, skills, todos, and notes;
3. an ordered stage array;
4. stores for plans and transcripts;
5. a logger;
6. a summarizer transport when side-model summaries are enabled.

```ts
import { createEngine } from "@better-compact/core"

const engine = createEngine(spec, ports)
const result = await engine.process({
    sessionKey,
    turns,
    contextLimit,
    providerReportedTokens,
})
```

`result.outcome` is one of:

- `unchanged`: no active plan and no pruning needed;
- `replayed`: a valid stored plan was applied;
- `planned`: a new plan was built and stored.

## Development

```bash
pnpm --filter @better-compact/core typecheck
pnpm --filter @better-compact/core test
pnpm --filter @better-compact/core build
```

## Architecture

The IR is a view over native messages. Each unchanged item keeps an opaque handle to its original payload. Synthetic pruning output has no native handle.

```text
Native[]
   │ encode
   ▼
Turn[] and Item[]
   │ plan and transform
   ▼
Turn[] and Item[]
   │ decode
   ▼
Native[]
```

Tool calls and results become one item. Pruning that item removes both native records.

The engine compares estimated usage with the configured trigger. Provider-reported usage can supply a higher floor. A fresh plan selects a raw tail, applies stages in order, writes a transcript, stores a snapshot, and returns transformed turns.

Stored plans contain the boundary, range hash, applied stages, summaries, and transcript path. Replay validates the old prefix before applying the plan. Regrowth can reuse the prior plan as a monotonic floor, so removed content is not restored by a later pass.

The default adapters use this stage order:

1. skill pruning where supported;
2. superseded reads;
3. stale failed-tool inputs;
4. old tools;
5. reasoning;
6. remaining tools;
7. assistant-run summaries;
8. rolling prefix summary when required.

The summary scheduler deduplicates jobs, limits concurrency, validates the summary schema, and stops repeated failures for a cooling period. The adapter supplies the model call.

## License

AGPL-3.0-or-later
