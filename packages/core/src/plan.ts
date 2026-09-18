import type { Turn } from "./ir"

export type BoundaryStageName =
    | "reasoning"
    | "skills"
    | "supersede-reads"
    | "purge-error-inputs"
    | "tools-old"
    | "tools-remaining"
    | "assistant-runs"
    | "prefix-summary"

export interface BoundaryStageReport {
    name: BoundaryStageName
    label: string
    beforeTokens: number
    afterTokens: number
    clearedTokens: number
    changedMessages: number
    changedParts: number
    status: "applied" | "skipped" | "target-met" | "failed"
}

export interface BoundarySummaryJob {
    key: string
    rangeStartMessageId: string
    rangeEndMessageId: string
    transcriptRelativePath: string
    prompt: string
}

export interface BoundaryTranscriptArtifact {
    relativePath: string
    absolutePath?: string
    content: string
    messageIds: string[]
    turns?: Turn[]
}

export interface RawTailItemBoundary {
    itemKey: string
    side: "before" | "after"
}

export interface BoundaryContextOptions {
    contextLimit?: number
    triggerRatio?: number
    targetRatio?: number
    minTailMessages?: number
    minTailUserTurns?: number
    recentToolResultBudgetTokens?: number
    force?: boolean
    assistantSummaries?: Record<string, string>
    prefixSummary?: string
    providerReportedTokens?: number
    /**
     * Token budget for the raw tail, expressed as a floor/ceiling pair. When
     * provided, the whole-turn count-based tail is refined by tokens: the tail
     * keeps at least `floor` tokens (snapped back to a user-turn boundary) and
     * at most `ceiling` tokens (snapped forward to a turn boundary, preferring
     * user turns). Turns are never split by the budget.
     */
    tailBudgetTokens?: { floor: number; ceiling: number }
    /**
     * Whether the planner may queue side-model summary jobs. `false` keeps the
     * deterministic collapse: assistant runs still fold into their preview
     * plus transcript pointer, they just never get an LLM-written body.
     * Defaults to true.
     */
    summariesAllowed?: boolean
    /**
     * Ceiling on how much of the prefix one pass may collapse into assistant
     * summaries, as a percentage of its collapsible turns. Omitted leaves the
     * pass uncapped.
     */
    collapsePercent?: number
    /**
     * Whether the last-resort prefix summary may run when pruning alone cannot
     * reach the trigger. `false` leaves `requiresCustomCompaction` unset and
     * lets the caller decide between a rewrite-only or declined answer.
     * Defaults to true.
     */
    prefixSummaryAllowed?: boolean
    // The snapshot this plan replaces. Replacement plans treat what the
    // prior plan already pruned as a monotonic floor: applied stages stay
    // applied, tool results the model already lost are not resurrected,
    // paid-for assistant summaries are reused, and custom compaction stays
    // sticky. A prefix summary carries over unless the boundary advanced.
    priorPlan?: PlanSnapshot
}

export interface BoundaryContextPlan {
    sessionId: string
    rangeHash: string
    contextLimit: number
    beforeTokens: number
    afterPruneTokens: number
    overheadTokens: number
    triggerTokens: number
    targetTokens: number
    rawTailStartIndex: number
    rawTailStartMessageId: string
    rawTailItemBoundary?: RawTailItemBoundary
    requiresCustomCompaction: boolean
    preservedToolCallIds: string[]
    transcript: BoundaryTranscriptArtifact
    stages: BoundaryStageReport[]
    summaryJobs: BoundarySummaryJob[]
    assistantSummaryKeys: string[]
    assistantSummaries: Record<string, string>
    prefixSummary?: string
}

// The durable, replayable subset of a plan. Field shapes are a persistence
// surface: snapshots written by earlier releases must keep loading.
export interface PlanSnapshot {
    sessionId: string
    rangeHash: string
    contextLimit: number
    rawTailStartMessageId: string
    // Absent for a whole-turn boundary. Partial boundaries record the exact
    // item before or after which raw context begins.
    rawTailItemBoundary?: RawTailItemBoundary
    transcriptRelativePath: string
    beforeTokens: number
    afterPruneTokens: number
    // Optional: absent in plans persisted before overhead tracking existed.
    overheadTokens?: number
    triggerTokens: number
    targetTokens: number
    requiresCustomCompaction: boolean
    preservedToolCallIds?: string[]
    assistantSummaryKeys?: string[]
    assistantSummaries?: Record<string, string>
    prefixSummary?: string
    stages?: Array<{
        name: string
        label: string
        beforeTokens: number
        afterTokens: number
        clearedTokens: number
        changedMessages: number
        changedParts: number
        status: string
    }>
    createdAt: number
}

export function toPlanSnapshot(plan: BoundaryContextPlan): PlanSnapshot {
    return {
        sessionId: plan.sessionId,
        rangeHash: plan.rangeHash,
        contextLimit: plan.contextLimit,
        rawTailStartMessageId: plan.rawTailStartMessageId,
        rawTailItemBoundary: plan.rawTailItemBoundary,
        transcriptRelativePath: plan.transcript.relativePath,
        beforeTokens: plan.beforeTokens,
        afterPruneTokens: plan.afterPruneTokens,
        overheadTokens: plan.overheadTokens,
        triggerTokens: plan.triggerTokens,
        targetTokens: plan.targetTokens,
        requiresCustomCompaction: plan.requiresCustomCompaction,
        preservedToolCallIds: plan.preservedToolCallIds,
        assistantSummaryKeys: plan.assistantSummaryKeys,
        assistantSummaries: plan.assistantSummaries,
        prefixSummary: plan.prefixSummary,
        stages: plan.stages,
        createdAt: Date.now(),
    }
}
