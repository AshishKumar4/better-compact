import { join } from "node:path"
import { toPlanSnapshot, type CompactionConfig, type Logger } from "@better-compact/core"
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
import { commandPreset, CONFIG_FILE, errorText } from "./config"
import type { AssertHostRolesModelled } from "./messages"
import { createRuntime, type RuntimeHost } from "./runtime"
import { createSummarizer } from "./summarizer"
import { formatTokens } from "./tui/format"
import type { HostSettingsUi } from "./tui/host"
import { ReportComponent, reportFromPlan } from "./tui/report"
import { createSettingsComponent } from "./tui/settings"
import { WidgetComponent } from "./tui/widget"

// Fails typecheck if pi adds a message role the shared codec does not model.
type PiAgentMessage = ContextEvent["messages"][number]
type _PiRolesModelled = AssertHostRolesModelled<PiAgentMessage["role"]>

const piCodec = createPiFamilyCodec<PiAgentMessage>()

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
 * The pi half of the adapter: how to reach this host's session, config, usage
 * and credentials. Everything policy-shaped lives in the shared runtime.
 */
function createPiHost(pi: ExtensionAPI): RuntimeHost<ExtensionContext, PiAgentMessage> {
    return {
        codec: piCodec,
        spec: piSpec,
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
        durableMessages: (ctx) =>
            ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages),
        contextWindow: (ctx) => ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow,
        providerTokens: (ctx) => ctx.getContextUsage()?.tokens ?? undefined,
        // Project files are executable policy: only honor them after pi has
        // established trust for the working tree.
        configPaths: (ctx) => ({
            global: join(getAgentDir(), CONFIG_FILE),
            project: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE) : null,
        }),
        summarizer: (ctx) => createSummarizer(ctx, logger),
        appendEntry: (customType, data) => pi.appendEntry(customType, data),
    }
}

export default function betterCompact(pi: ExtensionAPI) {
    const runtime = createRuntime(createPiHost(pi))
    let warnedNativeCompaction = false

    pi.on("session_start", async (_event, ctx) => {
        if (!runtime.owns(ctx)) return
        await runtime.rehydrate(ctx)
    })

    // Better Compact prunes before native compaction would trigger, but pi
    // exposes no way to supply the compacted result, so the knob belongs to the
    // user: warn once instead of mutating settings.
    pi.on("session_before_compact", (_event, ctx) => {
        if (warnedNativeCompaction || !runtime.owns(ctx)) return
        warnedNativeCompaction = true
        ctx.ui.notify(
            'Native compaction is about to rewrite history Better Compact already prunes; set "compaction": { "enabled": false } in pi settings.',
            "warning",
        )
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

    pi.registerCommand("better-compact", {
        description: "Prune older context now (Better Compact)",
        handler: async (_args, ctx) => {
            const contextLimit = ctx.model?.contextWindow
            if (!contextLimit || contextLimit <= 0) {
                ctx.ui.notify("Better Compact: no active model context window.", "warning")
                return
            }
            const messages = runtime.durableMessages(ctx)
            if (messages.length === 0) {
                ctx.ui.notify("Better Compact: nothing to prune yet.", "info")
                return
            }

            ctx.ui.setStatus("better-compact", "Better Compact: planning…")
            try {
                const plan = await runtime.forcePlan(ctx, messages, contextLimit)
                if (!plan) {
                    ctx.ui.notify("Better Compact: nothing to prune yet.", "info")
                    return
                }
                if (plan.summaryJobs.length > 0) {
                    ctx.ui.setStatus(
                        "better-compact",
                        `Better Compact: running ${plan.summaryJobs.length} summary jobs…`,
                    )
                    runtime.setWidget(ctx, {
                        summarizing: { done: 0, total: plan.summaryJobs.length },
                    })
                }
                const turns = piCodec.encode(messages)
                const finalPlan = await runtime.summarizeNow(
                    ctx,
                    turns,
                    { ...runtime.planInputs(ctx, contextLimit), force: true },
                    plan,
                )
                await runtime.plans.save(
                    ctx.sessionManager.getSessionId(),
                    toPlanSnapshot(finalPlan),
                )
                runtime.setWidget(ctx, {
                    planActive: true,
                    contextLimit,
                    contextTokens: finalPlan.afterPruneTokens,
                    prunedTokens: Math.max(0, finalPlan.beforeTokens - finalPlan.afterPruneTokens),
                    summarizing: undefined,
                })

                // pi cannot rewrite the live request from a command, so the plan
                // applies from the next one; the report says so.
                const summary = `Better Compact: ${formatTokens(finalPlan.beforeTokens)} -> ${formatTokens(finalPlan.afterPruneTokens)} tokens; applies from the next request.`
                if (!ctx.hasUI || ctx.mode !== "tui") {
                    ctx.ui.notify(summary, "info")
                    return
                }
                await ctx.ui.custom<null>(
                    (_tui, theme, _keybindings, done) =>
                        new ReportComponent(theme, reportFromPlan(finalPlan), () => done(null)),
                    { overlay: true },
                )
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
                    createSettingsComponent(settingsUi, runtime.config, done),
                { overlay: true },
            )
            if (!result?.changed) return
            await runtime.saveConfig(ctx, {
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
            await runtime.saveConfig(ctx, { preset }, `Better Compact preset set to ${preset}.`)
        },
    })
}
