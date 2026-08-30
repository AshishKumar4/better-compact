import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { updateConfigObject } from "../src/config"
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
