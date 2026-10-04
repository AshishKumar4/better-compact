import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildPlan, type Codec, type Turn } from "@better-compact/core"
import { createRuntime } from "../src/runtime"
import { piSpec } from "../src/codec"
import { quietLogger } from "./helpers"

test("enabling bypass during awaited summary work returns a prune-only plan even on failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "better-compact-bypass-"))
    try {
        const file = join(directory, "better-compact.json")
        await writeFile(file, JSON.stringify({ bypassSummaries: false }))
        const textTurn = (key: string, role: "user" | "assistant", text: string): Turn => ({
            key,
            role,
            stamp: 1,
            items: [{ kind: "text", key, text, handle: { type: "text", text } }],
        })
        const turns = [
            textTurn("u1", "user", "directive"),
            textTurn("a1", "assistant", "long assistant prose ".repeat(10_000)),
            textTurn("u2", "user", "middle"),
            textTurn("a2", "assistant", "tail"),
            textTurn("u3", "user", "latest"),
        ]
        const codec: Codec<Turn> = {
            encode: (turns) => turns,
            decode: (turns) => turns,
            estimateItem: () => 1,
            estimateTurns: (turns) =>
                Math.ceil(
                    turns
                        .flatMap((turn) => turn.items)
                        .reduce(
                            (n, item) =>
                                n +
                                (item.kind === "text" || item.kind === "synthetic"
                                    ? item.text.length
                                    : 0),
                            0,
                        ) / 4,
                ),
            transcriptLine: (item) =>
                item.kind === "text" || item.kind === "synthetic" ? item.text : "",
        }
        let signalStarted = () => {}
        let finish: (value: string | null) => void = () => {}
        const started = new Promise<void>((resolve) => {
            signalStarted = resolve
        })
        const completed = new Promise<string | null>((resolve) => {
            finish = resolve
        })
        const spec = { ...piSpec, codec }
        const runtime = createRuntime({
            codec,
            spec,
            logger: quietLogger,
            ui: () => ({ notify() {}, setStatus() {}, showWidget() {} }),
            sessionId: () => "bypass-race",
            sessionDir: () => directory,
            branch: () => ({ getBranch: () => [] }),
            durableMessages: () => turns,
            contextWindow: () => 1_000,
            providerTokens: () => undefined,
            configPaths: () => ({ global: file, project: null }),
            appendEntry() {},
            summarizer: () => ({
                complete: async () => {
                    signalStarted()
                    return completed
                },
            }),
        })
        const ctx = {}
        await runtime.rehydrate(ctx)
        const inputs = { ...runtime.planInputs(ctx, 1_000), force: true }
        const plan = buildPlan(turns, inputs, spec)
        assert.ok(plan?.summaryJobs.length)
        const pending = runtime.summarizeNow(ctx, turns, inputs, plan)
        await started
        await runtime.saveConfig(ctx, { bypassSummaries: true })
        finish(null)
        const result = await pending
        assert.equal(result.bypassSummaries, true)
        assert.equal(result.requiresCustomCompaction, false)
        assert.deepEqual(result.assistantSummaryKeys, [])
        assert.deepEqual(result.summaryJobs, [])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
