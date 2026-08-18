import type { LadderSpec } from "@better-compact/core"
import {
    contentText,
    createPiFamilyCodec,
    LADDER_STAGES,
    pairOf,
    piFamilyCodecOps,
    toolConvention,
} from "../codec"
import type { OmpAgentMessage } from "./host"

export const ompCodec = createPiFamilyCodec<OmpAgentMessage>()

/** Oh My Pi's built-in planning tool. */
const TODO_TOOL = "todo"

const STATUS_GLYPH: Record<string, string> = {
    pending: " ",
    in_progress: "~",
    completed: "x",
    abandoned: "-",
    blocked: "!",
}

/**
 * Oh My Pi's `todo` tool result carries the whole phase list in
 * `ToolResultMessage.details` (`TodoToolDetails`), so the ladder can prune the
 * call/result pair and still restate the plan the agent was working to. Falls
 * back to the rendered result text when a host version stops populating
 * `details`, which keeps the reference honest rather than silently empty.
 */
export const ompSpec: LadderSpec = {
    codec: piFamilyCodecOps,
    conventions: {
        tool: toolConvention,
        todo: {
            isTodoItem: (item) => item.kind === "tool" && pairOf(item).call.name === TODO_TOOL,
            format: (item) => {
                if (item.kind !== "tool") return ""
                const result = pairOf(item).result
                if (!result) return ""
                return formatPhases(result.details) ?? contentText(result.content)
            },
        },
    },
    stages: LADDER_STAGES,
}

function formatPhases(details: unknown): string | null {
    if (typeof details !== "object" || details === null || !("phases" in details)) return null
    const { phases } = details
    if (!Array.isArray(phases)) return null

    const rendered: string[] = []
    for (const phase of phases) {
        if (typeof phase !== "object" || phase === null) continue
        if (!("name" in phase) || !("tasks" in phase)) continue
        if (typeof phase.name !== "string" || !Array.isArray(phase.tasks)) continue
        rendered.push(`${phase.name}: ${phase.tasks.map(formatTask).filter(Boolean).join("; ")}`)
    }
    return rendered.length > 0 ? rendered.join(" | ") : null
}

function formatTask(task: unknown): string {
    if (typeof task !== "object" || task === null || !("content" in task)) return ""
    if (typeof task.content !== "string") return ""
    const status = "status" in task && typeof task.status === "string" ? task.status : ""
    const blocker =
        status === "blocked" && "blocker" in task && typeof task.blocker === "string"
            ? ` (${task.blocker})`
            : ""
    return `[${STATUS_GLYPH[status] ?? " "}] ${task.content}${blocker}`
}
