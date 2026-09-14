import assert from "node:assert/strict"
import test from "node:test"
import { buildPlan, type BoundaryContextPlan, type Turn } from "@better-compact/core"
import {
    buildCompactionAnswer,
    COMPACTION_NO_PROGRESS_TOKENS,
    decideCompaction,
    firstKeptEntryIdForPlan,
    formatDurableCompaction,
    rewriteEntriesForPlan,
    type BranchEntry,
    type CompactionDecision,
    type CompactionTrigger,
} from "../src/omp/compaction"
import { ompSpec } from "../src/omp/codec"
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
    options: Partial<Parameters<typeof buildPlan>[1]> = {},
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
            ...options,
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

test("eighteen user messages survive as user entries across four cumulative rewrite rounds", () => {
    // The journal is one array that plan, answer and apply all share, exactly
    // as the host's branch is: each round plans over the previous round's
    // rewrites, never over a stale copy. Users are never rewritten, every
    // emitted rewrite changes its entry, and nothing is ever folded into a
    // synthesized blob.
    const contextLimit = 8_000
    const messages: PiMessage[] = []
    const originalUsers: PiMessage[] = []
    let at = 1_000
    const exchange = (label: string) => {
        const user = userMessage(`${label}: keep this exact instruction`, at++)
        originalUsers.push(user)
        messages.push(
            user,
            assistantMessage(
                [
                    { type: "thinking", thinking: `${label} reasoning ${"r".repeat(6_000)}` },
                    { type: "text", text: `Working on ${label}.` },
                    {
                        type: "toolCall",
                        id: `call_${label}`,
                        name: "bash",
                        arguments: { command: label },
                    },
                ],
                { stopReason: "toolUse", timestamp: at++ },
            ),
            toolResultMessage(`call_${label}`, `${label} output ${"x".repeat(12_000)}`, {
                timestamp: at++,
            }),
            assistantMessage([{ type: "text", text: `${label} done.` }], { timestamp: at++ }),
        )
    }
    const entries = (): BranchEntry[] =>
        messages.map((message, index) => ({ type: "message", id: `entry-${index}`, message }))

    for (let index = 0; index < 6; index++) exchange(`initial-${index}`)
    for (let round = 0; round < 4; round++) {
        for (let index = 0; index < 3; index++) exchange(`round-${round}-${index}`)
        const branchEntries = entries()
        const { plan, turns } = planFor(messages, contextLimit, {
            tailBudgetTokens: { floor: 1_000, ceiling: 3_000 },
        })
        const answer = buildCompactionAnswer(
            { trigger: "manual", plan, turns, messages, branchEntries },
            ompSpec,
        )
        assert.ok(answer?.rewrite && answer.rewrite.length > 0, `round ${round} must rewrite`)
        for (const { entryId, message } of answer.rewrite) {
            const index = Number(entryId.slice("entry-".length))
            const current = messages[index]
            assert.notEqual(current.role, "user", "rewrites never target a user entry")
            assert.equal(message.role, current.role, "a rewrite keeps the entry's role")
            assert.notDeepEqual(message, current, "a rewrite must change its entry")
            messages[index] = message
        }
    }

    assert.equal(originalUsers.length, 18)
    assert.deepEqual(
        messages.filter((message) => message.role === "user"),
        originalUsers,
        "every user message survives in place, byte-identical",
    )
})

test("an oversized assistant turn is reduced in place, never kept raw or split", () => {
    // The tail budget is capped at the target, so a turn larger than the
    // target can never sit in the raw tail: it lands in the prefix and the
    // rewrite shrinks that entry where it stands. The last user turn stays
    // exact, by identity.
    const big = assistantMessage(
        [
            { type: "thinking", thinking: "h".repeat(30_000) },
            { type: "text", text: "preamble " + "p".repeat(30_000) },
            { type: "toolCall", id: "call_big", name: "bash", arguments: { command: "big" } },
            { type: "text", text: "surviving tail " + "s".repeat(30_000) },
        ],
        { stopReason: "toolUse", timestamp: 2_000 },
    )
    const messages: PiMessage[] = [
        userMessage("tackle the big job", 1_000),
        big,
        toolResultMessage("call_big", "big output " + "b".repeat(30_000), { timestamp: 3_000 }),
        userMessage("the exact, non-partial last user turn", 4_000),
    ]
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages, 10_000, {
        tailBudgetTokens: { floor: 20_000, ceiling: 60_000 },
    })
    assert.equal(plan.rawTailItemBoundary, undefined, "the budget never splits a turn")
    assert.equal(turns[plan.rawTailStartIndex]?.role, "user")

    const answer = buildCompactionAnswer(
        {
            trigger: "manual",
            plan,
            turns,
            messages: branch.messages,
            branchEntries: branch.entries,
        },
        ompSpec,
    )
    assert.ok(answer?.rewrite && answer.rewrite.length > 0)
    assert.equal(answer.compaction, undefined, "no durable boundary is needed for a rewrite")
    const rewrittenIds = new Set(answer.rewrite.map(({ entryId }) => entryId))
    assert.ok(rewrittenIds.has("entry-1") && rewrittenIds.has("entry-2"))
    assert.ok(
        answer.rewrite.every(({ message }) => message.role !== "user"),
        "no rewrite may target the user tail",
    )
    assert.ok(answer.tokensFreed > 20_000)
})

test("a rewrite under the dead-band declines instead of inventing a summary", () => {
    // Compaction that frees less than the dead-band must hand back cleanly:
    // fabricating a summary to justify the pass would write a worse prefix
    // over good history.
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const turns = piCodec.encode(messages)
    const plan = buildPlan(
        turns,
        {
            // A window so wide nothing meaningful needs pruning: the ladder
            // still plans (force), but before/after land inside the dead-band.
            contextLimit: 400_000,
            sessionKey: "session-1",
            citablePath: (sessionKey, rangeHash) => `/s/${sessionKey}/${rangeHash}.md`,
            force: true,
        },
        ompSpec,
    )
    assert.ok(plan)
    const rewrite = rewriteEntriesForPlan(plan, turns, branch.entries, ompSpec)
    assert.ok(
        rewrite.tokensFreed < COMPACTION_NO_PROGRESS_TOKENS,
        "the rewrite must sit under the no-progress dead-band for this test",
    )

    const answer = buildCompactionAnswer(
        {
            trigger: "manual",
            plan,
            turns,
            messages: branch.messages,
            branchEntries: branch.entries,
        },
        ompSpec,
    )
    assert.equal(answer, undefined)
})

test("prefixSummaryAllowed false answers the last resort with a rewrite, never a merged prefix", () => {
    // Even when the target is unreachable, an opted-out last resort must not
    // invent a durable summary: the rewrite-only answer keeps every real
    // entry and declines the compaction boundary entirely.
    const messages = overTriggerConversation()
    const branch = branchOf(messages)
    const turns = piCodec.encode(messages)
    const plan = buildPlan(
        turns,
        {
            contextLimit: 500,
            sessionKey: "session-1",
            citablePath: (sessionKey, rangeHash) => `/s/${sessionKey}/${rangeHash}.md`,
            force: true,
            prefixSummaryAllowed: false,
        },
        ompSpec,
    )
    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, false)
    assert.ok(!plan.stages.some((stage) => stage.name === "prefix-summary"))

    const answer = buildCompactionAnswer(
        {
            trigger: "manual",
            plan,
            turns,
            messages: branch.messages,
            branchEntries: branch.entries,
        },
        ompSpec,
    )
    if (answer !== undefined) {
        assert.ok(answer.rewrite && answer.rewrite.length > 0)
        assert.equal(answer.compaction, undefined)
    }
})

test("the dead-band measures what the journal actually frees, not the plan's projection", () => {
    // Hundreds of short assistant messages collapse to one summary in the
    // projection, but a rewrite cannot delete entries: each becomes a stub
    // nearly as long as the original. The projection clears the dead-band,
    // the durable rewrite does not, and the honest answer is to decline.
    const messages: PiMessage[] = [userMessage("chatter", 1)]
    for (let index = 0; index < 400; index++) {
        messages.push(
            assistantMessage([{ type: "text", text: `short note ${index} ${"n".repeat(80)}` }], {
                timestamp: 2 + index,
            }),
        )
    }
    messages.push(userMessage("and now the real question", 1_000))
    const branch = branchOf(messages)
    const { plan, turns } = planFor(messages, 4_000, {
        tailBudgetTokens: { floor: 500, ceiling: 1_500 },
    })
    assert.ok(
        plan.beforeTokens - plan.afterPruneTokens >= COMPACTION_NO_PROGRESS_TOKENS,
        "the projection must clear the dead-band for this test to mean anything",
    )
    const rewrite = rewriteEntriesForPlan(plan, turns, branch.entries, ompSpec)
    assert.ok(rewrite.tokensFreed < COMPACTION_NO_PROGRESS_TOKENS)
    assert.equal(
        buildCompactionAnswer(
            {
                trigger: "threshold",
                plan,
                turns,
                messages: branch.messages,
                branchEntries: branch.entries,
            },
            ompSpec,
        ),
        undefined,
    )
})

test("reprocessing an already-rewritten branch emits nothing for unchanged entries", () => {
    const messages = overTriggerConversation()
    const first = planFor(messages)
    const firstRewrite = rewriteEntriesForPlan(
        first.plan,
        first.turns,
        branchOf(messages).entries,
        ompSpec,
    )
    assert.ok(firstRewrite.entries.length > 0)
    for (const { entryId, message } of firstRewrite.entries) {
        messages[Number(entryId.slice("entry-".length))] = message
    }

    const second = planFor(messages)
    const branch = branchOf(messages)
    const secondRewrite = rewriteEntriesForPlan(second.plan, second.turns, branch.entries, ompSpec)
    for (const { entryId, message } of secondRewrite.entries) {
        assert.notDeepEqual(message, branch.messages[Number(entryId.slice("entry-".length))])
    }
    const firstIds = new Set(firstRewrite.entries.map((entry) => entry.entryId))
    const stubbedToolResults = firstRewrite.entries.filter(
        (entry) => entry.message.role === "toolResult",
    )
    assert.ok(stubbedToolResults.length > 0)
    assert.ok(
        secondRewrite.entries.every(
            (entry) => !firstIds.has(entry.entryId) || entry.message.role !== "toolResult",
        ),
        "a tool result stubbed last round is content-identical this round and must not be re-emitted",
    )
})
