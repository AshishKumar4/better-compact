import assert from "node:assert/strict"
import test from "node:test"
import type { BoundaryContextPlan } from "@better-compact/core"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { ReportComponent, reportFromPlan } from "../src/tui/report"
import { renderWidgetLine, type WidgetState } from "../src/tui/widget"
import { formatTokens, meter, percent } from "../src/tui/format"

// The components only colour text through the theme, so a pass-through stub
// keeps assertions about content rather than ANSI escapes.
const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme

function plan(overrides: Partial<BoundaryContextPlan> = {}): BoundaryContextPlan {
    return {
        sessionId: "ses_1",
        rangeHash: "hash",
        contextLimit: 1_000_000,
        beforeTokens: 800_000,
        afterPruneTokens: 300_000,
        overheadTokens: 0,
        triggerTokens: 850_000,
        targetTokens: 350_000,
        rawTailStartIndex: 3,
        rawTailStartMessageId: "m3",
        requiresCustomCompaction: false,
        preservedToolCallIds: [],
        transcript: {
            relativePath: "better-compact/ses_1/hash.md",
            absolutePath: "/s/better-compact/ses_1/hash.md",
            messageIds: ["m1", "m2"],
        } as BoundaryContextPlan["transcript"],
        stages: [
            {
                name: "tools-old",
                label: "Pruned old tool calls/results",
                beforeTokens: 800_000,
                afterTokens: 400_000,
                clearedTokens: 400_000,
                changedMessages: 42,
                changedParts: 61,
                status: "applied",
            },
            {
                name: "reasoning",
                label: "Pruned thinking tokens",
                beforeTokens: 400_000,
                afterTokens: 300_000,
                clearedTokens: 100_000,
                changedMessages: 12,
                changedParts: 12,
                status: "applied",
            },
            {
                name: "assistant-runs",
                label: "Summarized assistant turns",
                beforeTokens: 300_000,
                afterTokens: 300_000,
                clearedTokens: 0,
                changedMessages: 0,
                changedParts: 0,
                status: "target-met",
            },
        ],
        summaryJobs: [],
        assistantSummaryKeys: [],
        assistantSummaries: {},
        ...overrides,
    } as BoundaryContextPlan
}

test("the report shows real per-stage numbers from the plan", () => {
    const frame = new ReportComponent(theme, reportFromPlan(plan()), () => {}).render(90).join("\n")

    assert.match(frame, /Pruned old tool calls\/results/)
    assert.match(frame, /400K freed · 42 msg/)
    assert.match(frame, /Pruned thinking tokens/)
    assert.match(frame, /100K freed · 12 msg/)
    // A stage that never had to run is reported as such, not as "applied".
    assert.match(frame, /Summarized assistant turns\s+target already met/)
    // Context meters carry the before/after the ladder actually achieved.
    assert.match(frame, /800K \/ 1000K/)
    assert.match(frame, /300K \/ 1000K/)
    assert.match(frame, /500K/) // reclaimed
    assert.match(frame, /better-compact\/ses_1\/hash\.md/)
})

test("the report reports pending background summaries and dismisses on esc", () => {
    let closed = false
    const component = new ReportComponent(theme, reportFromPlan(plan(), 3), () => {
        closed = true
    })
    assert.match(component.render(90).join("\n"), /Summarizing 3 assistant runs in the background/)

    component.handleInput("x")
    assert.equal(closed, false)
    component.handleInput("\x1b")
    assert.equal(closed, true)
})

test("a plan whose ladder never ran says so instead of rendering an empty list", () => {
    const frame = new ReportComponent(theme, reportFromPlan(plan({ stages: [] })), () => {}).render(
        90,
    )
    assert.match(frame.join("\n"), /No stages ran/)
})

test("the widget summarizes context, savings and background work on one line", () => {
    const state: WidgetState = {
        planActive: true,
        contextTokens: 300_000,
        contextLimit: 1_000_000,
        prunedTokens: 500_000,
        summarizing: { done: 2, total: 7 },
    }
    const line = renderWidgetLine(theme, state)

    assert.match(line, /Better Compact/)
    assert.match(line, /300K\/1000K/)
    assert.match(line, /−500K pruned/)
    assert.match(line, /summarizing 2\/7/)
    assert.equal(line.includes("\n"), false, "the widget must stay a single line")
})

test("the widget omits savings and summary segments when there is nothing to report", () => {
    const line = renderWidgetLine(theme, {
        planActive: true,
        contextTokens: 10_000,
        contextLimit: 200_000,
    })
    assert.match(line, /plan active/)
    assert.equal(/pruned/.test(line), false)
    assert.equal(/summarizing/.test(line), false)
})

test("token and meter formatting stay stable at boundaries", () => {
    assert.equal(formatTokens(999), "999")
    assert.equal(formatTokens(1_000), "1K")
    assert.equal(formatTokens(1_500), "1.5K")
    assert.equal(percent(0, 0), 0, "an unknown limit must not divide by zero")
    assert.equal(percent(300, 100), 100, "percentages are clamped")

    const bar = meter(50, 100, 10)
    assert.equal(bar.filled.length + bar.empty.length, 10)
    assert.equal(bar.percent, 50)
    assert.equal(meter(1, 0, 10).filled.length, 0, "a zero total renders an empty meter")
})
