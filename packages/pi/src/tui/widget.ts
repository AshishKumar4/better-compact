import type { Component } from "@earendil-works/pi-tui"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { formatTokens, meter } from "./format"

const METER_WIDTH = 18

export interface WidgetState {
    contextTokens?: number
    contextLimit?: number
    /** Tokens the active plan is currently keeping out of the request. */
    prunedTokens?: number
    summarizing?: { done: number; total: number }
    planActive: boolean
}

// Docked above the editor, so the state of the session's context is visible
// without running a command. pi has no equivalent surface in OpenCode.
export class WidgetComponent implements Component {
    constructor(
        private readonly theme: Theme,
        private readonly state: WidgetState,
    ) {}

    render(): string[] {
        return [renderWidgetLine(this.theme, this.state)]
    }

    invalidate(): void {
        // A single derived line; there is no cached state to drop.
    }
}

export function renderWidgetLine(theme: Theme, state: WidgetState): string {
    const parts: string[] = [theme.fg("accent", "◆ Better Compact")]

    if (state.contextLimit && state.contextLimit > 0 && state.contextTokens !== undefined) {
        const bar = meter(state.contextTokens, state.contextLimit, METER_WIDTH)
        const color = bar.percent >= 85 ? "warning" : bar.percent >= 60 ? "text" : "success"
        parts.push(
            `${theme.fg(color, bar.filled)}${theme.fg("borderMuted", bar.empty)} ${theme.fg(
                "text",
                `${formatTokens(state.contextTokens)}/${formatTokens(state.contextLimit)}`,
            )}`,
        )
    }

    if (state.prunedTokens && state.prunedTokens > 0) {
        parts.push(theme.fg("success", `−${formatTokens(state.prunedTokens)} pruned`))
    } else if (state.planActive) {
        parts.push(theme.fg("muted", "plan active"))
    }

    if (state.summarizing && state.summarizing.total > 0) {
        parts.push(
            theme.fg(
                "warning",
                `summarizing ${state.summarizing.done}/${state.summarizing.total}`,
            ),
        )
    }

    return parts.join(theme.fg("borderMuted", "  ·  "))
}
