import {
    transformTurns,
    type BoundaryContextPlan,
    type LadderSpec,
    type Turn,
} from "@better-compact/core"

/**
 * Messages are compared by reference only, so their type is deliberately
 * opaque here. Both hosts' unions and the shared structural model satisfy it,
 * and nothing in this module can start reading fields by accident.
 */
export type MessageRef = object

/**
 * The slice of a session entry this module reads. `buildSessionContext` pushes
 * `entry.message` by reference for message entries, which is what makes the
 * mapping below possible without re-deriving host emission rules.
 */
export interface BranchEntry {
    type: string
    id: string
    message?: MessageRef
}

/**
 * Why Oh My Pi asked to compact.
 *
 * `auto_compaction_start` fires before `session_before_compact` and carries the
 * reason; a hook invocation with no preceding start event is the manual
 * `/compact` (or `ctx.compact()`) path. The compact event itself does not carry
 * the reason, so the adapter correlates the two.
 */
export type CompactionTrigger = "threshold" | "overflow" | "idle" | "incomplete" | "manual"

/**
 * What Better Compact does with one compaction request.
 *
 * - `compact`: the plan's summary and boundary become a durable host compaction.
 * - `decline`: Better Compact has no answer, so the native summarizer runs.
 *
 * There is deliberately no "prune instead" answer. `{cancel: true}` looks like
 * one, but Oh My Pi anchors its threshold decision on the *stored* branch —
 * `checkCompaction` and `maintainContextMidRun` both floor the provider number
 * with `#estimateStoredContextTokens()` — which request-level pruning cannot
 * move. So a declined threshold run is re-entered on every following turn and at
 * every mid-turn tool boundary, each time re-planning the whole branch and
 * rendering "Auto context-full maintenance cancelled" in the status line.
 * Durably pruning without summarizing needs a host seam that can persist
 * non-contiguous history; until then, one committed compaction per host request
 * is the honest answer.
 */
export type CompactionDecision =
    | { kind: "compact"; firstKeptEntryId: string }
    | { kind: "decline"; reason: string }

export interface CompactionDecisionInput {
    trigger: CompactionTrigger
    /** The plan the ladder built over the durable branch context, if any. */
    plan: BoundaryContextPlan | null
    turns: Turn[]
    messages: readonly MessageRef[]
    branchEntries: readonly BranchEntry[]
}

/**
 * Whether Better Compact can answer this compaction, kept free of host calls and
 * IO so it can be exercised directly.
 */
export function decideCompaction(input: CompactionDecisionInput): CompactionDecision {
    const { plan } = input
    if (!plan) return { kind: "decline", reason: "no plan for this context" }

    // A mid-turn boundary has no durable representation. Mapping it back to the
    // entry that owns the turn would reinstate the oversized turn the plan split
    // off, so the committed context would be larger than `afterPruneTokens`
    // promised — and the committed result is exactly what the host's
    // post-compaction headroom and retry-fit checks measure. The host's own
    // `findCutPoint` only ever cuts at a whole turn, so hand this back.
    if (plan.rawTailItemBoundary !== undefined) {
        return { kind: "decline", reason: "plan boundary splits a turn" }
    }

    const firstKeptEntryId = firstKeptEntryIdForPlan(
        plan,
        input.turns,
        input.messages,
        input.branchEntries,
    )
    if (!firstKeptEntryId) return { kind: "decline", reason: "no durable boundary entry" }
    return { kind: "compact", firstKeptEntryId }
}

/**
 * Render the ladder's compacted prefix as the text Oh My Pi will persist.
 *
 * The host's durable shape is one summary string plus a contiguous tail, so the
 * prefix has to arrive as text. Serializing the *transformed* prefix — rather
 * than reaching for `plan.prefixSummary` — is what makes the assistant-run
 * summaries this compaction paid for actually land: they live in the collapsed
 * run items, alongside the one-line tool stubs and the user turns the ladder
 * preserved verbatim. `plan.prefixSummary` is only populated when the ladder had
 * to fall back to a rolling digest, and core carries a prior plan's digest
 * forward whenever the boundary is unchanged, so reading it would persist the
 * older deterministic text and silently discard every summary just fetched.
 *
 * Oh My Pi wraps the result in its own `<summary>` envelope when it rebuilds
 * context, so this carries no envelope of its own.
 */
export function formatDurableCompaction(
    plan: BoundaryContextPlan,
    turns: Turn[],
    spec: LadderSpec,
): string {
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const tailKeys = new Set(turns.slice(plan.rawTailStartIndex).map((turn) => turn.key))

    const body: string[] = []
    for (const turn of transformed) {
        if (tailKeys.has(turn.key)) continue
        const rendered = turn.items
            .map((item) => spec.codec.transcriptLine(item).trim())
            .filter(Boolean)
        if (rendered.length === 0) continue
        body.push(`### ${turn.role === "user" ? "User" : "Assistant"}\n${rendered.join("\n")}`)
    }
    if (body.length === 0) return ""

    return [
        "[Better Compact context]",
        "Older context was compacted by pruning rather than replaced by a single summary: tool calls that were dropped leave one-line stubs, long assistant runs are summarized, and user turns are preserved as written. The raw history is on disk at the reference below — read it instead of guessing.",
        "",
        ...body,
        "",
        `## Reference Files\n- "${plan.transcript.relativePath}"`,
    ].join("\n")
}

/**
 * Map a plan's raw-tail boundary back to the session entry that must be kept
 * first.
 *
 * `buildSessionContext` pushes `entry.message` by reference for `message`
 * entries, so the boundary turn's first message identifies its entry directly.
 * When the boundary lands on a synthesized message (a custom message, a branch
 * or compaction summary) there is no entry to name, so the search walks
 * backwards to the nearest real message entry. That keeps *more* raw history
 * than the plan asked for, which duplicates a little context instead of losing
 * any — the same reason a partial mid-turn boundary rounds out to whole turns
 * here while the request transform still applies it exactly.
 *
 * Returns `null` when no entry can be identified, which the caller treats as
 * "decline the override" rather than guessing a boundary.
 */
export function firstKeptEntryIdForPlan(
    plan: BoundaryContextPlan,
    turns: Turn[],
    messages: readonly MessageRef[],
    branchEntries: readonly BranchEntry[],
): string | null {
    const entryIdByMessage = new Map<unknown, string>()
    for (const entry of branchEntries) {
        if (entry.type === "message") entryIdByMessage.set(entry.message, entry.id)
    }
    if (entryIdByMessage.size === 0) return null

    const boundaryTurn = turns[plan.rawTailStartIndex]
    const boundaryMessage = (boundaryTurn?.handle as MessageRef[] | undefined)?.[0]
    const boundaryIndex = boundaryMessage ? messages.indexOf(boundaryMessage) : -1
    if (boundaryIndex < 0) return null

    for (let index = boundaryIndex; index >= 0; index--) {
        const entryId = entryIdByMessage.get(messages[index])
        if (entryId !== undefined) return entryId
    }
    return null
}
