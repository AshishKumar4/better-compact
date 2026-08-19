import assert from "node:assert/strict"
import test from "node:test"
import { createSessionOwnership, resetSessionOwnership } from "../src/ownership"

test("one instance owns every session it sees first", () => {
    resetSessionOwnership()
    const only = createSessionOwnership()

    assert.equal(only.owns("session-a"), true)
    assert.equal(only.owns("session-a"), true, "ownership must be stable across events")
    assert.equal(
        only.owns("session-b"),
        true,
        "a new session in the same process is not a duplicate",
    )
    assert.equal(only.displaced, false)
})

test("a second copy in the same session loses and reports it", () => {
    resetSessionOwnership()
    const first = createSessionOwnership()
    const second = createSessionOwnership()

    assert.equal(first.owns("session-a"), true)
    assert.equal(second.owns("session-a"), false, "the duplicate must not drive the session")
    assert.equal(second.displaced, true)
    assert.equal(first.owns("session-a"), true, "the winner keeps the session")
})

test("later sessions and subagents still get an owner", () => {
    // The bug this replaces: the hosts load extensions once per session, binding
    // each to that session's own ExtensionAPI — subagents included. A
    // process-wide "already loaded" flag therefore disabled Better Compact for
    // every session after the first.
    resetSessionOwnership()
    const root = createSessionOwnership()
    assert.equal(root.owns("root-session"), true)

    for (const subagent of ["subagent-1", "subagent-2", "subagent-3"]) {
        const instance = createSessionOwnership()
        assert.equal(
            instance.owns(subagent),
            true,
            `${subagent} must get its own working instance, not be treated as a duplicate`,
        )
        assert.equal(instance.displaced, false)
    }
})

test("a displaced instance stays inert for that session but can own another", () => {
    resetSessionOwnership()
    const first = createSessionOwnership()
    const second = createSessionOwnership()

    first.owns("shared")
    assert.equal(second.owns("shared"), false)
    // A session the winner never saw is still claimable: being displaced once
    // must not permanently disable an instance.
    assert.equal(second.owns("its-own"), true)
})
