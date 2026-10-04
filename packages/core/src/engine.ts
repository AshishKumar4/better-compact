import {
    buildPlan,
    replayPlanSnapshot,
    transformTurns,
    type BuildPlanInputs,
    type LadderSpec,
} from "./ladder.js"
import { attachmentCodec, attachmentKey } from "./attachments.js"
import type { Turn } from "./ir.js"
import {
    toPlanSnapshot,
    type BoundaryContextPlan,
    type BoundarySummaryJob,
    type PlanSnapshot,
} from "./plan.js"
import type { EnginePorts, Logger } from "./ports.js"
import { writeTranscript } from "./transcript.js"

export type ProcessResult = (
    | { outcome: "unchanged" }
    | { outcome: "replayed"; turns: Turn[] }
    | { outcome: "planned"; turns: Turn[]; plan: BoundaryContextPlan }
) & { needsNativeCompaction?: boolean }

export interface Engine {
    process(request: {
        bypassSummaries?: boolean | (() => boolean)
        sessionKey: string
        turns: Turn[]
        contextLimit?: number
        triggerRatio?: number
        targetRatio?: number
        recentToolResultBudgetTokens?: number
        providerReportedTokens?: number
        tailBudgetTokens?: { floor: number; ceiling: number }
        summariesAllowed?: boolean
        prefixSummaryAllowed?: boolean
        collapsePercent?: number
        force?: boolean
        // Side-model summary results for the automatic path. When a
        // fresh plan queues summary jobs, the engine runs them and rebuilds
        // the plan with the accepted summaries before persisting it.
        summarize?: (jobs: BoundarySummaryJob[]) => Promise<Record<string, string>>
    }): Promise<ProcessResult>
}

// The boundary-time transform: replay the cached plan when it still holds,
// otherwise discard it and build, persist, and apply a fresh one.
export function createEngine(spec: LadderSpec, ports: EnginePorts): Engine {
    return {
        async process({
            bypassSummaries: bypassOption,
            sessionKey,
            turns,
            contextLimit,
            triggerRatio,
            targetRatio,
            recentToolResultBudgetTokens,
            providerReportedTokens,
            tailBudgetTokens,
            summariesAllowed,
            prefixSummaryAllowed,
            collapsePercent,
            force,
            summarize,
        }) {
            const readBypass = () =>
                typeof bypassOption === "function" ? bypassOption() : bypassOption
            let staleSnapshotCleared = false
            let priorPlan: PlanSnapshot | undefined
            const cached = await ports.plans.load(sessionKey)
            const bypassSummaries = readBypass()
            if (cached && cached.sessionId === sessionKey) {
                const replayed = force
                    ? null
                    : replayPlanSnapshot(turns, cached, spec, { bypassSummaries })
                if (replayed)
                    return {
                        outcome: "replayed",
                        turns: replayed,
                        ...(bypassSummaries
                            ? {
                                  needsNativeCompaction:
                                      attachmentCodec(spec.codec, spec.attachments).estimateTurns(
                                          replayed,
                                      ) +
                                          (cached.overheadTokens ?? 0) >
                                      cached.targetTokens,
                              }
                            : {}),
                    }
                staleSnapshotCleared = true
                priorPlan = cached
            }

            const inputs: BuildPlanInputs = {
                bypassSummaries,
                contextLimit,
                triggerRatio,
                targetRatio,
                recentToolResultBudgetTokens,
                providerReportedTokens,
                tailBudgetTokens,
                summariesAllowed,
                prefixSummaryAllowed,
                collapsePercent,
                force,
                priorPlan,
                sessionKey,
                citablePath: ports.transcripts.citablePath,
            }
            let plan = await preparePlan(turns, inputs, spec, ports.logger)
            if (!plan) {
                if (staleSnapshotCleared) await ports.plans.save(sessionKey, null)
                return { outcome: "unchanged" }
            }
            if (summarize && !readBypass() && plan.summaryJobs.length > 0) {
                try {
                    const assistantSummaries = await summarize(plan.summaryJobs)
                    if (Object.keys(assistantSummaries).length > 0) {
                        plan =
                            buildPlan(
                                turns,
                                {
                                    ...inputs,
                                    bypassSummaries: readBypass(),
                                    attachmentLinks: plan.attachmentLinks,
                                    priorPlan: toPlanSnapshot(plan),
                                    assistantSummaries,
                                },
                                spec,
                            ) ?? plan
                    }
                } catch (error) {
                    ports.logger.warn("Summary scheduling failed; using deterministic fallback", {
                        sessionId: sessionKey,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }

            await writeTranscript(plan, {
                transcripts: ports.transcripts,
                logger: ports.logger,
                codec: spec.codec,
            })
            if (readBypass() && !plan.bypassSummaries) {
                plan = buildPlan(
                    turns,
                    { ...inputs, bypassSummaries: true, priorPlan: toPlanSnapshot(plan) },
                    spec,
                )
                if (!plan) {
                    await ports.plans.save(sessionKey, null)
                    return { outcome: "unchanged" }
                }
            }
            await ports.plans.save(sessionKey, toPlanSnapshot(plan))
            if (readBypass() && !plan.bypassSummaries) {
                plan = buildPlan(
                    turns,
                    { ...inputs, bypassSummaries: true, priorPlan: toPlanSnapshot(plan) },
                    spec,
                )
                await ports.plans.save(sessionKey, plan ? toPlanSnapshot(plan) : null)
                if (!plan) return { outcome: "unchanged" }
            }
            const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
            ports.logger.info("Applied Better Compact staged pruning", {
                sessionId: plan.sessionId,
                beforeTokens: plan.beforeTokens,
                afterPruneTokens: plan.afterPruneTokens,
                transcript: plan.transcript.relativePath,
                stages: plan.stages.map((stage) => stage.name),
            })
            return {
                outcome: "planned",
                turns: transformed,
                plan,
                ...(plan.bypassSummaries
                    ? { needsNativeCompaction: plan.needsNativeCompaction }
                    : {}),
            }
        },
    }
}

/** Await host-owned storage before any attachment is removed from a request. */
export async function preparePlan(
    turns: Turn[],
    inputs: BuildPlanInputs,
    spec: LadderSpec,
    logger: Logger,
): Promise<BoundaryContextPlan | null> {
    const plan = buildPlan(turns, inputs, spec)
    const policy = spec.attachments
    if (!plan || !policy || !plan.attachmentJobs?.length) return plan
    const links = { ...plan.attachmentLinks }
    for (const job of plan.attachmentJobs) {
        const item = turns
            .find((turn) => turn.key === job.turnKey)
            ?.items.find((item) => item.key === job.itemKey)
        if (!item) continue
        try {
            const link = await policy.store(job.attachment, item, job)
            if (link?.trim()) links[attachmentKey(job, job.attachment)] = link
        } catch (error) {
            logger.warn("Attachment storage failed; keeping the original", {
                turnKey: job.turnKey,
                itemKey: job.itemKey,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
    return buildPlan(turns, { ...inputs, attachmentLinks: links }, spec)
}
