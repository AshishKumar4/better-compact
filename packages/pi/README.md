# @better-compact/pi

This is my adapter for the pi family — [pi](https://pi.dev) and
[Oh My Pi](https://omp.sh) — built on the staged context-pruning ladder in
[`@better-compact/core`](../core). Instead of letting a long session hit compaction and lose detail
to one lossy summary, it prunes what the model no longer needs (old tool outputs first, then old
thinking, then whole assistant runs), writes the raw history to a transcript file the agent can read
back, and leaves the recent tail byte-for-byte untouched.

One package, two host entrypoints:

| Host     | Entry               | Manifest key     |
| -------- | ------------------- | ---------------- |
| pi       | `dist/extension.js` | `pi.extensions`  |
| Oh My Pi | `dist/omp.js`       | `omp.extensions` |

Oh My Pi prefers `omp` over `pi`, so installing the package into either host selects the right
artifact. The two bundles never mix package scopes: the pi entry imports `@earendil-works/*` and the
Oh My Pi entry imports `@oh-my-pi/*`. Oh My Pi's legacy-pi compatibility shim would resolve the
`@earendil-works` specifiers too, but the native adapter has no reason to depend on that layer.

## Install

pi, as a package:

```bash
pi install npm:@better-compact/pi
```

Oh My Pi, as a plugin:

```bash
omp plugin install @better-compact/pi
```

Or as a manual drop-in for either host: build with `pnpm build`, then place the artifact where the
host looks for extensions — `~/.pi/agent/extensions/` for pi, or a directory under
`~/.omp/agent/extensions/` containing `omp.js` and a `package.json` declaring
`"omp": { "extensions": ["./omp.js"] }` for Oh My Pi.

## How it works

### Every request

Both hosts call the extension's `context` handler before each provider request. When the estimated
context crosses the trigger (85% of the model window on the default `light` preset), Better Compact
builds a pruning plan, applies it to the outgoing messages, and returns the replacement. Below the
trigger it does nothing.

- A tool call and its tool-result message are one unit: pruning removes both, keeping the
  conversation valid.
- Pruned ranges are archived under the host's session directory
  (`<session dir>/better-compact/<session id>/<hash>.md`) and a reference message tells the model
  where to look instead of guessing.
- The plan persists as a `better-compact-plan` custom entry, so it survives restarts, resume and
  forks — a fork replays the plan its own branch recorded.
- Collapsed assistant runs are re-summarized in the background with a real model call (the session's
  current model, through the host's own credential resolution); the better summaries apply from the
  next request.

### Automatic compaction (Oh My Pi)

On Oh My Pi, Better Compact **owns compaction** rather than coexisting with it. Every run the host
decides on — manual `/better-compact`, the pre-prompt and mid-turn thresholds, idle maintenance, and
overflow recovery — is answered through `session_before_compact`, and the native summarizer never
runs.

What gets persisted is the ladder's own output, not a prose summary. The host's durable shape is one
summary string plus a contiguous tail, so Better Compact serializes its compacted prefix into that
slot: user turns preserved as written, dropped tool calls reduced to one-line stubs, long assistant
runs replaced by the summaries it paid a side model for, and a pointer to the raw transcript on disk.
The recent tail stays untouched, and the host persists, rebuilds context, rebases accounting and
resets dependent state exactly as it would for its own summarizer.

A run is handed back to the native summarizer only when Better Compact genuinely has no answer: no
plan for the branch, a branch with no addressable message entry, or a plan whose boundary falls
mid-turn (the host can only cut at a whole turn, so committing that boundary would leave the context
larger than the plan promised and fail the host's own headroom check).

Everything else stays the host's job. Oh My Pi keeps ownership of when to compact, the failed-turn
rollback, model fallbacks, headroom checks, retry and continuation, and the provider-history reset —
Better Compact replaces only the decision about _what_ the compacted context should be.

One thing it deliberately does **not** do is decline a compaction because pruning alone would have
been enough. `{cancel:true}` looks like the prune-before-summarize answer, but Oh My Pi anchors its
threshold on stored history — which request-level pruning cannot move — so a declined run is
re-entered on the next turn and at every mid-turn tool boundary, each time re-planning the whole
branch and rendering "maintenance cancelled" in the status line. Durably pruning without summarizing
needs a host seam that can persist non-contiguous history; until Oh My Pi has one, request-level
pruning between compactions is where that part of the ladder lives.

`compaction.strategy` should be `context-full` or `snapcompact`. Under `handoff` and `shake` the host
runs its own path first and only falls back to this hook, so ownership is intermittent; under `off`
maintenance never runs at all. The extension warns once instead of changing your configuration.

### Automatic compaction (pi)

pi has no equivalent hook, so the extension does not own compaction there. It prunes each request
and warns once per session if native compaction fires. I recommend disabling pi's native compaction
so it doesn't rewrite history that Better Compact is already pruning non-destructively:

```json
{
    "compaction": { "enabled": false }
}
```

in `~/.pi/agent/settings.json`.

## Commands and UI

`/better-compact` — compact now. On Oh My Pi this runs the host's own compaction so the result is
committed, accounted and persisted by the same path automatic compaction uses. On pi it forces a
prune plan that applies from the next request.

`/better-compact-report` (Oh My Pi) — what the active plan is keeping out of each request: before,
after and target context meters, and every stage with the tokens it freed and how many messages it
touched. In the TUI this is an overlay; elsewhere it arrives as a notification.

`/better-compact-settings` — an interactive panel for automatic compaction, compaction strength and
summary effort, built on the host's own `SettingsList` so it matches every other settings surface.
Changes are written to `<agent-dir>/better-compact.json`.

`/better-compact-preset <light|moderate|max>` — the non-interactive equivalent for RPC and headless
runs, where overlays are unavailable.

While a plan is active, a one-line widget sits above the editor with the current context meter and
how much the plan is keeping out of each request. It clears itself when there is nothing to report,
so it never costs you a line for free.

## Configuration

The extension reads `<agent-dir>/better-compact.json` at session start:

```json
{
    "preset": "moderate"
}
```

On pi, a trusted project can override it field by field with `./.pi/better-compact.json`. Oh My Pi
exposes no project-trust query to extensions, so only the global file is read there — a project file
would be executable policy with nothing vouching for the working tree.

With no file present, the light preset remains the default.

## Verifying a change

```bash
pnpm test          # host-free unit tests: decision policy, boundary mapping, codec
pnpm build
pnpm smoke:omp     # loads dist/omp.js against the real Oh My Pi runtime (needs Bun)
```

`pnpm smoke:omp` is the one that matters for host compatibility: it drives the built artifact with
the events Oh My Pi emits and reconstructs context through the host's own `buildSessionContext`, so
a missing or changed host API fails there rather than in a live session.

## Limitations

- Token counts are a chars/4 estimate over the host's own model serialization, not provider-reported
  usage. On Oh My Pi the request path additionally passes the host's reported usage into the plan
  when it is available.
- The durable shape a host compaction can persist is one summary plus a contiguous tail. The staged
  ladder's non-contiguous output (stubbed tool pairs interleaved with retained messages) lives in
  the request transform, and is re-derived from raw history on every request rather than persisted.
- pi's transcript renderer truncates very large tool inputs and results at 20k characters, so its
  archive is a faithful record rather than an exact byte-for-byte copy.
