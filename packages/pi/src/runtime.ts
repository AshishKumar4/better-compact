import {
    buildPlan,
    COMPACTION_PRESETS,
    createEngine,
    createSummaryScheduler,
    resolveCompactionProfile,
    toPlanSnapshot,
    writeTranscript,
    type BoundaryContextPlan,
    type BuildPlanInputs,
    type Codec,
    type CompactionConfig,
    type CompactionProfile,
    type EnginePorts,
    type LadderSpec,
    type Logger,
    type PlanSnapshot,
    type Summarizer,
    type Turn,
} from "@better-compact/core"
import {
    errorText,
    loadCompactionConfig,
    mergeCompactionConfig,
    updateConfigObject,
} from "./config"
import { createPlanStore, type BranchReader, type PiPlanStore } from "./plan-store"
import { createTranscriptStore } from "./transcripts"
import { createSessionOwnership } from "./ownership"
import type { WidgetState } from "./tui/widget"

/**
 * The surfaces the runtime reports through. Each entrypoint renders these with
 * its own host's components, so the runtime owns *what* to say and never needs
 * to name a host component or theme type.
 */
export interface RuntimeUi {
    notify(message: string, level: "info" | "warning"): void
    setStatus(text: string | undefined): void
    /** `undefined` clears the widget. */
    showWidget(state: WidgetState | undefined): void
}

/**
 * Everything the runtime needs from one pi-family host. `TCtx` is that host's
 * own extension context and `TNative` its own message union, so neither is
 * flattened and no cast is needed at the call sites.
 */
export interface RuntimeHost<TCtx, TNative> {
    codec: Codec<TNative>
    spec: LadderSpec
    logger: Logger
    ui(ctx: TCtx): RuntimeUi
    sessionId(ctx: TCtx): string
    sessionDir(ctx: TCtx): string
    branch(ctx: TCtx): BranchReader
    /** The durable context for the current branch, as the host rebuilds it. */
    durableMessages(ctx: TCtx): TNative[]
    contextWindow(ctx: TCtx): number | undefined
    /** Provider-reported usage, when the host exposes it. */
    providerTokens(ctx: TCtx): number | undefined
    /**
     * Where Better Compact's own config lives. `project` is the host's trust
     * decision made explicit: `null` means the project file is not read at all.
     */
    configPaths(ctx: TCtx): { global: string; project: string | null }
    summarizer(ctx: TCtx, signal?: AbortSignal): Summarizer
    appendEntry(customType: string, data: unknown): void
}

export interface PlannedTransform<TNative> {
    messages: TNative[]
    plan: BoundaryContextPlan | undefined
}

export interface Runtime<TCtx, TNative> {
    readonly config: CompactionConfig
    readonly profile: CompactionProfile
    readonly plans: PiPlanStore
    /** Monotonic per-session-transition token; background work checks it. */
    readonly generation: number
    /** Whether this instance drives the session the event belongs to. */
    owns(ctx: TCtx): boolean
    /** Re-read config and re-adopt the branch's plan. Bumps {@link generation}. */
    rehydrate(ctx: TCtx): Promise<void>
    /** The durable context for the current branch, as the host rebuilds it. */
    durableMessages(ctx: TCtx): TNative[]
    /** The per-request ladder pass. `undefined` leaves the request untouched. */
    transform(ctx: TCtx, messages: TNative[]): Promise<PlannedTransform<TNative> | undefined>
    /** Build a forced plan and write its transcript, without applying it. */
    forcePlan(
        ctx: TCtx,
        messages: TNative[],
        contextLimit: number,
    ): Promise<BoundaryContextPlan | null>
    planInputs(ctx: TCtx, contextLimit: number): BuildPlanInputs
    /** Await this plan's summary jobs, bounded by `signal`, and rebuild with them. */
    summarizeNow(
        ctx: TCtx,
        turns: Turn[],
        inputs: BuildPlanInputs,
        plan: BoundaryContextPlan,
        signal?: AbortSignal,
    ): Promise<BoundaryContextPlan>
    /** Run this plan's summary jobs detached; the plan upgrades for a later request. */
    summarizeLater(ctx: TCtx, turns: Turn[], contextLimit: number, plan: BoundaryContextPlan): void
    /**
     * Merge a config patch into the global file and re-resolve the profile.
     * `savedMessage` is the confirmation to show, so a command can name what it
     * actually changed.
     */
    saveConfig(ctx: TCtx, patch: Partial<CompactionConfig>, savedMessage?: string): Promise<void>
    setWidget(ctx: TCtx, next: Partial<WidgetState>): void
    clearWidget(ctx: TCtx): void
}

export function createRuntime<TCtx, TNative>(
    host: RuntimeHost<TCtx, TNative>,
): Runtime<TCtx, TNative> {
    const { codec, spec, logger } = host
    const plans = createPlanStore((customType, data) => host.appendEntry(customType, data))
    const scheduler = createSummaryScheduler(logger)
    const ownership = createSessionOwnership()

    let config = mergeCompactionConfig()
    let profile = COMPACTION_PRESETS.light
    let widget: WidgetState = { planActive: false }
    let generation = 0
    /** Single-flight: one detached summary upgrade at a time. */
    let summarizing = false
    let duplicateWarned = false

    const transcripts = (ctx: TCtx) => createTranscriptStore(host.sessionDir(ctx))

    const ports = (ctx: TCtx): EnginePorts => ({
        transcripts: transcripts(ctx),
        plans,
        logger,
    })

    const planInputs = (ctx: TCtx, contextLimit: number): BuildPlanInputs => ({
        contextLimit,
        triggerRatio: profile.triggerPercent / 100,
        targetRatio: profile.targetPercent / 100,
        recentToolResultBudgetTokens: profile.recentToolTokens,
        sessionKey: host.sessionId(ctx),
        citablePath: transcripts(ctx).citablePath,
    })

    const setWidget = (ctx: TCtx, next: Partial<WidgetState>): void => {
        widget = { ...widget, ...next }
        // The widget is docked above the editor, so it only earns its line when
        // there is something to say: an active plan or summaries still running.
        const worthShowing = widget.planActive || (widget.summarizing?.total ?? 0) > 0
        host.ui(ctx).showWidget(worthShowing ? widget : undefined)
    }

    return {
        get config() {
            return config
        },
        get profile() {
            return profile
        },
        get generation() {
            return generation
        },
        plans,
        planInputs,
        setWidget,
        durableMessages: (ctx) => host.durableMessages(ctx),

        clearWidget(ctx) {
            widget = { planActive: false }
            host.ui(ctx).showWidget(undefined)
            host.ui(ctx).setStatus(undefined)
        },

        owns(ctx) {
            if (ownership.owns(host.sessionId(ctx))) return true
            if (!duplicateWarned) {
                duplicateWarned = true
                logger.warn(
                    "Better Compact is loaded twice in this session; the duplicate is inert. Install it one way only — as a plugin, a drop-in extension, or an explicit path.",
                )
            }
            return false
        },

        async rehydrate(ctx) {
            generation++
            this.clearWidget(ctx)
            plans.restore(host.branch(ctx))
            const messages = host.durableMessages(ctx)
            if (messages.length > 0) plans.adopt(host.sessionId(ctx), codec.encode(messages))
            const paths = host.configPaths(ctx)
            config = await loadCompactionConfig(logger, paths.global, paths.project)
            profile = resolveCompactionProfile({ compaction: config })
        },

        async transform(ctx, messages) {
            if (!config.automatic) return undefined
            const contextLimit = host.contextWindow(ctx)
            if (!contextLimit || contextLimit <= 0) return undefined

            const sessionKey = host.sessionId(ctx)
            const turns = codec.encode(messages)
            plans.adopt(sessionKey, turns)
            const result = await createEngine(spec, ports(ctx)).process({
                sessionKey,
                turns,
                contextLimit,
                triggerRatio: profile.triggerPercent / 100,
                targetRatio: profile.targetPercent / 100,
                recentToolResultBudgetTokens: profile.recentToolTokens,
                providerReportedTokens: host.providerTokens(ctx),
            })
            if (result.outcome === "unchanged") return undefined

            const plan = result.outcome === "planned" ? result.plan : undefined
            if (plan && plan.summaryJobs.length > 0) {
                this.summarizeLater(ctx, turns, contextLimit, plan)
            }
            setWidget(ctx, {
                planActive: true,
                contextLimit,
                contextTokens: plan?.afterPruneTokens ?? host.providerTokens(ctx),
                prunedTokens: plan
                    ? Math.max(0, plan.beforeTokens - plan.afterPruneTokens)
                    : widget.prunedTokens,
            })
            return { messages: codec.decode(result.turns, messages), plan }
        },

        async forcePlan(ctx, messages, contextLimit) {
            const sessionKey = host.sessionId(ctx)
            const turns = codec.encode(messages)
            plans.adopt(sessionKey, turns)
            const priorPlan = await plans.load(sessionKey)
            const plan = buildPlan(
                turns,
                {
                    ...planInputs(ctx, contextLimit),
                    force: true,
                    priorPlan: priorPlan ?? undefined,
                },
                spec,
            )
            if (!plan) return null
            await writeTranscript(plan, { transcripts: transcripts(ctx), logger, codec })
            return plan
        },

        async summarizeNow(ctx, turns, inputs, plan, signal) {
            if (plan.summaryJobs.length === 0) return plan
            try {
                const summaries = await scheduler.summarize({
                    sessionKey: plan.sessionId,
                    jobs: plan.summaryJobs,
                    summarizer: host.summarizer(ctx, signal),
                    concurrency: profile.summarizerConcurrency,
                })
                if (Object.keys(summaries).length === 0) return plan
                return (
                    buildPlan(
                        turns,
                        {
                            ...inputs,
                            // Keep the boundary and everything already pruned, but
                            // drop the prior digest: core carries it forward on an
                            // unchanged boundary, which would discard the summaries
                            // this rebuild exists to fold in.
                            priorPlan: { ...toPlanSnapshot(plan), prefixSummary: undefined },
                            assistantSummaries: summaries,
                        },
                        spec,
                    ) ?? plan
                )
            } catch (error) {
                logger.warn("Better Compact summaries incomplete", { error: errorText(error) })
                return plan
            }
        },

        summarizeLater(ctx, turns, contextLimit, plan) {
            if (summarizing) return
            summarizing = true
            const startedAt = generation
            void (async () => {
                try {
                    const summaries = await scheduler.summarize({
                        sessionKey: plan.sessionId,
                        jobs: plan.summaryJobs,
                        summarizer: host.summarizer(ctx),
                        concurrency: profile.summarizerConcurrency,
                    })
                    if (Object.keys(summaries).length === 0) return
                    // The session moved (switch, branch, tree, or a committed
                    // compaction) while these ran, so this plan no longer
                    // describes the live branch and must not be written.
                    if (generation !== startedAt) return
                    const upgraded = buildPlan(
                        turns,
                        {
                            ...planInputs(ctx, contextLimit),
                            force: true,
                            priorPlan: toPlanSnapshot(plan),
                            assistantSummaries: { ...plan.assistantSummaries, ...summaries },
                        },
                        spec,
                    )
                    if (upgraded) await plans.save(plan.sessionId, toPlanSnapshot(upgraded))
                } catch (error) {
                    logger.warn("Better Compact summary upgrade failed", {
                        error: errorText(error),
                    })
                } finally {
                    summarizing = false
                }
            })()
        },

        async saveConfig(ctx, patch, savedMessage = "Better Compact settings saved.") {
            const path = host.configPaths(ctx).global
            try {
                await updateConfigObject(path, patch)
                config = mergeCompactionConfig(config, patch)
                profile = resolveCompactionProfile({ compaction: config })
                host.ui(ctx).notify(savedMessage, "info")
            } catch (error) {
                logger.warn("Better Compact settings update failed", {
                    path,
                    error: errorText(error),
                })
                host.ui(ctx).notify(`Better Compact: could not write ${path}.`, "warning")
            }
        },
    }
}

export type { PlanSnapshot }
