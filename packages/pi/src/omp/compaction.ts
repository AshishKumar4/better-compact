import {
    transformTurns,
    type BoundaryContextPlan,
    type Item,
    type LadderSpec,
    type Turn,
} from "@better-compact/core"
import { piCodec, rewriteTurn, type PiMessage } from "../codec"

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
 * Dead-band on the tokens a rewrite actually frees from the journal. Under
 * this, rewriting entries is churn that cannot move the host's threshold, so
 * Better Compact declines and the host's own method answers instead.
 */
export const COMPACTION_NO_PROGRESS_TOKENS = 4_096

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
    { kind: "compact"; firstKeptEntryId: string } | { kind: "decline"; reason: string }

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

/**
 * The durable-history answer the `session_before_compact` rewrite seam carries:
 * per kept entry, a replacement message body. The entry keeps its id, role and
 * position — only its body shrinks — which is exactly what the host persists.
 */
export interface RewriteEntry {
    entryId: string
    message: PiMessage
}

/**
 * What the `session_before_compact` handler returns.
 *
 * - `rewrite` alone: every kept entry stays where it is with a reduced body;
 *   the host settles the pass with no compaction boundary.
 * - `rewrite` + `compaction`: the rewrite lands first, then the boundary is
 *   committed over the already-pruned branch (the last-resort prefix summary).
 * - `undefined`: Better Compact declines — the rewrite frees too little to
 *   move the host's threshold, or nothing message-shaped changed.
 */
export interface CompactionAnswer {
    rewrite?: RewriteEntry[]
    compaction?: {
        summary: string
        firstKeptEntryId: string
    }
    /** Tokens the rewrite frees from the journal, on the codec's scale. */
    tokensFreed: number
}

/**
 * Compose the handler answer for one plan: the in-place rewrite plus, when the
 * ladder declared the last-resort prefix summary, the durable boundary on top.
 *
 * The dead-band is measured on the rewrite itself rather than on the plan's
 * projected numbers: a collapsed run's members stay in the journal as stubs,
 * so the projection over-counts what the host actually reclaims. A boundary
 * that cannot be named (the plan split a turn) leaves the rewrite alone as the
 * answer, which is the only durable shape a split boundary has.
 */
export function buildCompactionAnswer(
    input: CompactionDecisionInput,
    spec: LadderSpec,
): CompactionAnswer | undefined {
    const { plan } = input
    if (!plan) return undefined

    const rewrite = rewriteEntriesForPlan(plan, input.turns, input.branchEntries, spec)
    if (rewrite.tokensFreed < COMPACTION_NO_PROGRESS_TOKENS) return undefined
    const answer: CompactionAnswer = { rewrite: rewrite.entries, tokensFreed: rewrite.tokensFreed }

    if (plan.requiresCustomCompaction) {
        const decision = decideCompaction(input)
        const summary =
            decision.kind === "compact" && formatDurableCompaction(plan, input.turns, spec)
        if (decision.kind === "compact" && summary) {
            answer.compaction = { summary, firstKeptEntryId: decision.firstKeptEntryId }
        }
    }
    return answer
}

/**
 * Map a plan onto per-entry rewrites: transform the turns, then align each
 * source message with what the plan made of it. Only changed message entries
 * earn a rewrite and user-role entries are never touched. A message the plan
 * emptied entirely is reduced to a one-line stub so its tokens are actually
 * freed — rewriting cannot remove an entry, only shrink it — and message kinds
 * the stub cannot express stay as they are.
 */
export function rewriteEntriesForPlan(
    plan: BoundaryContextPlan,
    turns: Turn[],
    branchEntries: readonly BranchEntry[],
    spec: LadderSpec,
): { entries: RewriteEntry[]; tokensFreed: number } {
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const transformedByHandle = new Map<unknown, Turn>()
    for (const turn of transformed) {
        if (turn.handle !== undefined) transformedByHandle.set(turn.handle, turn)
    }

    const entryIdByMessage = new Map<unknown, string>()
    for (const entry of branchEntries) {
        if (entry.type === "message" && entry.message !== undefined) {
            entryIdByMessage.set(entry.message, entry.id)
        }
    }

    const stubNote = `[Compacted by Better Compact — raw history: ${plan.transcript.relativePath}]`
    const entries: RewriteEntry[] = []
    let tokensFreed = 0
    for (const turn of turns) {
        const next = turn.handle === undefined ? undefined : transformedByHandle.get(turn.handle)
        // A turn the plan dropped entirely (a collapsed run's later members, a
        // headless tool-only turn) has no surviving item to rebuild against;
        // every message it carried is stubbed.
        const pairs =
            next === undefined
                ? ((turn.handle as PiMessage[] | undefined) ?? []).map((source) => ({
                      source,
                      rewritten: null,
                  }))
                : rewriteTurn(next)
        for (const pair of pairs) {
            if (pair.source.role === "user") continue
            const entryId = entryIdByMessage.get(pair.source)
            if (entryId === undefined) continue
            const rewritten =
                pair.rewritten ?? stubMessage(pair.source, stubNote, next?.items ?? [])
            if (JSON.stringify(rewritten) === JSON.stringify(pair.source)) continue
            tokensFreed += messageTokens(pair.source) - messageTokens(rewritten)
            entries.push({ entryId, message: rewritten })
        }
    }
    return { entries, tokensFreed: Math.max(0, tokensFreed) }
}

function messageTokens(message: PiMessage): number {
    return piCodec.estimateTurns(piCodec.encode([message]))
}

/**
 * The one-line replacement for a message the plan emptied. Only the kinds
 * that carry the bulk of a session shrink — assistant text, tool results and
 * shell output; everything else is returned unchanged and therefore skipped.
 * An assistant's tool calls stay, emptied of their arguments, so the results
 * that follow keep a call to pair with.
 */
function stubMessage(source: PiMessage, note: string, items: readonly Item[]): PiMessage {
    switch (source.role) {
        case "assistant":
            return {
                ...source,
                content: [
                    { type: "text", text: note },
                    ...source.content.flatMap((block) =>
                        block.type === "toolCall" ? [{ ...block, arguments: {} }] : [],
                    ),
                ],
            }
        case "toolResult": {
            // When the call's stub survived inside the rewritten turn, the
            // result keeps that one-liner instead of the generic note.
            const stub = items.find(
                (item) =>
                    item.kind === "synthetic" &&
                    (item.key.startsWith(`${source.toolCallId}_better_compact_text_`) ||
                        item.key.startsWith(`${source.toolCallId}#`)),
            )
            return {
                ...source,
                content: [{ type: "text", text: stub?.kind === "synthetic" ? stub.text : note }],
            }
        }
        case "bashExecution":
        case "pythonExecution":
            return { ...source, output: note, meta: undefined }
        default:
            return source
    }
}
