import assert from "node:assert/strict"
import test from "node:test"
import {
    attachmentCodec,
    buildPlan,
    createEngine,
    preparePlan,
    replayPlanSnapshot,
    toPlanSnapshot,
    transformTurns,
    toolsOldStage,
    toolsRemainingStage,
    assistantRunsStage,
    countTokens,
    type Attachment,
    type AttachmentPolicy,
    type BuildPlanInputs,
    type CodecOps,
    type EnginePorts,
    type Item,
    type LadderSpec,
    type PlanSnapshot,
    type Turn,
} from "@better-compact/core"

const logger = { info() {}, debug() {}, warn() {}, error() {} }
const inputs: BuildPlanInputs = {
    sessionKey: "attachments",
    contextLimit: 10_000,
    targetRatio: 0.1,
    force: true,
    bypassSummaries: true,
    citablePath: () => "/archive/transcript.md",
}

function fixture() {
    const payloads = new Map<Item, readonly Attachment[]>()
    const stored: string[] = []
    const estimates = new Map<string, number>()
    function media(key: string, kind: "image" | "file" = "image", tool = false): Item {
        const attachment: Attachment = {
            id: key,
            kind,
            mimeType: kind === "image" ? "image/png" : "application/pdf",
            ...(kind === "image" ? { width: 1280, height: 800 } : {}),
        }
        const item: Item = tool
            ? { kind: "tool", key, callId: key, handle: { bytes: key } }
            : { kind: "opaque", key, handle: { bytes: key } }
        payloads.set(item, [attachment])
        estimates.set(key, 3_000)
        return item
    }
    const codec: CodecOps = {
        estimateTurns: (turns) =>
            turns.reduce(
                (total, turn) =>
                    total +
                    turn.items.reduce(
                        (n, item) =>
                            n +
                            (item.kind === "text" || item.kind === "synthetic"
                                ? countTokens(item.text)
                                : 1_200),
                        0,
                    ),
                0,
            ),
        estimateItem: () => 1_200,
        transcriptLine: (item) =>
            item.kind === "text" || item.kind === "synthetic" ? item.text : item.key,
    }
    const policy: AttachmentPolicy = {
        key: "provider/model-a",
        list: (item) => payloads.get(item) ?? [],
        estimateTokens: (attachment) => estimates.get(attachment.id),
        replace: (item, _attachment, text) => ({ kind: "synthetic", key: item.key, text }),
        async store(attachment, _item, location) {
            assert.equal(location.sessionKey, "attachments")
            stored.push(attachment.id)
            return `/workspace/media/${attachment.id}`
        },
    }
    const spec: LadderSpec = {
        codec,
        conventions: {},
        attachments: policy,
        stages: [toolsOldStage, toolsRemainingStage, assistantRunsStage],
    }
    const user = (key: string, items: Item[]): Turn => ({ key, role: "user", stamp: 1, items })
    const text = (key: string): Item => ({
        kind: "text",
        key,
        text: `instruction ${key}`,
        handle: { text: key },
    })
    const oldImage = media("old-image")
    const oldFile = media("old-file", "file")
    const recentImage = media("recent-image")
    const newestImage = media("newest-image")
    const oldText = text("old")
    const turns = [
        user("u1", [oldText, oldImage, oldFile]),
        user("u2", [text("middle"), recentImage]),
        user("u3", [text("tail1")]),
        user("u4", [text("tail2"), newestImage]),
    ]
    return {
        turns,
        codec,
        policy,
        spec,
        payloads,
        stored,
        estimates,
        oldImage,
        oldFile,
        oldText,
        recentImage,
        newestImage,
        media,
    }
}

test("offloads before tool stages, preserves user prose and the last two images", async () => {
    const f = fixture()
    const dry = buildPlan(f.turns, inputs, f.spec)
    assert.ok(dry)
    assert.deepEqual(f.stored, [], "synchronous planning must not write files")
    const plan = await preparePlan(f.turns, inputs, f.spec, logger)
    assert.ok(plan)
    assert.deepEqual(f.stored, ["old-image", "old-file"])
    assert.equal(plan.stages[0].name, "attachments")
    assert.equal(plan.stages[0].changedParts, 2)
    const out = transformTurns(f.turns, plan.rawTailStartIndex, plan, f.spec)
    const items = out.flatMap((turn) => turn.items)
    assert.ok(items.includes(f.oldText))
    assert.ok(items.includes(f.recentImage))
    assert.ok(items.includes(f.newestImage))
    assert.ok(!items.includes(f.oldImage))
    const references = items.filter(
        (item) => item.kind === "synthetic" && item.provenance?.origin === "attachment-reference",
    )
    assert.equal(references.length, 2)
    assert.deepEqual(
        references.flatMap((item) =>
            item.kind === "synthetic" ? (item.provenance?.sources ?? []) : [],
        ),
        [f.oldImage.key, f.oldFile.key],
    )
    assert.ok(
        items.some(
            (item) =>
                item.kind === "synthetic" &&
                item.text === "[image/png 1280x800 → /workspace/media/old-image]",
        ),
    )
    assert.equal(plan.afterPruneTokens, attachmentCodec(f.codec, f.policy).estimateTurns(out))
    assert.ok(f.turns[0].items.includes(f.oldImage), "source transcript is never mutated")
    const replay = replayPlanSnapshot(f.turns, toPlanSnapshot(plan), f.spec, { allowRegrown: true })
    assert.deepEqual(replay, out)
    assert.deepEqual(f.stored, ["old-image", "old-file"], "replay must not re-store bytes")
})

test("the active provider's media estimate governs pressure; tiny or unpriced media stay", async () => {
    const f = fixture()
    const request = { ...inputs, force: false, contextLimit: 15_000 }
    assert.equal(buildPlan(f.turns, request, f.spec), null)
    f.estimates.set("old-image", 20_000)
    const plan = await preparePlan(f.turns, request, f.spec, logger)
    assert.ok(plan, "provider cost, not fixed 1,200/image, must cross the trigger")
    const tiny = fixture()
    tiny.estimates.set("old-image", 1)
    tiny.estimates.delete("old-file")
    const small = await preparePlan(tiny.turns, inputs, tiny.spec, logger)
    assert.ok(small)
    assert.deepEqual(tiny.stored, [])
    assert.equal(small.stages[0].changedParts, 0)
})

test("missing links, storage errors, and links costing more than media retain originals", async () => {
    for (const fail of ["null", "throw", "large-link"]) {
        const f = fixture()
        f.policy.store = async () => {
            if (fail === "throw") throw new Error("disk unavailable")
            return fail === "null" ? null : "x".repeat(100_000)
        }
        const plan = await preparePlan(f.turns, inputs, f.spec, logger)
        assert.ok(plan)
        const out = transformTurns(f.turns, plan.rawTailStartIndex, plan, f.spec)
        const items = out.flatMap((turn) => turn.items)
        assert.ok(items.includes(f.oldImage))
        assert.ok(items.includes(f.oldFile))
        assert.equal(plan.stages[0].changedParts, 0)
    }
})

test("the entire recent tail and existing compaction archives remain intact", async () => {
    const f = fixture()
    f.policy.keepRecentImages = 0
    f.spec.conventions.isPreservedItem = (item) => item === f.oldImage
    const plan = await preparePlan(f.turns, inputs, f.spec, logger)
    assert.ok(plan)
    assert.ok(!f.stored.includes("old-image"))
    assert.ok(!f.stored.includes("newest-image"))
    const out = transformTurns(f.turns, plan.rawTailStartIndex, plan, f.spec)
    assert.ok(out.flatMap((turn) => turn.items).includes(f.newestImage))
    assert.ok(out.flatMap((turn) => turn.items).includes(f.oldImage))
})

test("retained media inside tool results cannot be lost to later tool or summary stages", async () => {
    const f = fixture()
    const tool = f.media("tool-image", "image", true)
    f.turns.splice(1, 0, { key: "assistant-tool", role: "assistant", stamp: 2, items: [tool] })
    f.policy.keepRecentImages = 10
    const plan = await preparePlan(f.turns, { ...inputs, bypassSummaries: false }, f.spec, logger)
    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, false)
    assert.ok(
        transformTurns(f.turns, plan.rawTailStartIndex, plan, f.spec)
            .flatMap((turn) => turn.items)
            .includes(tool),
    )
})

test("createEngine awaits storage, persists links, and invalidates model-specific replay", async () => {
    const f = fixture()
    let snapshot: PlanSnapshot | null = null
    const ports: EnginePorts = {
        logger,
        transcripts: { citablePath: () => "/archive/transcript.md", write: async () => ({}) },
        plans: {
            load: () => snapshot,
            save: (_key, plan) => {
                snapshot = plan
            },
        },
    }
    const engine = createEngine(f.spec, ports)
    const first = await engine.process({ ...inputs, turns: f.turns })
    assert.equal(first.outcome, "planned")
    assert.deepEqual(f.stored, ["old-image", "old-file"])
    assert.ok(snapshot)
    f.policy.key = "provider/model-b"
    assert.equal(replayPlanSnapshot(f.turns, snapshot, f.spec, { allowRegrown: true }), null)
})

test("attachment links survive assistant previews and opt-in prefix summaries, including replay", async () => {
    for (const prefixSummaryAllowed of [false, true]) {
        const f = fixture()
        f.policy.keepRecentImages = 0
        const image = f.media("assistant-image")
        f.turns.splice(1, 0, {
            key: "long-assistant",
            role: "assistant",
            stamp: 2,
            items: [
                { kind: "text", key: "long-prose", text: "long prose ".repeat(1_000), handle: {} },
                image,
            ],
        })
        const plan = await preparePlan(
            f.turns,
            { ...inputs, contextLimit: 100, bypassSummaries: false, prefixSummaryAllowed },
            f.spec,
            logger,
        )
        assert.ok(plan)
        assert.equal(plan.requiresCustomCompaction, prefixSummaryAllowed)
        const out = transformTurns(f.turns, plan.rawTailStartIndex, plan, f.spec)
        const inputKeys = new Set(f.turns.flatMap((turn) => turn.items.map((item) => item.key)))
        for (const item of out.flatMap((turn) => turn.items)) {
            if (item.kind !== "synthetic" || !item.provenance) continue
            assert.ok(
                item.provenance.sources.every((key) => inputKeys.has(key)),
                "provenance must refer to input items, not generated attachment references",
            )
        }
        const text = out
            .flatMap((turn) => turn.items)
            .flatMap((item) =>
                item.kind === "synthetic" || item.kind === "text" ? [item.text] : [],
            )
            .join("\n")
        assert.ok(text.includes("/workspace/media/assistant-image"))
        assert.deepEqual(
            replayPlanSnapshot(f.turns, toPlanSnapshot(plan), f.spec, { allowRegrown: true }),
            out,
        )
    }
})

test("rolling prefix jobs see stored references rather than original media payloads", async () => {
    const f = fixture()
    f.policy.keepRecentImages = 0
    f.codec.transcriptLine = (item) =>
        f.payloads.has(item)
            ? "RAW_MEDIA_PAYLOAD"
            : item.kind === "synthetic" || item.kind === "text"
              ? item.text
              : item.key
    const first = await preparePlan(
        f.turns,
        { ...inputs, contextLimit: 100, bypassSummaries: false },
        f.spec,
        logger,
    )
    assert.ok(first?.requiresCustomCompaction)
    f.turns[3].items.push(f.media("delta-image"))
    f.turns.push({ key: "u5", role: "user", stamp: 5, items: [] })
    f.turns.push({ key: "u6", role: "user", stamp: 6, items: [] })
    const next = await preparePlan(
        f.turns,
        { ...inputs, contextLimit: 100, bypassSummaries: false, priorPlan: toPlanSnapshot(first) },
        f.spec,
        logger,
    )
    assert.ok(next)
    const job = next.summaryJobs.find((job) => job.key.startsWith("prefix-summary:"))
    assert.ok(job)
    assert.ok(job.prompt.includes("/workspace/media/delta-image"))
    assert.ok(!job.prompt.includes("RAW_MEDIA_PAYLOAD"))
})

test("replay reports live native pressure after growth below the trigger", async () => {
    const f = fixture()
    let snapshot: PlanSnapshot | null = null
    const engine = createEngine(f.spec, {
        logger,
        transcripts: { citablePath: () => "/archive/transcript.md", write: async () => ({}) },
        plans: {
            load: () => snapshot,
            save: (_key, value) => {
                snapshot = value
            },
        },
    })
    const request = { ...inputs, targetRatio: 0.7, turns: f.turns }
    const first = await engine.process(request)
    assert.equal(first.needsNativeCompaction, false)
    f.turns.push({
        key: "new-tail",
        role: "user",
        stamp: 7,
        items: [{ kind: "text", key: "new-text", text: "x".repeat(4_000), handle: {} }],
    })
    const replayed = await engine.process({ ...request, force: false })
    assert.equal(replayed.outcome, "replayed")
    assert.equal(replayed.needsNativeCompaction, true)
})

test("a live bypass change during summary work prevents summary persistence and application", async () => {
    const f = fixture()
    f.turns.splice(1, 0, {
        key: "assistant",
        role: "assistant",
        stamp: 2,
        items: [{ kind: "text", key: "prose", text: "long prose ".repeat(4_000), handle: {} }],
    })
    let bypass = false
    let snapshot: PlanSnapshot | null = null
    let calls = 0
    const engine = createEngine(f.spec, {
        logger,
        transcripts: { citablePath: () => "/archive/transcript.md", write: async () => ({}) },
        plans: {
            load: () => snapshot,
            save: (_key, value) => {
                snapshot = value
            },
        },
    })
    const result = await engine.process({
        ...inputs,
        turns: f.turns,
        bypassSummaries: () => bypass,
        summarize: async () => {
            calls++
            bypass = true
            return {}
        },
    })
    assert.equal(calls, 1)
    assert.equal(result.outcome, "planned")
    if (result.outcome !== "planned") throw new Error("expected a plan")
    assert.equal(result.plan.bypassSummaries, true)
    assert.equal(result.plan.requiresCustomCompaction, false)
    assert.deepEqual(result.plan.assistantSummaryKeys, [])
    assert.deepEqual(result.plan.summaryJobs, [])
})

test("a bypass change during asynchronous plan loading rejects summary replay", async () => {
    const f = fixture()
    f.turns.splice(1, 0, {
        key: "assistant",
        role: "assistant",
        stamp: 2,
        items: [{ kind: "text", key: "prose", text: "long prose ".repeat(4_000), handle: {} }],
    })
    const summarized = await preparePlan(
        f.turns,
        { ...inputs, bypassSummaries: false },
        f.spec,
        logger,
    )
    assert.ok(summarized?.assistantSummaryKeys.length)
    const snapshot = toPlanSnapshot(summarized)
    let bypass = false
    const engine = createEngine(f.spec, {
        logger,
        transcripts: { citablePath: () => "/archive/transcript.md", write: async () => ({}) },
        plans: {
            load: async () => {
                bypass = true
                return snapshot
            },
            save() {},
        },
    })
    const result = await engine.process({
        ...inputs,
        force: false,
        turns: f.turns,
        bypassSummaries: () => bypass,
    })
    assert.equal(result.outcome, "planned")
    if (result.outcome !== "planned") throw new Error("expected a prune-only rebuild")
    assert.equal(result.plan.bypassSummaries, true)
    assert.deepEqual(result.plan.assistantSummaryKeys, [])
})
