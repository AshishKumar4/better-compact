import assert from "node:assert/strict"
import test from "node:test"
import { buildPlan, type BoundaryContextPlan, type Turn } from "@better-compact/core"
import { ompSpec } from "../src/omp/codec"
import {
    decideCompaction,
    firstKeptEntryIdForPlan,
    formatDurableCompaction,
    type BranchEntry,
    type CompactionDecision,
    type CompactionTrigger,
} from "../src/omp/compaction"
import { piCodec, type PiMessage } from "../src/codec"
import { assistantMessage, toolResultMessage, userMessage } from "./fixtures"
import { overTriggerConversation } from "./helpers"

// `src/omp.ts` itself imports Oh My Pi at runtime, which only loads under Bun
// (the host's source uses `with { type: "text" }` imports). The decision policy,
// boundary mapping, summary rendering and codec conventions are deliberately
// host-free so they can be exercised here; the wiring around them is covered by
// the live smoke run.

/** Session entries as Oh My Pi records them, paired with the messages they emit. */
interface Branch {
    entries: BranchEntry[]
    messages: PiMessage[]
}

function branchOf(messages: PiMessage[]): Branch {
    return {
        entries: messages.map((message, index) => ({
            type: "message",
            id: `entry-${index}`,
            message,
        })),
        messages,
    }
}

function planFor(
    messages: PiMessage[],
    contextLimit = 6_000,
): {
    plan: BoundaryContextPlan
    turns: Turn[]
} {
    const turns = piCodec.encode(messages)
    const plan = buildPlan(
        turns,
        {
            contextLimit,
            sessionKey: "session-1",
            citablePath: (sessionKey, rangeHash) => `/s/${sessionKey}/${rangeHash}.md`,
            force: true,
        },
        ompSpec,
    )
    assert.ok(plan, "expected a plan for an over-trigger conversation")
    return { plan, turns }
}

function decide(
    trigger: CompactionTrigger,
    plan: BoundaryContextPlan,
    turns: Turn[],
    branch: Branch,
): CompactionDecision {
    return decideCompaction({
        trigger,
        plan,
        turns,
        messages: branch.messages,
        branchEntries: branch.entries,
    })
}

test("every trigger commits a compaction rather than cancelling the host's run", () => {
    // `{cancel:true}` is not a quiet answer: the host anchors its threshold on
    // stored history, which request pruning cannot move, so a declined run is
    // re-entered every turn and every mid-turn tool boundary.
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages)

    for (const trigger of ["threshold", "idle", "overflow", "incomplete", "manual"] as const) {
        const decision = decide(trigger, plan, turns, branch)
        assert.equal(decision.kind, "compact", `${trigger} must commit a compaction`)
    }
})

test("a plan whose boundary splits a turn is handed back to the host", () => {
    // An item boundary only appears for a turn that alone exceeds the target.
    // Rounding it out to the whole turn would reinstate that turn and leave the
    // committed context bigger than the plan promised, which is what the host's
    // post-compaction headroom and retry-fit checks measure.
    const messages = overTriggerConversation()
    messages.push(
        assistantMessage(
            Array.from({ length: 12 }, (_, index) => ({
                type: "text" as const,
                text: `chunk ${index} ${"z".repeat(2_000)}`,
            })),
            { timestamp: 9_000 },
        ),
    )
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages, 6_000)
    assert.ok(
        plan.rawTailItemBoundary,
        "expected the oversized trailing turn to force an item boundary",
    )

    const decision = decide("overflow", plan, turns, branch)
    assert.deepEqual(decision, { kind: "decline", reason: "plan boundary splits a turn" })
})

test("no plan declines the run so native compaction still happens", () => {
    const branch = branchOf([userMessage("hi", 1)])
    assert.deepEqual(
        decideCompaction({
            trigger: "overflow",
            plan: null,
            turns: [],
            messages: branch.messages,
            branchEntries: branch.entries,
        }),
        { kind: "decline", reason: "no plan for this context" },
    )
})

test("a branch with no message entries declines instead of guessing a boundary", () => {
    const messages = overTriggerConversation()
    const { plan, turns } = planFor(messages)
    const decision = decideCompaction({
        trigger: "overflow",
        plan,
        turns,
        messages,
        branchEntries: [{ type: "custom", id: "c1" }],
    })
    assert.equal(decision.kind, "decline")
})

test("the boundary maps to the entry that owns the first kept message", () => {
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages)

    const entryId = firstKeptEntryIdForPlan(plan, turns, messages, branch.entries)
    assert.ok(entryId)
    const boundaryMessage = (turns[plan.rawTailStartIndex].handle as PiMessage[])[0]
    assert.equal(entryId, `entry-${messages.indexOf(boundaryMessage)}`)
})

test("a boundary on a synthesized message walks back to a real entry, never past it", () => {
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages)
    const boundaryIndex = messages.indexOf((turns[plan.rawTailStartIndex].handle as PiMessage[])[0])

    // Drop the boundary's own entry, as if it had been emitted by a
    // custom-message or summary entry that carries no reusable message identity.
    const withoutBoundary = branch.entries.filter((entry) => entry.id !== `entry-${boundaryIndex}`)
    const entryId = firstKeptEntryIdForPlan(plan, turns, messages, withoutBoundary)

    assert.ok(entryId)
    const keptFrom = Number(entryId!.slice("entry-".length))
    assert.ok(keptFrom < boundaryIndex, "walking back must keep more raw history, never less")
})

test("the durable context carries the pruned prefix and its transcript reference", () => {
    const messages = overTriggerConversation()
    const { plan, turns } = planFor(messages)

    const summary = formatDurableCompaction(plan, turns, ompSpec)
    assert.match(summary, /^\[Better Compact context\]\n/)
    assert.match(summary, /## Reference Files\n- "\/s\/session-1\//)

    // The point of serializing the transformed prefix rather than reading
    // `plan.prefixSummary`: what the ladder actually did has to survive.
    assert.match(summary, /please do task 0/, "preserved user turns must survive")
    assert.match(summary, /\[tool/, "pruned tool calls must leave their stubs")

    // And it must be smaller than the raw prefix it replaces.
    const rawPrefix = turns
        .slice(0, plan.rawTailStartIndex)
        .flatMap((turn) => turn.items.map((item) => ompSpec.codec.transcriptLine(item)))
        .join("\n").length
    assert.ok(summary.length < rawPrefix, "the durable context must be smaller than raw history")
})

test("the todo convention restates the latest plan from the tool result details", () => {
    const messages: PiMessage[] = [
        userMessage("plan it", 1),
        assistantMessage(
            [{ type: "toolCall", id: "call_todo", name: "todo", arguments: { op: "init" } }],
            { stopReason: "toolUse", timestamp: 2 },
        ),
        toolResultMessage("call_todo", "ok", { timestamp: 3 }),
    ]
    const result = messages[2] as Extract<PiMessage, { role: "toolResult" }>
    result.details = {
        phases: [
            {
                name: "Build",
                tasks: [
                    { content: "write codec", status: "completed" },
                    { content: "wire host", status: "in_progress" },
                    { content: "await review", status: "blocked", blocker: "needs approval" },
                ],
            },
        ],
    }

    const turns = piCodec.encode(messages)
    const toolItem = turns[1].items.find((item) => item.kind === "tool")
    assert.ok(toolItem)
    assert.ok(ompSpec.conventions.todo?.isTodoItem(toolItem))
    assert.equal(
        ompSpec.conventions.todo?.format(toolItem),
        "Build: [x] write codec; [~] wire host; [!] await review (needs approval)",
    )
})

test("a todo result without structured details falls back to its rendered text", () => {
    const messages: PiMessage[] = [
        userMessage("plan it", 1),
        assistantMessage([{ type: "toolCall", id: "c1", name: "todo", arguments: {} }], {
            stopReason: "toolUse",
            timestamp: 2,
        }),
        toolResultMessage("c1", "1 task pending", { timestamp: 3 }),
    ]
    const turns = piCodec.encode(messages)
    const toolItem = turns[1].items.find((item) => item.kind === "tool")
    assert.ok(toolItem)
    assert.equal(ompSpec.conventions.todo?.format(toolItem), "1 task pending")
})

test("a non-todo tool is not mistaken for the plan", () => {
    const messages: PiMessage[] = [
        userMessage("read it", 1),
        assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }], {
            stopReason: "toolUse",
            timestamp: 2,
        }),
        toolResultMessage("c1", "contents", { timestamp: 3 }),
    ]
    const turns = piCodec.encode(messages)
    const toolItem = turns[1].items.find((item) => item.kind === "tool")
    assert.ok(toolItem)
    assert.equal(ompSpec.conventions.todo?.isTodoItem(toolItem), false)
})
