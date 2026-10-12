import assert from "node:assert/strict"
import test from "node:test"
import { createSessionOwnership } from "../src/ownership"
import type * as Ownership from "../src/ownership"

// Each `{}` stands in for one runner's session manager: the identity the
// hosts give a bound session.

test("one instance drives its session across events, and each new session gets its own", () => {
    const root = createSessionOwnership()
    const session = {}
    assert.equal(root.claim(session), "owner")
    assert.equal(root.claim(session), "owner", "ownership must be stable across events")

    // Subagents bind their own runner and manager; none of them is a duplicate.
    for (const subagent of [{}, {}, {}]) {
        assert.equal(createSessionOwnership().claim(subagent), "owner")
    }
})

test("a revived session gets a fresh manager, so a gone runner cannot keep it", () => {
    // The bug this replaces: ownership keyed on the session id string. A
    // revived or reopened session reuses the id, and the instance bound to the
    // runner that served it first held the claim forever, so the live runner
    // stayed inert and nothing pruned that session.
    const first = createSessionOwnership()
    assert.equal(first.claim({}), "owner")
    const revived = createSessionOwnership()
    assert.equal(revived.claim({}), "owner")
})

test("an auxiliary agent on the parent's journal stays inert without a warning", () => {
    const parent = createSessionOwnership()
    const shared = {}
    assert.equal(parent.claim(shared), "owner")
    assert.equal(createSessionOwnership().claim(shared), "auxiliary")
    assert.equal(parent.claim(shared), "owner", "the parent keeps driving its session")
})

test("a second installed copy of the plugin is reported as a duplicate", async () => {
    // Dynamic on purpose: a distinct specifier evaluates the module a second
    // time, which is exactly what a second install of the plugin does.
    const secondCopy: typeof Ownership = await import(
        new URL("../src/ownership.ts?second-install", import.meta.url).href
    )
    const session = {}
    assert.equal(createSessionOwnership().claim(session), "owner")
    assert.equal(secondCopy.createSessionOwnership().claim(session), "duplicate")
})

test("an owner that shuts down hands its session to the next runner", () => {
    const session = {}
    const before = createSessionOwnership()
    const after = createSessionOwnership()
    assert.equal(before.claim(session), "owner")
    after.release(session)
    assert.equal(after.claim(session), "auxiliary", "only the holder can release a claim")
    before.release(session)
    assert.equal(after.claim(session), "owner")
})
