import type { BoundaryContextPlan, Turn } from "@better-compact/core"

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
 * - `prune`: the ladder reached its target without summarizing anything, so the
 *   run is declined and the persisted plan keeps shrinking each request.
 * - `compact`: pruning was exhausted; the plan's summary and boundary become a
 *   durable host compaction.
 * - `decline`: Better Compact has no answer, so the native summarizer runs.
 */
export type CompactionDecision =
    | { kind: "prune" }
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
 * Whether a trigger may be answered by pruning alone.
 *
 * `overflow` and `incomplete` are recovery runs: Oh My Pi already has a failed
 * or oversized turn in hand and its retry/rollback path depends on this
 * compaction producing real durable headroom. Declining one wedges the session.
 * `threshold` and `idle` are speculative — request-level pruning can satisfy
 * them without spending a summary, which is the point of pruning first. Manual
 * `/compact` is an explicit instruction to compact, so it is not speculative
 * either.
 */
export function isSpeculativeTrigger(trigger: CompactionTrigger): boolean {
    return trigger === "threshold" || trigger === "idle"
}

/**
 * The prune-before-summarize decision, kept free of host calls and IO so it can
 * be exercised directly.
 *
 * A recovery run reaches this with a plan built at a zero trigger, so its
 * prefix is already summarized and the prune branch is unreachable for it by
 * construction rather than by a second check here.
 */
export function decideCompaction(input: CompactionDecisionInput): CompactionDecision {
    const { plan, trigger } = input
    if (!plan) return { kind: "decline", reason: "no plan for this context" }

    if (!plan.requiresCustomCompaction && isSpeculativeTrigger(trigger)) return { kind: "prune" }

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
 * The durable summary text for a plan that had to summarize its prefix.
 *
 * Mirrors core's own summary turn (`[Context Summary]` + summary + reference
 * block) so the text Oh My Pi persists is the text the ladder would have put
 * in the request. Oh My Pi wraps it in its own `<summary>` envelope when it
 * rebuilds context, so this carries no envelope of its own.
 */
export function formatCompactionSummary(plan: BoundaryContextPlan): string {
    const summary = plan.prefixSummary?.trim()
    if (!summary) return ""
    return [
        "[Context Summary]",
        summary,
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
