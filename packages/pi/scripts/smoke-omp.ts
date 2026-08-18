/**
 * Live smoke for the Oh My Pi adapter, run against the real host runtime.
 *
 * The unit tests cover the host-free decision policy, boundary mapping and
 * codec. They cannot cover the thing that actually broke the pi adapter under
 * Oh My Pi: whether the built artifact *loads* and whether the host APIs it
 * calls exist and behave. So this script imports the built `dist/omp.js`, drives
 * it with the same events the host emits, and reconstructs context through Oh My
 * Pi's own `buildSessionContext`.
 *
 * Must run under Bun: the host's own source uses `with { type: "text" }`
 * imports, so Node cannot load `@oh-my-pi/pi-coding-agent`.
 *
 *   bun run packages/pi/scripts/smoke-omp.ts
 */
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSessionContext, VERSION } from "@oh-my-pi/pi-coding-agent"

/** Shape of the built artifact under test. */
interface ExtensionFactory {
    default: (api: unknown) => void
}

interface Recorded {
    handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
    commands: Map<string, { description?: string; handler: unknown }>
    entries: Array<{ customType: string; data: unknown }>
    notices: string[]
}

function label(step: string): void {
    process.stdout.write(`  ${step}\n`)
}

async function main(): Promise<void> {
    process.stdout.write(`Oh My Pi ${VERSION}\n`)

    // Dynamic on purpose: loading the built artifact is exactly what this smoke
    // proves, and `dist/omp.js` does not exist until `pnpm build` has run.
    const factory = (await import("../dist/omp.js")) as ExtensionFactory

    const recorded: Recorded = {
        handlers: new Map(),
        commands: new Map(),
        entries: [],
        notices: [],
    }

    const sessionDir = await mkdtemp(join(tmpdir(), "better-compact-omp-smoke-"))
    const agentDir = await mkdtemp(join(tmpdir(), "better-compact-omp-agent-"))
    process.env.OMP_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_DIR = agentDir

    // The over-trigger conversation: tool-heavy assistant turns with thinking,
    // then a short raw tail — enough history to cross an 8k window's trigger.
    const branch = buildBranch()
    const contextWindow = 8_000

    const ctx = {
        hasUI: false,
        mode: "print" as const,
        model: { id: "smoke/model", contextWindow, input: ["text"], provider: "smoke" },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: false as const, error: "offline smoke" }),
        },
        cwd: sessionDir,
        sessionManager: {
            getSessionId: () => "smoke-session",
            getSessionDir: () => sessionDir,
            getBranch: () => branch.entries,
        },
        getContextUsage: () => ({ tokens: 7_200, contextWindow, percent: 90 }),
        ui: {
            notify: (message: string) => recorded.notices.push(message),
            setStatus: () => {},
            setWidget: () => {},
            custom: async () => undefined,
        },
        compact: async () => {},
    }

    factory.default({
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
            recorded.handlers.set(event, handler)
        },
        registerCommand: (name: string, options: { description?: string; handler: unknown }) => {
            recorded.commands.set(name, options)
        },
        appendEntry: (customType: string, data: unknown) => {
            recorded.entries.push({ customType, data })
        },
    })

    label("extension loaded and registered its handlers")
    for (const event of [
        "session_start",
        "session_switch",
        "session_branch",
        "session_tree",
        "session_compact",
        "session_before_compact",
        "auto_compaction_start",
        "auto_compaction_end",
        "context",
    ]) {
        assert.ok(recorded.handlers.has(event), `missing handler: ${event}`)
    }
    for (const command of [
        "better-compact",
        "better-compact-report",
        "better-compact-settings",
        "better-compact-preset",
    ]) {
        assert.ok(recorded.commands.has(command), `missing command: /${command}`)
    }

    const call = async (event: string, payload: Record<string, unknown>): Promise<unknown> => {
        const handler = recorded.handlers.get(event)
        assert.ok(handler, `no handler for ${event}`)
        return await handler({ type: event, ...payload }, ctx)
    }

    await call("session_start", {})
    label("session_start rehydrated without touching the host's settings")

    // The host rebuilds context exactly this way before every request.
    const messages = buildSessionContext(branch.entries).messages
    assert.ok(messages.length > 10, "expected the smoke branch to produce a real conversation")
    label(`buildSessionContext produced ${messages.length} messages`)

    const transformed = (await call("context", { messages })) as
        { messages?: unknown[] } | undefined
    assert.ok(transformed?.messages, "the context transform returned no replacement")
    assert.ok(
        transformed.messages.length <= messages.length,
        "the transform must not grow the request",
    )
    const reference = JSON.stringify(transformed.messages)
    assert.match(reference, /\[Better Compact context pruning applied\]/)
    label(`context transform pruned to ${transformed.messages.length} messages with a reference`)

    const preparation = {
        firstKeptEntryId: branch.entries.at(-3)!.id,
        messagesToSummarize: messages.slice(0, -3),
        turnPrefixMessages: [],
        recentMessages: messages.slice(-3),
        isSplitTurn: false,
        tokensBefore: 7_200,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, keepRecentTokens: 2_000 },
    }
    const compactEvent = {
        preparation,
        branchEntries: branch.entries,
        customInstructions: undefined,
        signal: AbortSignal.timeout(25_000),
    }

    // Every trigger commits: `{cancel:true}` would be re-entered by the host on
    // the next turn and at every mid-turn tool boundary, because its threshold
    // is anchored on stored history that request pruning cannot move.
    for (const reason of ["threshold", "idle", "overflow", "incomplete"] as const) {
        await call("auto_compaction_start", { reason, action: "context-full" })
        const result = (await call("session_before_compact", compactEvent)) as
            | { cancel?: boolean; compaction?: Record<string, unknown> }
            | undefined
        assert.notEqual(result?.cancel, true, `${reason} must not cancel the host's run`)
        assert.ok(result?.compaction, `${reason} must return a durable compaction`)
        await call("auto_compaction_end", { action: "context-full", aborted: false, willRetry: false })
    }
    label("every automatic trigger committed a Better Compact compaction")

    await call("auto_compaction_start", { reason: "overflow", action: "context-full" })
    const recovery = (await call("session_before_compact", compactEvent)) as
        | { cancel?: boolean; compaction?: Record<string, unknown> }
        | undefined
    assert.ok(recovery?.compaction, "an overflow run must return a durable compaction")
    const compaction = recovery.compaction
    assert.ok(
        branch.entries.some((entry) => entry.id === compaction.firstKeptEntryId),
        "firstKeptEntryId must name a real entry on the branch",
    )
    assert.match(String(compaction.summary), /^\[Better Compact context\]/)
    assert.match(String(compaction.summary), /## Reference Files/)
    assert.match(
        String(compaction.summary),
        /please do task 0/,
        "the durable context must keep the user turns the ladder preserved",
    )
    assert.equal(compaction.tokensBefore, 7_200)
    label("overflow trigger returned a committed Better Compact compaction")

    // What the host does with that result: one summary, then the kept tail.
    const committed = buildSessionContext([
        ...branch.entries,
        {
            type: "compaction",
            id: "compaction-1",
            parentId: branch.entries.at(-1)!.id,
            timestamp: Date.now(),
            summary: String(compaction.summary),
            shortSummary: String(compaction.shortSummary ?? ""),
            firstKeptEntryId: String(compaction.firstKeptEntryId),
            tokensBefore: 7_200,
        },
    ]).messages
    assert.ok(
        committed.length < messages.length,
        `committing the compaction must shrink context (${messages.length} -> ${committed.length})`,
    )
    assert.match(JSON.stringify(committed), /\[Better Compact context\]/)
    label(`host replayed the compaction as ${committed.length} messages`)

    process.stdout.write("\nOK — Better Compact owns compaction in Oh My Pi.\n")
}

interface SmokeBranch {
    entries: Array<Record<string, unknown> & { id: string }>
}

function buildBranch(): SmokeBranch {
    const entries: SmokeBranch["entries"] = []
    let at = 1_000
    const push = (message: Record<string, unknown>): void => {
        const id = `entry-${entries.length}`
        entries.push({
            type: "message",
            id,
            parentId: entries.at(-1)?.id,
            timestamp: at,
            message,
        })
        at++
    }

    for (let round = 0; round < 6; round++) {
        push({ role: "user", content: `please do task ${round}`, timestamp: at })
        push({
            role: "assistant",
            api: "anthropic-messages",
            provider: "smoke",
            model: "smoke/model",
            stopReason: "toolUse",
            usage: {},
            content: [
                { type: "thinking", thinking: `reasoning ${round} ${"t".repeat(1_400)}` },
                { type: "text", text: `Working on task ${round}.` },
                {
                    type: "toolCall",
                    id: `call_${round}`,
                    name: "bash",
                    arguments: { command: `run ${round}` },
                },
            ],
            timestamp: at,
        })
        push({
            role: "toolResult",
            toolCallId: `call_${round}`,
            toolName: "bash",
            content: [{ type: "text", text: `output ${round} ${"o".repeat(4_800)}` }],
            isError: false,
            timestamp: at,
        })
        push({
            role: "assistant",
            api: "anthropic-messages",
            provider: "smoke",
            model: "smoke/model",
            stopReason: "stop",
            usage: {},
            content: [{ type: "text", text: `Task ${round} done.` }],
            timestamp: at,
        })
    }
    push({ role: "user", content: "what is left?", timestamp: at })
    push({
        role: "assistant",
        api: "anthropic-messages",
        provider: "smoke",
        model: "smoke/model",
        stopReason: "stop",
        usage: {},
        content: [{ type: "text", text: "Nothing, all done." }],
        timestamp: at,
    })
    push({ role: "user", content: "great, wrap up", timestamp: at })

    return { entries }
}

await main()
