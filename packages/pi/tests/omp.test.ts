import assert from "node:assert/strict"
import test from "node:test"
import { buildPlan, type BoundaryContextPlan, type Turn } from "@better-compact/core"
import { ompSpec } from "../src/omp/codec"
import {
    decideCompaction,
    firstKeptEntryIdForPlan,
    formatCompactionSummary,
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

test("a speculative trigger that pruning can satisfy declines the summary", () => {
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages)
    assert.equal(
        plan.requiresCustomCompaction,
        false,
        "the ladder should reach target by pruning this conversation",
    )

    for (const trigger of ["threshold", "idle"] as const) {
        assert.deepEqual(decide(trigger, plan, turns, branch), { kind: "prune" })
    }
})

test("recovery triggers never decline: overflow and incomplete always compact", () => {
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages)
    assert.equal(plan.requiresCustomCompaction, false)

    for (const trigger of ["overflow", "incomplete"] as const) {
        const decision = decide(trigger, plan, turns, branch)
        assert.equal(
            decision.kind,
            "compact",
            `${trigger} must produce headroom, never a cancelled run`,
        )
    }
})

test("manual compaction always commits rather than pruning", () => {
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages)

    const decision = decide("manual", plan, turns, branch)
    assert.equal(decision.kind, "compact")
})

test("a plan that exhausted pruning compacts even on a speculative trigger", () => {
    // One enormous turn the staged ladder cannot shrink below target forces the
    // prefix summary, which is the `requiresCustomCompaction` path.
    const messages: PiMessage[] = []
    let at = 1_000
    for (let round = 0; round < 4; round++) {
        messages.push(userMessage(`task ${round} ${"u".repeat(6_000)}`, at++))
        messages.push(
            assistantMessage([{ type: "text", text: `done ${round} ${"a".repeat(6_000)}` }], {
                timestamp: at++,
            }),
        )
    }
    messages.push(userMessage("wrap up", at++))
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages, 4_000)
    assert.equal(plan.requiresCustomCompaction, true)

    const decision = decide("threshold", plan, turns, branch)
    assert.equal(decision.kind, "compact")
    if (decision.kind !== "compact") return
    assert.ok(branch.entries.some((entry) => entry.id === decision.firstKeptEntryId))
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

test("the durable summary carries the ladder summary and its transcript reference", () => {
    const plan = {
        prefixSummary: "  Prior work: shipped the codec.  ",
        transcript: { relativePath: ".omp/better-compact/s/abc.md" },
    } as BoundaryContextPlan

    const summary = formatCompactionSummary(plan)
    assert.match(summary, /^\[Context Summary\]\n/)
    assert.match(summary, /Prior work: shipped the codec\./)
    assert.match(summary, /## Reference Files\n- "\.omp\/better-compact\/s\/abc\.md"$/)
})

test("a plan with no prefix summary yields no durable summary to persist", () => {
    const plan = { transcript: { relativePath: "x.md" } } as BoundaryContextPlan
    assert.equal(formatCompactionSummary(plan), "")
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
