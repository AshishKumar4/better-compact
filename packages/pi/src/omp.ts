import { join } from "node:path"
import type { BuildPlanInputs, CompactionConfig, Logger } from "@better-compact/core"
import {
    buildSessionContext,
    getAgentDir,
    getSettingsListTheme,
    settings as ompSettings,
    type ExtensionAPI,
    type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent"
import { SettingsList } from "@oh-my-pi/pi-tui"
import { commandPreset, CONFIG_FILE, errorText } from "./config"
import { ompCodec, ompSpec } from "./omp/codec"
import { decideCompaction, formatDurableCompaction, type CompactionTrigger } from "./omp/compaction"
import {
    commandOmpCompactionOwner,
    currentOmpCompactionOwner,
    isOmpCompactionOwner,
    loadOmpCompactionOwner,
    OMP_COMPACTION_OWNERS,
    saveOmpCompactionOwner,
    type OmpCompactionOwner,
} from "./omp/config"
import type { OmpAgentMessage } from "./omp/host"
import { createOmpSummarizer } from "./omp/summarizer"
import { createRuntime, type RuntimeHost } from "./runtime"
import { formatTokens } from "./tui/format"
import type { HostSettingsUi } from "./tui/host"
import { ReportComponent, reportFromSnapshot } from "./tui/report"
import { createSettingsComponent } from "./tui/settings"
import { WidgetComponent } from "./tui/widget"

/**
 * Oh My Pi runs extension handlers under a 30s timeout
 * (`EXTENSION_HANDLER_TIMEOUT_MS`). A compaction handler that overruns it is
 * discarded and the native summarizer runs instead, so side-model summaries get
 * a deadline with room left for the transcript write and plan rebuild. Missing
 * the deadline is not a failure: the ladder's deterministic output still lands,
 * just without LLM polish on the collapsed runs.
 */
const COMPACT_SUMMARY_DEADLINE_MS = 20_000

/**
 * Strategies under which Better Compact does not reliably own compaction.
 *
 * `handoff` and `shake` each run their own path first and only fall back to the
 * context-full body that consults this hook — handoff when it produces no
 * document, shake when it finds nothing eligible to drop — so ownership is
 * intermittent rather than absent. `off` disables maintenance entirely and never
 * reaches the hook at all.
 */
const UNRELIABLE_STRATEGIES: Record<string, string> = {
    handoff:
        "hands the session off first and only falls back to this hook when it produces no document",
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

/**
 * The Oh My Pi half of the adapter: how to reach this host's session, config,
 * usage and credentials. Everything policy-shaped lives in the shared runtime.
 *
 * `appendEntry` is bound per extension instance, so the host is built per
 * factory invocation rather than shared at module scope.
 */
function createOmpHost(pi: ExtensionAPI): RuntimeHost<ExtensionContext, OmpAgentMessage> {
    return {
        codec: ompCodec,
        spec: ompSpec,
        logger,
        ui: (ctx) => ({
            notify: (message, level) => ctx.ui.notify(message, level),
            setStatus: (text) => ctx.ui.setStatus("better-compact", text),
            showWidget: (state) =>
                ctx.hasUI
                    ? ctx.ui.setWidget(
                          "better-compact",
                          state ? (_tui, theme) => new WidgetComponent(theme, state) : undefined,
                          { placement: "aboveEditor" },
                      )
                    : undefined,
        }),
        sessionId: (ctx) => ctx.sessionManager.getSessionId(),
        sessionDir: (ctx) => ctx.sessionManager.getSessionDir(),
        branch: (ctx) => ctx.sessionManager,
        // `buildSessionContext` owns compaction replay, `/clear` boundaries,
        // retry-recovery filtering and custom-message normalization, so the ladder
        // plans against the same history the host would send.
        durableMessages: (ctx) => buildSessionContext(ctx.sessionManager.getBranch()).messages,
        contextWindow: (ctx) => ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow,
        providerTokens: (ctx) => ctx.getContextUsage()?.tokens,
        // Oh My Pi exposes no extension-facing project-trust query, so only the
        // global file is read: a project file would be executable policy with
        // nothing vouching for the working tree.
        configPaths: () => ({ global: join(getAgentDir(), CONFIG_FILE), project: null }),
        summarizer: (ctx, signal) => createOmpSummarizer(ctx, logger, signal),
        appendEntry: (customType, data) => pi.appendEntry(customType, data),
    }
}

export default function betterCompactOmp(pi: ExtensionAPI) {
    const runtime = createRuntime(createOmpHost(pi))
    const ownerPath = join(getAgentDir(), CONFIG_FILE)
    const compactionOwner = () => currentOmpCompactionOwner(ownerPath)
    let strategyWarned = false
    /**
     * The reason Oh My Pi is compacting. `auto_compaction_start` fires before
     * `session_before_compact`; a compact event with nothing recorded here is
     * the manual `/compact` path.
     */
    let pendingTrigger: CompactionTrigger | undefined

    const ompStrategy = (): string | undefined => {
        try {
            return ompSettings.get("compaction.strategy")
        } catch {
            return undefined
        }
    }

    /**
     * Oh My Pi routes `handoff` and `shake` to their own paths first and `off`
     * disables maintenance, so under those Better Compact does not reliably own
     * compaction. Warn once rather than mutating the user's configuration.
     *
     * Reading the setting is best-effort on purpose: `settings.get` throws
     * outright when the host has not initialized `Settings` yet (embedded and
     * test hosts do not), and a diagnostic must never be the reason session
     * rehydration fails.
     */
    const warnUnreliableStrategy = (ctx: ExtensionContext): void => {
        if (compactionOwner() === "omp" || strategyWarned) return
        const strategy = ompStrategy()
        const reason = strategy === undefined ? undefined : UNRELIABLE_STRATEGIES[strategy]
        if (!reason) return
        strategyWarned = true
        ctx.ui.notify(
            `Better Compact does not reliably own automatic compaction while compaction.strategy is "${strategy}" — it ${reason}. Set it to "context-full" or "snapcompact".`,
            "warning",
        )
    }

    /**
     * Oh My Pi keeps one extension runtime across new/resume/fork/handoff
     * (`session_switch`), branch operations (`session_branch`) and same-file tree
     * navigation (`session_tree`), so every one of those has to rehydrate or the
     * adapter keeps serving the previous branch's plan. A committed compaction
     * rewrote the branch, so it rehydrates too.
     */
    const rehydrate = async (ctx: ExtensionContext): Promise<void> => {
        if (!runtime.owns(ctx)) return
        pendingTrigger = undefined
        await runtime.rehydrate(ctx)
        await loadOmpCompactionOwner(ownerPath)
        warnUnreliableStrategy(ctx)
    }

    pi.on("session_start", (_event, ctx) => rehydrate(ctx))
    pi.on("session_switch", (_event, ctx) => rehydrate(ctx))
    pi.on("session_branch", (_event, ctx) => rehydrate(ctx))
    pi.on("session_tree", (_event, ctx) => rehydrate(ctx))
    pi.on("session_compact", (_event, ctx) => rehydrate(ctx))

    pi.on("auto_compaction_start", (event) => {
        pendingTrigger = event.reason
    })

    pi.on("auto_compaction_end", () => {
        pendingTrigger = undefined
    })

    pi.on("context", async (event, ctx) => {
        try {
            if (!runtime.owns(ctx)) return
            const result = await runtime.transform(ctx, event.messages)
            return result ? { messages: result.messages } : undefined
        } catch (error) {
            // A failed prune must never break the request; it goes out unpruned.
            logger.error("Better Compact context transform failed", { error: errorText(error) })
        }
    })

    /**
     * Better Compact answers every compaction Oh My Pi decides to run — manual
     * `/compact`, the pre-prompt and mid-turn thresholds, idle maintenance, and
     * overflow recovery — and the native summarizer never runs.
     *
     * The host's durable shape is one summary string plus a contiguous tail, so
     * the ladder's compacted prefix is serialized into that slot: user turns as
     * written, dropped tool calls as one-line stubs, collapsed runs carrying the
     * summaries paid for here, and a pointer to the raw transcript. The host then
     * persists it, rebuilds context, rebases accounting and resets dependent
     * state exactly as it would for its own summarizer.
     *
     * Returning nothing hands the run back to the native summarizer rather than
     * leaving the session uncompacted.
     */
    pi.on("session_before_compact", async (event, ctx) => {
        const trigger = pendingTrigger ?? "manual"
        try {
            if (!runtime.owns(ctx) || compactionOwner() === "omp") return
            const contextLimit = ctx.model?.contextWindow
            if (!contextLimit || contextLimit <= 0) return
            const messages = buildSessionContext(event.branchEntries).messages
            if (messages.length === 0) return

            const turns = ompCodec.encode(messages)
            const plan = await runtime.forcePlan(ctx, messages, contextLimit)
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

            const inputs: BuildPlanInputs = {
                ...runtime.planInputs(ctx, contextLimit),
                force: true,
            }
            const deadline = AbortSignal.any([
                event.signal,
                AbortSignal.timeout(COMPACT_SUMMARY_DEADLINE_MS),
            ])
            const finalPlan = await runtime.summarizeNow(ctx, turns, inputs, plan, deadline)

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
            runtime.clearWidget(ctx)
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
        description: "Run the selected committed compaction now",
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
            const snapshot = await runtime.plans.load(ctx.sessionManager.getSessionId())
            if (!snapshot) {
                ctx.ui.notify("Better Compact: no active plan for this session.", "info")
                return
            }
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
        },
    })

    pi.registerCommand("better-compact-settings", {
        description: "Open Better Compact settings",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI || ctx.mode !== "tui") {
                ctx.ui.notify(
                    "Better Compact settings need the interactive TUI; use /better-compact-preset or /better-compact-mode here.",
                    "warning",
                )
                return
            }
            const openedOwner = await loadOmpCompactionOwner(ownerPath)
            let nextOwner = openedOwner
            let ownerChanged = false
            const result = await ctx.ui.custom<{
                changed: boolean
                config: CompactionConfig
                compactionOwner: OmpCompactionOwner
            }>(
                (_tui, _theme, _keybindings, done) =>
                    createSettingsComponent(
                        settingsUi,
                        runtime.config,
                        (settingsResult) => done({ ...settingsResult, compactionOwner: nextOwner }),
                        [
                            {
                                id: "ompCompactionOwner",
                                label: "Committed compaction",
                                description:
                                    "Choose Better Compact or the OMP strategy for durable compaction.",
                                currentValue: openedOwner,
                                values: [...OMP_COMPACTION_OWNERS],
                                onChange: (value) => {
                                    if (!isOmpCompactionOwner(value)) return
                                    nextOwner = value
                                    ownerChanged = nextOwner !== openedOwner
                                },
                            },
                        ],
                    ),
                { overlay: true },
            )
            if (!result?.changed) return
            if (ownerChanged) {
                await saveOmpCompactionOwner(ownerPath, result.compactionOwner)
                strategyWarned = false
            }
            await runtime.saveConfig(ctx, {
                automatic: result.config.automatic,
                preset: result.config.preset,
                summaryEffort: result.config.summaryEffort,
            })
            warnUnreliableStrategy(ctx)
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
            await runtime.saveConfig(ctx, { preset }, `Better Compact preset set to ${preset}.`)
        },
    })

    pi.registerCommand("better-compact-mode", {
        description: "Choose Better Compact or OMP for committed compaction",
        handler: async (args, ctx) => {
            if (!args.trim()) {
                ctx.ui.notify(`Committed compaction: ${compactionOwner()}.`, "info")
                return
            }
            const owner = commandOmpCompactionOwner(args)
            if (!owner) {
                ctx.ui.notify("Usage: /better-compact-mode <better-compact|omp>", "warning")
                return
            }
            try {
                await saveOmpCompactionOwner(ownerPath, owner)
                strategyWarned = false
                ctx.ui.notify(`Committed compaction set to ${owner}.`, "info")
                warnUnreliableStrategy(ctx)
            } catch (error) {
                logger.warn("Better Compact mode update failed", {
                    error: errorText(error),
                })
                ctx.ui.notify("Better Compact could not save the compaction mode.", "warning")
            }
        },
    })
}
