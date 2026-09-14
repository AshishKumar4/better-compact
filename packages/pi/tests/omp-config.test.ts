import { resolveCompactionProfile } from "@better-compact/core"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { mergeCompactionConfig, parseCompactionConfig, updateConfigObject } from "../src/config"
import {
    commandOmpCompactionOwner,
    loadOmpCompactionOwner,
    saveOmpCompactionOwner,
} from "../src/omp/config"
test("missing or invalid owner defaults to Better Compact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "better-compact-owner-"))
    const path = join(dir, "better-compact.json")

    assert.equal(await loadOmpCompactionOwner(path), "better-compact")
    await writeFile(path, JSON.stringify({ ompCompactionOwner: "invalid" }))
    assert.equal(await loadOmpCompactionOwner(path), "better-compact")
})

test("malformed config uses the Better Compact owner default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "better-compact-owner-"))
    const path = join(dir, "better-compact.json")

    await writeFile(path, "{ torn")
    assert.equal(await loadOmpCompactionOwner(path), "better-compact")

    await writeFile(path, "[]")
    assert.equal(await loadOmpCompactionOwner(path), "better-compact")
})

test("owner round-trips without dropping shared or unknown config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "better-compact-owner-"))
    const path = join(dir, "better-compact.json")
    await writeFile(
        path,
        JSON.stringify({ automatic: false, preset: "max", futureField: { keep: true } }),
    )

    await saveOmpCompactionOwner(path, "omp")

    assert.equal(await loadOmpCompactionOwner(path), "omp")
    assert.deepEqual(JSON.parse(await readFile(path, "utf-8")), {
        automatic: false,
        preset: "max",
        futureField: { keep: true },
        ompCompactionOwner: "omp",
    })
})

test("concurrent owner and shared config updates preserve both writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "better-compact-owner-"))
    const path = join(dir, "better-compact.json")
    await writeFile(path, JSON.stringify({ preset: "light" }))

    await Promise.all([
        saveOmpCompactionOwner(path, "omp"),
        updateConfigObject(path, { automatic: false }),
    ])

    assert.deepEqual(JSON.parse(await readFile(path, "utf-8")), {
        preset: "light",
        ompCompactionOwner: "omp",
        automatic: false,
    })
})

test("owner command accepts only the public values", () => {
    assert.equal(commandOmpCompactionOwner(" better-compact "), "better-compact")
    assert.equal(commandOmpCompactionOwner("OMP"), "omp")
    assert.equal(commandOmpCompactionOwner("snapcompact"), null)
    assert.equal(commandOmpCompactionOwner("native"), null)
    assert.equal(commandOmpCompactionOwner(""), null)
})

test("compaction config accepts summaryEffort off and the prefixSummary opt-in", () => {
    const parsed = parseCompactionConfig({
        summaryEffort: "off",
        custom: { prefixSummary: true, targetPercent: 40 },
    })
    assert.equal(parsed.summaryEffort, "off")
    assert.deepEqual(parsed.custom, { prefixSummary: true, targetPercent: 40 })

    // The last-resort merge stays opt-in: absent and non-boolean values both
    // normalize to false.
    assert.equal(mergeCompactionConfig().custom.prefixSummary, false)
    assert.equal(
        mergeCompactionConfig({ custom: { prefixSummary: true } }).custom.prefixSummary,
        true,
    )
    assert.equal(parseCompactionConfig({ summaryEffort: "turbo" }).summaryEffort, undefined)
})

test("the prefixSummary opt-in survives a named preset", () => {
    const profile = resolveCompactionProfile({
        compaction: mergeCompactionConfig({ preset: "light", custom: { prefixSummary: true } }),
    })
    assert.equal(profile.preset, "light")
    assert.equal(profile.triggerPercent, 85)
    assert.equal(profile.prefixSummary, true)
    assert.equal(
        resolveCompactionProfile({ compaction: mergeCompactionConfig() }).prefixSummary,
        false,
    )
})
