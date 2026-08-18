import type {
    BoundaryContextPlan,
    BoundaryStageName,
    BoundaryStageReport,
    PlanSnapshot,
} from "@better-compact/core"
import type { HostComponent, HostTheme } from "./host"
import { PLUGIN_VERSION } from "../version"
import { formatTokens, meter, padEnd, percent } from "./format"

const METER_WIDTH = 28
const LABEL_WIDTH = 34

const STAGE_GLYPH: Record<BoundaryStageReport["status"], string> = {
    applied: "●",
    skipped: "○",
    "target-met": "◍",
    failed: "✕",
}

const STAGE_COLOR: Record<BoundaryStageReport["status"], "success" | "muted" | "accent" | "error"> =
    {
        applied: "success",
        skipped: "muted",
        "target-met": "accent",
        failed: "error",
    }

/**
 * The plan facts the report renders. Named separately from
 * `BoundaryContextPlan` because a persisted snapshot carries all of them while
 * a live plan carries more — see {@link reportFromPlan} and
 * {@link reportFromSnapshot}.
 */
export interface ReportInput {
    contextLimit: number
    beforeTokens: number
    afterPruneTokens: number
    targetTokens: number
    stages: readonly BoundaryStageReport[]
    transcriptRelativePath: string
    /** Summary jobs still running in the background, if any. */
    pendingSummaries?: number
}

export function reportFromPlan(plan: BoundaryContextPlan, pendingSummaries = 0): ReportInput {
    return {
        contextLimit: plan.contextLimit,
        beforeTokens: plan.beforeTokens,
        afterPruneTokens: plan.afterPruneTokens,
        targetTokens: plan.targetTokens,
        stages: plan.stages,
        transcriptRelativePath: plan.transcript.relativePath,
        pendingSummaries,
    }
}

/**
 * Snapshots persist stage records with widened `name`/`status` strings so an
 * older snapshot keeps loading. Rows whose status this build does not recognize
 * are dropped rather than rendered with a missing glyph.
 */
export function reportFromSnapshot(snapshot: PlanSnapshot): ReportInput {
    return {
        contextLimit: snapshot.contextLimit,
        beforeTokens: snapshot.beforeTokens,
        afterPruneTokens: snapshot.afterPruneTokens,
        targetTokens: snapshot.targetTokens,
        stages: (snapshot.stages ?? []).flatMap((stage) =>
            Object.hasOwn(STAGE_GLYPH, stage.status)
                ? [
                      {
                          ...stage,
                          name: stage.name as BoundaryStageName,
                          status: stage.status as BoundaryStageReport["status"],
                      },
                  ]
                : [],
        ),
        transcriptRelativePath: snapshot.transcriptRelativePath,
    }
}

// The ladder runs synchronously, so there is no progress to animate — what is
// worth showing is what the ladder actually did. Every number here comes from
// the plan the engine returned or the snapshot it persisted.
export class ReportComponent implements HostComponent {
    constructor(
        private readonly theme: HostTheme,
        private readonly input: ReportInput,
        private readonly done: () => void,
    ) {}

    render(width: number): string[] {
        const { theme } = this
        const plan = this.input
        const lines: string[] = []
        const rule = "─".repeat(Math.max(0, Math.min(width, 78)))

        lines.push(
            `${theme.bold(theme.fg("accent", "Better Compact"))} ${theme.fg("dim", `v${PLUGIN_VERSION}`)}`,
        )
        lines.push(theme.fg("text", "Report"))
        lines.push(theme.fg("borderMuted", rule))
        lines.push("")

        lines.push(theme.fg("toolTitle", "Context window"))
        lines.push(this.meterLine("Before", plan.beforeTokens, plan.contextLimit, "warning"))
        lines.push(
            this.meterLine("After prune", plan.afterPruneTokens, plan.contextLimit, "success"),
        )
        lines.push(this.meterLine("Target", plan.targetTokens, plan.contextLimit, "accent"))
        const cleared = Math.max(0, plan.beforeTokens - plan.afterPruneTokens)
        lines.push(
            `  ${padEnd("Reclaimed", 14)}${theme.bold(theme.fg("success", formatTokens(cleared)))} ${theme.fg("dim", `(${percent(cleared, plan.beforeTokens)}% of prior context)`)}`,
        )
        lines.push("")

        lines.push(theme.fg("toolTitle", "Ladder"))
        for (const stage of plan.stages) {
            lines.push(this.stageLine(stage))
        }
        if (plan.stages.length === 0) {
            lines.push(`  ${theme.fg("muted", "No stages ran — nothing was above the trigger.")}`)
        }
        lines.push("")

        const pending = this.input.pendingSummaries ?? 0
        if (pending > 0) {
            lines.push(
                theme.fg(
                    "muted",
                    `Summarizing ${pending} assistant run${pending === 1 ? "" : "s"} in the background; the plan upgrades from the next request.`,
                ),
            )
        }
        lines.push(theme.fg("dim", `Raw history archived at ${plan.transcriptRelativePath}`))
        lines.push(theme.fg("borderMuted", rule))
        lines.push(theme.fg("dim", "esc  close"))
        return lines
    }

    invalidate(): void {
        // Rendering is derived from the plan on every frame; nothing cached.
    }

    handleInput(data: string): void {
        // Esc, Enter or q dismisses; the overlay owns focus while open.
        if (data === "\x1b" || data === "\r" || data === "\n" || data === "q") this.done()
    }

    private meterLine(
        label: string,
        value: number,
        total: number,
        color: "success" | "warning" | "accent",
    ): string {
        const { theme } = this
        const bar = meter(value, total, METER_WIDTH)
        return [
            "  ",
            padEnd(label, 14),
            theme.fg(color, bar.filled),
            theme.fg("borderMuted", bar.empty),
            "  ",
            theme.fg("text", `${formatTokens(value)} / ${formatTokens(total)}`),
            " ",
            theme.fg("dim", `${bar.percent}%`),
        ].join("")
    }

    private stageLine(stage: BoundaryStageReport): string {
        const { theme } = this
        const color = STAGE_COLOR[stage.status]
        const detail =
            stage.status === "applied"
                ? `${formatTokens(stage.clearedTokens)} freed · ${stage.changedMessages} msg`
                : stage.status === "target-met"
                  ? "target already met"
                  : stage.status
        return [
            "  ",
            theme.fg(color, STAGE_GLYPH[stage.status]),
            " ",
            padEnd(stage.label, LABEL_WIDTH),
            theme.fg(stage.status === "applied" ? "text" : "muted", detail),
        ].join("")
    }
}
