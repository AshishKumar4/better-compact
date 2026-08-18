import { join } from "node:path"
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
    type CompactionConfig,
    type EnginePorts,
    type Logger,
    type PlanSnapshot,
    type Turn,
} from "@better-compact/core"
import {
    buildSessionContext,
    getAgentDir,
    getSettingsListTheme,
    settings as ompSettings,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
} from "@oh-my-pi/pi-coding-agent"
import { SettingsList } from "@oh-my-pi/pi-tui"
import {
    commandPreset,
    CONFIG_FILE,
    errorText,
    loadCompactionConfig,
    mergeCompactionConfig,
    readConfigObject,
    writeConfigObject,
} from "./config"
import { ompCodec, ompSpec } from "./omp/codec"
import {
    decideCompaction,
    formatDurableCompaction,
    type CompactionTrigger,
} from "./omp/compaction"
import type { OmpAgentMessage } from "./omp/host"
import { createOmpSummarizer } from "./omp/summarizer"
import { createPlanStore } from "./plan-store"
import { createTranscriptStore } from "./transcripts"
import type { HostSettingsUi } from "./tui/host"
import { formatTokens } from "./tui/format"
import { ReportComponent, reportFromSnapshot } from "./tui/report"
import { createSettingsComponent } from "./tui/settings"
import { WidgetComponent, type WidgetState } from "./tui/widget"

/**
 * Oh My Pi runs extension handlers under a 30s timeout
 * (`EXTENSION_HANDLER_TIMEOUT_MS`). A compaction handler that overruns it is
 * discarded and the native summarizer runs instead, so side-model summaries get
 * a deadline with room left for the transcript write and plan rebuild. Missing
 * the deadline is not a failure: the plan already carries core's deterministic
 * prefix summary, so the durable compaction just lands without LLM polish.
 */
const COMPACT_SUMMARY_DEADLINE_MS = 20_000

/**
 * Strategies under which Better Compact does not reliably own compaction.
 *
 * `handoff` and `shake` each run their own path first and only fall back into
 * the context-full body that consults this hook — handoff when it produces no
 * document, shake when it finds nothing eligible to drop — so ownership is
 * intermittent rather than absent. `off` disables maintenance entirely and never
 * reaches the hook at all.
 */
const UNRELIABLE_STRATEGIES: Record<string, string> = {
    handoff: "hands the session off first and only falls back to this hook when it produces no document",
    shake: "drops content inline first and only falls back to this hook when it finds nothing to drop",
    off: "disables context maintenance altogether, so the hook never runs",
}

const logger: Logger = {
    info() {},
    debug() {},
    warn: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
    error: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
}

const settingsUi: HostSettingsUi<SettingsList> = {
    createSettingsList: (items, visibleRows, onChange, onDone) =>
        new SettingsList(items, visibleRows, getSettingsListTheme(), onChange, onDone),
}

export default function betterCompactOmp(pi: ExtensionAPI) {
    const plans = createPlanStore((customType, data) => pi.appendEntry(customType, data))
    const summaryScheduler = createSummaryScheduler(logger)
    let config = mergeCompactionConfig()
    let profile = COMPACTION_PRESETS.light
    let widget: WidgetState = { planActive: false }
    let strategyWarned = false
    /**
     * Bumped by every session transition (start, switch, branch, tree). Detached
     * summary work captures the value it started under and drops its result when
     * it no longer matches, so a plan can never be written onto a branch or
     * session other than the one it was planned for. Session id alone is not
     * enough: same-file tree navigation keeps the id and changes the leaf.
     */
    let generation = 0
    /** Single-flight: one background summary upgrade at a time per session. */
    let summarizing = false
    /**
     * The reason Oh My Pi is compacting. `auto_compaction_start` fires before
     * `session_before_compact`; a compact event with nothing recorded here is
     * the manual `/compact` path.
     */
    let pendingTrigger: CompactionTrigger | undefined

    // The widget is docked above the editor, so it only earns its line when
    // there is something to say: an active plan or summaries still running.
    const updateWidget = (ctx: ExtensionContext, next: Partial<WidgetState>): void => {
        widget = { ...widget, ...next }
        if (!ctx.hasUI) return
        const worthShowing = widget.planActive || (widget.summarizing?.total ?? 0) > 0
        ctx.ui.setWidget(
            "better-compact",
            worthShowing ? (_tui, theme) => new WidgetComponent(theme, widget) : undefined,
            { placement: "aboveEditor" },
        )
    }

    const enginePorts = (ctx: ExtensionContext): EnginePorts => ({
        transcripts: createTranscriptStore(ctx.sessionManager.getSessionDir()),
        plans,
        logger,
    })

    const planInputs = (ctx: ExtensionContext, contextLimit: number): BuildPlanInputs => ({
        contextLimit,
        triggerRatio: profile.triggerPercent / 100,
        targetRatio: profile.targetPercent / 100,
        recentToolResultBudgetTokens: profile.recentToolTokens,
        sessionKey: ctx.sessionManager.getSessionId(),
        citablePath: createTranscriptStore(ctx.sessionManager.getSessionDir()).citablePath,
    })

    /**
     * Rebuild per-session state. Oh My Pi keeps one extension runtime across
     * new/resume/fork/handoff (`session_switch`), branch operations
     * (`session_branch`) and same-file tree navigation (`session_tree`), so every
     * one of those has to land here or the adapter keeps serving the previous
     * branch's plan.
     */
    const rehydrate = async (ctx: ExtensionContext): Promise<void> => {
        generation++
        widget = { planActive: false }
        if (ctx.hasUI) {
            ctx.ui.setWidget("better-compact", undefined, { placement: "aboveEditor" })
            ctx.ui.setStatus("better-compact", undefined)
        }
        pendingTrigger = undefined
        plans.restore(ctx.sessionManager)
        const messages = durableMessages(ctx.sessionManager.getBranch())
        if (messages.length > 0) {
            plans.adopt(ctx.sessionManager.getSessionId(), ompCodec.encode(messages))
        }
        config = await loadCompactionConfig(logger, join(getAgentDir(), CONFIG_FILE), null)
        profile = resolveCompactionProfile({ compaction: config })
        warnUnreachedStrategy(ctx)
    }

    /**
     * Oh My Pi routes `handoff` and `shake` to their own inline paths and `off`
     * disables maintenance, so those strategies never consult the compaction
     * hook and Better Compact would silently not own automatic compaction.
     * Warn once rather than mutating the user's configuration.
     *
     * Reading the setting is best-effort on purpose: `settings.get` throws
     * outright when the host has not initialized `Settings` yet (embedded and
     * test hosts do not), and a diagnostic must never be the reason session
     * rehydration fails.
     */
    const warnUnreachedStrategy = (ctx: ExtensionContext): void => {
        if (strategyWarned) return
        let strategy: string | undefined
        try {
            strategy = ompSettings.get("compaction.strategy")
        } catch {
            return
        }
        const reason = strategy === undefined ? undefined : UNRELIABLE_STRATEGIES[strategy]
        if (!reason) return
        strategyWarned = true
        ctx.ui.notify(
            `Better Compact does not reliably own automatic compaction while compaction.strategy is "${strategy}" — it ${reason}. Set it to "context-full" or "snapcompact".`,
            "warning",
        )
    }

    pi.on("session_start", (_event, ctx) => rehydrate(ctx))
    pi.on("session_switch", (_event, ctx) => rehydrate(ctx))
    pi.on("session_branch", (_event, ctx) => rehydrate(ctx))
    pi.on("session_tree", (_event, ctx) => rehydrate(ctx))

    // A committed compaction rewrote the branch, so any plan built against the
    // old prefix is stale. Rehydrating re-reads the branch and re-adopts only a
    // snapshot that still matches.
    pi.on("session_compact", (_event, ctx) => rehydrate(ctx))

    pi.on("auto_compaction_start", (event) => {
        pendingTrigger = event.reason
    })

    pi.on("auto_compaction_end", () => {
        pendingTrigger = undefined
    })

    pi.on("context", async (event, ctx) => {
        try {
            if (!config.automatic) return
            const usage = ctx.getContextUsage()
            const contextLimit = ctx.model?.contextWindow ?? usage?.contextWindow
            if (!contextLimit || contextLimit <= 0) return
            const sessionKey = ctx.sessionManager.getSessionId()
            const turns = ompCodec.encode(event.messages)
            plans.adopt(sessionKey, turns)
            const result = await createEngine(ompSpec, enginePorts(ctx)).process({
                sessionKey,
                turns,
                contextLimit,
                triggerRatio: profile.triggerPercent / 100,
                targetRatio: profile.targetPercent / 100,
                recentToolResultBudgetTokens: profile.recentToolTokens,
                providerReportedTokens: usage?.tokens,
            })
            if (result.outcome === "unchanged") return
            if (result.outcome === "planned" && result.plan.summaryJobs.length > 0) {
                void upgradePlanWithSummaries(ctx, turns, contextLimit, result.plan)
            }
            const plan = result.outcome === "planned" ? result.plan : undefined
            updateWidget(ctx, {
                planActive: true,
                contextLimit,
                contextTokens: plan?.afterPruneTokens ?? usage?.tokens,
                prunedTokens: plan
                    ? Math.max(0, plan.beforeTokens - plan.afterPruneTokens)
                    : widget.prunedTokens,
            })
            return { messages: ompCodec.decode(result.turns, event.messages) }
        } catch (error) {
            // A failed prune must never break the request; it goes out unpruned.
            logger.error("Better Compact context transform failed", { error: errorText(error) })
        }
    })

    /**
     * Better Compact answers every compaction Oh My Pi decides to run — manual
     * `/compact`, the pre-prompt and mid-turn thresholds, idle maintenance, and
     * overflow recovery.
     *
     * Two answers are possible, and which one applies is the prune-before-
     * summarize decision made by {@link decideCompaction}:
     *
     * - The ladder reached its target by pruning alone. Nothing needs to be
     *   summarized yet, so the run is declined and the persisted plan keeps
     *   shrinking each outgoing request instead.
     * - Pruning was exhausted and the prefix has to go. The ladder's own output
     *   is already one summary turn plus a raw tail, which is exactly the shape
     *   of an Oh My Pi `CompactionResult`, so it is returned as one and the host
     *   persists it, rebuilds context, rebases accounting and resets dependent
     *   state as it would for its own summarizer.
     *
     * Anything unexpected returns nothing, which hands the run back to the
     * native summarizer rather than leaving the session uncompacted.
     */
    pi.on("session_before_compact", async (event, ctx) => {
        const trigger = pendingTrigger ?? "manual"
        try {
            const contextLimit = ctx.model?.contextWindow
            if (!contextLimit || contextLimit <= 0) return
            const messages = durableMessages(event.branchEntries)
            if (messages.length === 0) return

            const sessionKey = ctx.sessionManager.getSessionId()
            const turns = ompCodec.encode(messages)
            const transcripts = createTranscriptStore(ctx.sessionManager.getSessionDir())
            const priorPlan = await plans.load(sessionKey)
            const inputs: BuildPlanInputs = {
                ...planInputs(ctx, contextLimit),
                force: true,
                priorPlan: priorPlan ?? undefined,
            }
            const plan = buildPlan(turns, inputs, ompSpec)
            const decide = (candidate: typeof plan) =>
                decideCompaction({
                    trigger,
                    plan: candidate,
                    turns,
                    messages,
                    branchEntries: event.branchEntries,
                })

            // Gate before paying for summaries, then decide again on the plan
            // that is actually committed so the boundary and the text agree.
            const gate = decide(plan)
            if (gate.kind === "decline" || !plan) {
                logger.warn("Better Compact declined this compaction", {
                    trigger,
                    reason: gate.kind === "decline" ? gate.reason : "no plan",
                })
                return
            }

            await writeTranscript(plan, { transcripts, logger, codec: ompCodec })
            const finalPlan = await summarizeWithinDeadline(ctx, turns, inputs, plan, event.signal)
            const decision = decide(finalPlan)
            if (decision.kind === "decline") {
                logger.warn("Better Compact declined this compaction after summarizing", {
                    trigger,
                    reason: decision.reason,
                })
                return
            }

            const summary = formatDurableCompaction(finalPlan, turns, ompSpec)
            if (!summary) {
                logger.warn("Better Compact produced no durable context", { trigger })
                return
            }

            const reclaimed = Math.max(0, finalPlan.beforeTokens - finalPlan.afterPruneTokens)
            updateWidget(ctx, {
                planActive: false,
                contextLimit,
                contextTokens: finalPlan.afterPruneTokens,
                prunedTokens: undefined,
            })
            return {
                compaction: {
                    summary,
                    shortSummary: `Better Compact reclaimed ${formatTokens(reclaimed)} tokens by pruning older context.`,
                    firstKeptEntryId: decision.firstKeptEntryId,
                    tokensBefore: event.preparation.tokensBefore,
                },
            }
        } catch (error) {
            logger.warn("Better Compact compaction failed; native compaction will run", {
                trigger,
                error: errorText(error),
            })
        }
    })

    pi.registerCommand("better-compact", {
        description: "Compact this session now (Better Compact)",
        handler: async (_args, ctx) => {
            if (!ctx.model) {
                ctx.ui.notify("Better Compact: no active model context window.", "warning")
                return
            }
            ctx.ui.setStatus("better-compact", "Better Compact: compacting…")
            try {
                // Manual compaction goes through the host so the result is
                // committed, accounted and persisted by the same path automatic
                // compaction uses; `session_before_compact` supplies the plan.
                //
                // Failures are not reported here: Oh My Pi surfaces its own
                // "Compaction failed" error for both a rejected call and an
                // `onError` callback, so notifying as well just says it twice.
                await ctx.compact()
            } catch (error) {
                logger.warn("Better Compact manual compaction failed", {
                    error: errorText(error),
                })
            } finally {
                ctx.ui.setStatus("better-compact", undefined)
            }
        },
    })

    pi.registerCommand("better-compact-report", {
        description: "Show what the active Better Compact plan is keeping out of context",
        handler: async (_args, ctx) => {
            const sessionKey = ctx.sessionManager.getSessionId()
            const snapshot = await plans.load(sessionKey)
            if (!snapshot) {
                ctx.ui.notify("Better Compact: no active plan for this session.", "info")
                return
            }
            await showReport(ctx, snapshot)
        },
    })

    pi.registerCommand("better-compact-settings", {
        description: "Open Better Compact settings",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI || ctx.mode !== "tui") {
                ctx.ui.notify(
                    "Better Compact settings need the interactive TUI; use /better-compact-preset here.",
                    "warning",
                )
                return
            }
            const result = await ctx.ui.custom<{ changed: boolean; config: CompactionConfig }>(
                (_tui, _theme, _keybindings, done) =>
                    createSettingsComponent(settingsUi, config, done),
                { overlay: true },
            )
            if (!result?.changed) return
            await persistConfig(ctx, {
                automatic: result.config.automatic,
                preset: result.config.preset,
                summaryEffort: result.config.summaryEffort,
            })
        },
    })

    pi.registerCommand("better-compact-preset", {
        description: "Set the Better Compact preset (light, moderate, or max)",
        handler: async (args, ctx) => {
            const preset = commandPreset(args.trim())
            if (!preset) {
                ctx.ui.notify("Usage: /better-compact-preset <light|moderate|max>", "warning")
                return
            }
            await persistConfig(ctx, { preset })
        },
    })

    /**
     * Oh My Pi has no extension-facing project-trust query, so only the global
     * config file is read and written. A project file would be executable
     * policy with nothing vouching for the working tree.
     */
    async function persistConfig(
        ctx: ExtensionContext,
        patch: Partial<CompactionConfig>,
    ): Promise<void> {
        const path = join(getAgentDir(), CONFIG_FILE)
        try {
            const current = (await readConfigObject(path)) ?? {}
            await writeConfigObject(path, { ...current, ...patch })
            config = mergeCompactionConfig(config, patch)
            profile = resolveCompactionProfile({ compaction: config })
            ctx.ui.notify("Better Compact settings saved.", "info")
        } catch (error) {
            logger.warn("Better Compact settings update failed", { path, error: errorText(error) })
            ctx.ui.notify(`Better Compact: could not write ${path}.`, "warning")
        }
    }

    // Terminal overlays exist only in TUI mode; RPC and headless runs fall back
    // to a notification.
    async function showReport(ctx: ExtensionContext, snapshot: PlanSnapshot): Promise<void> {
        const kept = Math.max(0, snapshot.beforeTokens - snapshot.afterPruneTokens)
        if (!ctx.hasUI || ctx.mode !== "tui") {
            ctx.ui.notify(
                `Better Compact: keeping ${formatTokens(kept)} tokens out of each request (${formatTokens(snapshot.afterPruneTokens)}/${formatTokens(snapshot.contextLimit)}).`,
                "info",
            )
            return
        }
        await ctx.ui.custom<null>(
            (_tui, theme, _keybindings, done) =>
                new ReportComponent(theme, reportFromSnapshot(snapshot), () => done(null)),
            { overlay: true },
        )
    }

    /**
     * Run the plan's summary jobs inside the compaction hook, bounded so the
     * host's handler timeout is never the thing that ends them. A plan rebuilt
     * with accepted summaries replaces the original; on timeout or failure the
     * original stands, carrying core's deterministic prefix summary.
     */
    async function summarizeWithinDeadline(
        ctx: ExtensionContext,
        turns: Turn[],
        inputs: BuildPlanInputs,
        plan: BoundaryContextPlan,
        signal: AbortSignal,
    ): Promise<BoundaryContextPlan> {
        if (plan.summaryJobs.length === 0) return plan
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(COMPACT_SUMMARY_DEADLINE_MS)])
        try {
            const summaries = await summaryScheduler.summarize({
                sessionKey: plan.sessionId,
                jobs: plan.summaryJobs,
                summarizer: createOmpSummarizer(ctx, logger, deadline),
                concurrency: profile.summarizerConcurrency,
            })
            if (Object.keys(summaries).length === 0) return plan
            return (
                buildPlan(
                    turns,
                    {
                        ...inputs,
                        // Keep the boundary and everything already pruned, but do
                        // not carry the prior digest forward: the rebuild exists
                        // to fold in the summaries just fetched.
                        priorPlan: { ...toPlanSnapshot(plan), prefixSummary: undefined },
                        assistantSummaries: summaries,
                    },
                    ompSpec,
                ) ?? plan
            )
        } catch (error) {
            logger.warn("Better Compact compaction summaries incomplete", {
                error: errorText(error),
            })
            return plan
        }
    }

    // Summary jobs never block a request: they land in the plan in the
    // background and upgrade the replayed prefix from the next request.
    async function upgradePlanWithSummaries(
        ctx: ExtensionContext,
        turns: Turn[],
        contextLimit: number,
        plan: BoundaryContextPlan,
    ): Promise<void> {
        const startedAt = generation
        if (summarizing) return
        summarizing = true
        try {
            const summaries = await summaryScheduler.summarize({
                sessionKey: plan.sessionId,
                jobs: plan.summaryJobs,
                summarizer: createOmpSummarizer(ctx, logger),
                concurrency: profile.summarizerConcurrency,
            })
            if (Object.keys(summaries).length === 0) return
            // The session moved (switch, branch, tree, or a committed
            // compaction) while these ran; their plan no longer describes the
            // live branch, so it must not be written.
            if (generation !== startedAt) return
            const upgraded = buildPlan(
                turns,
                {
                    ...planInputs(ctx, contextLimit),
                    force: true,
                    priorPlan: toPlanSnapshot(plan),
                    assistantSummaries: { ...plan.assistantSummaries, ...summaries },
                },
                ompSpec,
            )
            if (upgraded) await plans.save(plan.sessionId, toPlanSnapshot(upgraded))
        } catch (error) {
            logger.warn("Better Compact summary upgrade failed", { error: errorText(error) })
        } finally {
            summarizing = false
        }
    }
}

/**
 * The durable context for a branch, exactly as Oh My Pi rebuilds it for the
 * model: `buildSessionContext` owns compaction replay, `/clear` boundaries,
 * retry-recovery filtering and custom-message normalization, so the ladder
 * plans against the same history the host would send.
 */
function durableMessages(entries: SessionEntry[]): OmpAgentMessage[] {
    return buildSessionContext(entries).messages
}
