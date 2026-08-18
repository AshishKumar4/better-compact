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
    type CompactionConfig,
    type EnginePorts,
    type Logger,
    type Turn,
} from "@better-compact/core"
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    getSettingsListTheme,
    sessionEntryToContextMessages,
    type ContextEvent,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { SettingsList } from "@earendil-works/pi-tui"
import { createPiFamilyCodec, piSpec } from "./codec"
import {
    commandPreset,
    CONFIG_FILE,
    errorText,
    loadCompactionConfig,
    mergeCompactionConfig,
    readConfigObject,
    writeConfigObject,
} from "./config"
import type { AssertHostRolesModelled } from "./messages"
import { createPlanStore } from "./plan-store"
import { createSummarizer } from "./summarizer"
import { createTranscriptStore } from "./transcripts"
import { formatTokens } from "./tui/format"
import type { HostSettingsUi } from "./tui/host"
import { ReportComponent, reportFromPlan } from "./tui/report"
import { createSettingsComponent } from "./tui/settings"
import { WidgetComponent, type WidgetState } from "./tui/widget"

// Fails typecheck if pi adds a message role the shared codec does not model.
type PiAgentMessage = ContextEvent["messages"][number]
type _PiRolesModelled = AssertHostRolesModelled<PiAgentMessage["role"]>

const piCodec = createPiFamilyCodec<PiAgentMessage>()

const settingsUi: HostSettingsUi<SettingsList> = {
    createSettingsList: (items, visibleRows, onChange, onDone) =>
        new SettingsList(items, visibleRows, getSettingsListTheme(), onChange, onDone),
}

const logger: Logger = {
    info() {},
    debug() {},
    warn: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
    error: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
}

export default function betterCompact(pi: ExtensionAPI) {
    const plans = createPlanStore((customType, data) => pi.appendEntry(customType, data))
    const summaryScheduler = createSummaryScheduler(logger)
    const summarizing = new Set<string>()
    let config = mergeCompactionConfig()
    let profile = COMPACTION_PRESETS.light
    let warnedNativeCompaction = false
    let widget: WidgetState = { planActive: false }

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

    // Terminal overlays exist only in TUI mode; RPC and headless runs fall
    // back to the notification they have always had.
    const showReport = async (
        ctx: ExtensionContext,
        plan: BoundaryContextPlan,
        pendingSummaries: number,
    ): Promise<void> => {
        const summary = `Better Compact: ${formatTokens(plan.beforeTokens)} -> ${formatTokens(plan.afterPruneTokens)} tokens; applies from the next request.`
        if (!ctx.hasUI || ctx.mode !== "tui") {
            ctx.ui.notify(summary, "info")
            return
        }
        await ctx.ui.custom<null>(
            (_tui, theme, _keybindings, done) =>
                new ReportComponent(theme, reportFromPlan(plan, pendingSummaries), () =>
                    done(null),
                ),
            { overlay: true },
        )
    }

    const enginePorts = (ctx: ExtensionContext): EnginePorts => ({
        transcripts: createTranscriptStore(ctx.sessionManager.getSessionDir()),
        plans,
        logger,
    })

    const planInputs = (ctx: ExtensionContext, contextLimit: number) => ({
        contextLimit,
        triggerRatio: profile.triggerPercent / 100,
        targetRatio: profile.targetPercent / 100,
        recentToolResultBudgetTokens: profile.recentToolTokens,
        sessionKey: ctx.sessionManager.getSessionId(),
        citablePath: createTranscriptStore(ctx.sessionManager.getSessionDir()).citablePath,
    })

    pi.on("session_start", async (_event, ctx) => {
        plans.restore(ctx.sessionManager)
        const messages = ctx.sessionManager
            .buildContextEntries()
            .flatMap(sessionEntryToContextMessages)
        if (messages.length > 0) {
            plans.adopt(ctx.sessionManager.getSessionId(), piCodec.encode(messages))
        }
        // Project files are executable policy: only honor them after pi has
        // established trust for the working tree.
        config = await loadCompactionConfig(
            logger,
            join(getAgentDir(), CONFIG_FILE),
            ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE) : null,
        )
        profile = resolveCompactionProfile({ compaction: config })
    })

    // Better Compact prunes before native compaction would trigger, but the
    // knob belongs to the user: warn once instead of mutating settings.
    pi.on("session_before_compact", (_event, ctx) => {
        if (warnedNativeCompaction) return
        warnedNativeCompaction = true
        ctx.ui.notify(
            'Native compaction is about to rewrite history Better Compact already prunes; set "compaction": { "enabled": false } in pi settings.',
            "warning",
        )
    })

    pi.on("context", async (event, ctx) => {
        try {
            if (!config.automatic) return
            const contextLimit = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow
            if (!contextLimit || contextLimit <= 0) return
            const sessionKey = ctx.sessionManager.getSessionId()
            const turns = piCodec.encode(event.messages)
            plans.adopt(sessionKey, turns)
            const result = await createEngine(piSpec, enginePorts(ctx)).process({
                sessionKey,
                turns,
                contextLimit,
                triggerRatio: profile.triggerPercent / 100,
                targetRatio: profile.targetPercent / 100,
                recentToolResultBudgetTokens: profile.recentToolTokens,
            })
            if (result.outcome === "unchanged") return
            if (result.outcome === "planned" && result.plan.summaryJobs.length > 0) {
                void upgradePlanWithSummaries(ctx, turns, contextLimit, result.plan)
            }
            const plan = result.outcome === "planned" ? result.plan : undefined
            updateWidget(ctx, {
                planActive: true,
                contextLimit,
                contextTokens: plan?.afterPruneTokens ?? ctx.getContextUsage()?.tokens ?? undefined,
                prunedTokens: plan
                    ? Math.max(0, plan.beforeTokens - plan.afterPruneTokens)
                    : widget.prunedTokens,
            })
            return { messages: piCodec.decode(result.turns, event.messages) }
        } catch (error) {
            // A failed prune must never break the request; it goes out unpruned.
            logger.error("Better Compact context transform failed", { error: errorText(error) })
        }
    })

    pi.registerCommand("better-compact", {
        description: "Prune older context now (Better Compact)",
        handler: async (_args, ctx) => {
            const contextLimit = ctx.model?.contextWindow
            if (!contextLimit || contextLimit <= 0) {
                ctx.ui.notify("Better Compact: no active model context window.", "warning")
                return
            }
            const sessionKey = ctx.sessionManager.getSessionId()
            if (summarizing.has(sessionKey)) {
                ctx.ui.notify("Better Compact is already summarizing this session.", "info")
                return
            }
            const messages = ctx.sessionManager
                .buildContextEntries()
                .flatMap(sessionEntryToContextMessages)
            if (messages.length === 0) {
                ctx.ui.notify("Better Compact: nothing to prune yet.", "info")
                return
            }

            const turns = piCodec.encode(messages)
            plans.adopt(sessionKey, turns)
            const transcripts = createTranscriptStore(ctx.sessionManager.getSessionDir())
            const priorPlan = await plans.load(sessionKey)
            const inputs = {
                ...planInputs(ctx, contextLimit),
                force: true,
                priorPlan: priorPlan ?? undefined,
            }
            ctx.ui.setStatus("better-compact", "Better Compact: planning…")
            try {
                const plan = buildPlan(turns, inputs, piSpec)
                if (!plan) {
                    ctx.ui.notify("Better Compact: nothing to prune yet.", "info")
                    return
                }
                await writeTranscript(plan, { transcripts, logger, codec: piCodec })
                let finalPlan = plan
                if (plan.summaryJobs.length > 0) {
                    summarizing.add(sessionKey)
                    try {
                        ctx.ui.setStatus(
                            "better-compact",
                            `Better Compact: running ${plan.summaryJobs.length} summary jobs…`,
                        )
                        updateWidget(ctx, {
                            summarizing: { done: 0, total: plan.summaryJobs.length },
                        })
                        const summaries = await summaryScheduler.summarize({
                            sessionKey,
                            jobs: plan.summaryJobs,
                            summarizer: createSummarizer(ctx, logger),
                            concurrency: profile.summarizerConcurrency,
                        })
                        if (Object.keys(summaries).length > 0) {
                            finalPlan =
                                buildPlan(
                                    turns,
                                    {
                                        ...inputs,
                                        priorPlan: toPlanSnapshot(plan),
                                        assistantSummaries: summaries,
                                    },
                                    piSpec,
                                ) ?? plan
                        }
                    } finally {
                        summarizing.delete(sessionKey)
                    }
                }
                await plans.save(sessionKey, toPlanSnapshot(finalPlan))
                updateWidget(ctx, {
                    planActive: true,
                    contextLimit,
                    contextTokens: finalPlan.afterPruneTokens,
                    prunedTokens: Math.max(0, finalPlan.beforeTokens - finalPlan.afterPruneTokens),
                    summarizing: undefined,
                })
                await showReport(ctx, finalPlan, 0)
            } finally {
                ctx.ui.setStatus("better-compact", undefined)
            }
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
            const path = join(getAgentDir(), CONFIG_FILE)
            try {
                const current = (await readConfigObject(path)) ?? {}
                await writeConfigObject(path, {
                    ...current,
                    automatic: result.config.automatic,
                    preset: result.config.preset,
                    summaryEffort: result.config.summaryEffort,
                })
                config = mergeCompactionConfig(config, result.config)
                profile = resolveCompactionProfile({ compaction: config })
                ctx.ui.notify("Better Compact settings saved.", "info")
            } catch (error) {
                logger.warn("Better Compact settings update failed", {
                    path,
                    error: errorText(error),
                })
                ctx.ui.notify(`Better Compact: could not write ${path}.`, "warning")
            }
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
            const path = join(getAgentDir(), CONFIG_FILE)
            try {
                const current = (await readConfigObject(path)) ?? {}
                await writeConfigObject(path, { ...current, preset })
                config = mergeCompactionConfig(config, { preset })
                profile = resolveCompactionProfile({ compaction: config })
                ctx.ui.notify(`Better Compact preset set to ${preset}.`, "info")
            } catch (error) {
                logger.warn("Better Compact preset update failed", {
                    path,
                    error: errorText(error),
                })
                ctx.ui.notify(`Better Compact: could not write ${path}.`, "warning")
            }
        },
    })

    // Summary jobs never block a request: they land in the plan in
    // the background and upgrade the replayed prefix from the next request.
    async function upgradePlanWithSummaries(
        ctx: ExtensionContext,
        turns: Turn[],
        contextLimit: number,
        plan: BoundaryContextPlan,
    ): Promise<void> {
        const sessionKey = plan.sessionId
        if (summarizing.has(sessionKey)) return
        summarizing.add(sessionKey)
        try {
            const summaries = await summaryScheduler.summarize({
                sessionKey,
                jobs: plan.summaryJobs,
                summarizer: createSummarizer(ctx, logger),
                concurrency: profile.summarizerConcurrency,
            })
            if (Object.keys(summaries).length === 0) return
            // A stale ctx after a session switch throws here; the catch drops
            // the upgrade instead of writing into the wrong session.
            if (ctx.sessionManager.getSessionId() !== sessionKey) return
            const upgraded = buildPlan(
                turns,
                {
                    ...planInputs(ctx, contextLimit),
                    force: true,
                    priorPlan: toPlanSnapshot(plan),
                    assistantSummaries: { ...plan.assistantSummaries, ...summaries },
                },
                piSpec,
            )
            if (upgraded) await plans.save(sessionKey, toPlanSnapshot(upgraded))
        } catch (error) {
            logger.warn("Better Compact summary upgrade failed", { error: errorText(error) })
        } finally {
            summarizing.delete(sessionKey)
        }
    }
}
