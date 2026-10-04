# @better-compact/core

<p align="center">
  <img src="https://raw.githubusercontent.com/AshishKumar4/Better-Compact/main/assets/readme/hero.svg" alt="Better Compact staged context pruning." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@better-compact/core"><img src="https://img.shields.io/npm/v/%40better-compact%2Fcore?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@better-compact/core"><img src="https://img.shields.io/npm/dm/%40better-compact%2Fcore?style=flat-square" alt="monthly downloads"></a>
</p>

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
| [`ladder.ts`](src/ladder.ts)       | `buildPlan`, `transformTurns`, `replayPlanSnapshot`, `LadderSpec` |
| [`engine.ts`](src/engine.ts)       | `createEngine`, `preparePlan`, `ProcessResult` |
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

## Attachment offloading

Set `spec.attachments` to an `AttachmentPolicy` to enable the first stage, before tool stubbing.
The policy keeps storage and provider pricing in the host:

- `list(item)` identifies images and files, including those nested inside tool results.
- `estimateTokens(attachment, item)` returns the active provider/model's media cost. Unknown cost returns `undefined`.
- `store(attachment, item, location)` saves the payload and returns a reopenable path or URL. It can be asynchronous.
- `replace(item, attachment, text)` replaces the payload with text, preserving unrelated content and the item's key.

The payload stays in the native item handle; core does not copy it into metadata or choose a storage directory.
Return a link only after the file is durable and the agent can reopen it.
Core passes empty replacement text and emits the link separately, so later summaries cannot truncate the recovery path.
Use a stable attachment ID within each item, and change `policy.key` when the model or retention policy changes.

The stage keeps the protected recent turns and the last two images. `keepRecentImages` changes that count.
Existing compaction archives stay intact. Unpriced attachments, failed writes, and replacements that save no tokens stay unchanged.
User prose stays unchanged; an eligible older attachment becomes a stub such as `[image/png 1280x800 → /workspace/media/image.png]`.
Provider estimates replace the codec's generic media estimate for trigger checks and plan accounting.
The host should use the provider's image sizing rules, not the base64 string's length.

`engine.process()` awaits storage automatically. A host that builds forced plans directly must use `await preparePlan(turns, inputs, spec, logger)`.
`buildPlan()` remains synchronous and performs no storage writes; its `attachmentJobs` describe unresolved work.
Persist plans with `toPlanSnapshot()`. Replay uses saved links without storing the payload again.
Changing the policy key invalidates replay so the new provider's costs are applied.

## Summary bypass

Pass `bypassSummaries: true` to skip assistant-message collapse, preview truncation, and prefix summaries.
This also refuses cached summary plans. `summariesAllowed: false` only disables model calls and is a different option.
For live settings, `engine.process()` accepts a reader: `bypassSummaries: () => settings.bypassSummaries`.
The engine rechecks it after asynchronous work before applying a summary.

When pruning leaves context above the target, `plan.needsNativeCompaction` is true.
`engine.process()` also returns this flag after rebuilding or replaying a prune-only plan.
The host then selects its native compaction method. Core does not invoke a provider or duplicate a host's method order.
The pi, OMP, and OpenCode settings default `bypassSummaries` to true; library callers choose the option explicitly.

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
