import assert from "node:assert/strict"
import test from "node:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { createEventHandler } from "../lib/hooks"
import { createRuntimeState } from "../lib/state"
import { Logger } from "../lib/logger"
import { DEFAULT_CUSTOM_COMPACTION } from "@better-compact/core"
import type { PluginConfig } from "../lib/config"

test("automatic prune-only plans request native compaction once at idle", async () => {
    let calls = 0
    const client = createOpencodeClient({
        baseUrl: "https://native.test",
        fetch: async (request) => {
            const url = request instanceof Request ? request.url : String(request)
            if (url.endsWith("/summarize")) {
                calls++
                return Response.json(true)
            }
            return Response.json([
                {
                    info: {
                        role: "user",
                        id: "user",
                        sessionID: "native-session",
                        time: { created: 1 },
                        agent: "assistant",
                        model: { providerID: "test", modelID: "model" },
                    },
                    parts: [
                        {
                            type: "text",
                            id: "text",
                            messageID: "user",
                            sessionID: "native-session",
                            text: "Continue",
                        },
                    ],
                },
            ])
        },
    })
    const logger = new Logger(false)
    const errors: string[] = []
    logger.error = (message, detail) => {
        errors.push(`${message}: ${JSON.stringify(detail)}`)
    }
    const runtime = createRuntimeState(client, logger)
    runtime.get("native-session").boundary.activePlan = {
        sessionId: "native-session",
        rangeHash: "prune-only",
        rawTailStartMessageId: "user",
        transcriptRelativePath: "/archive/transcript.md",
        contextLimit: 1_000,
        beforeTokens: 900,
        afterPruneTokens: 300,
        targetTokens: 350,
        triggerTokens: 850,
        requiresCustomCompaction: false,
        createdAt: 1,
        bypassSummaries: true,
    }
    runtime.get("native-session").boundary.nativeCompactionNeeded = true
    const config: PluginConfig = {
        enabled: false,
        autoUpdate: false,
        debug: false,
        commands: { enabled: true },
        experimental: { allowSubAgents: false },
        compress: { permission: "allow" },
        compaction: {
            automatic: true,
            bypassSummaries: true,
            preset: "light",
            summaryEffort: "inherit",
            custom: { ...DEFAULT_CUSTOM_COMPACTION },
        },
    }
    const handler = createEventHandler(runtime, logger, client, () => config)
    assert.equal(calls, 0)
    await handler({ event: { type: "session.idle", properties: { sessionID: "native-session" } } })
    assert.equal(calls, 0, "a disabled plugin must not invoke native compaction")
    config.enabled = true
    await handler({ event: { type: "session.idle", properties: { sessionID: "native-session" } } })
    assert.equal(calls, 1, errors.join("\n"))
    await handler({ event: { type: "session.idle", properties: { sessionID: "native-session" } } })
    assert.equal(calls, 1, "an idle notification must not create a compaction loop")
    await handler({
        event: {
            type: "session.status",
            properties: { sessionID: "native-session", status: { type: "idle" } },
        },
    })
    assert.equal(calls, 1)
})
