/**
 * Per-session ownership, so one copy of Better Compact drives a session.
 *
 * The pi-family hosts load extensions **once per session**, binding each
 * `Extension` to that session's own `ExtensionAPI` — subagents included (see
 * `sdk.ts`: "the session still calls `loadExtensions()` itself so each
 * `Extension` is bound to THIS session's `ExtensionAPI`"). So a process-wide
 * "already loaded" flag is wrong twice over: it would disable the extension for
 * every session after the first, and for every subagent.
 *
 * What actually needs guarding is the other case: the same artifact discovered
 * through two roots at once — an installed plugin plus a drop-in under
 * `extensions/`, or an explicit `-e` path — which registers two independent
 * instances into one session. Commands dedup by name so that stays invisible,
 * but `emitContext` chains every registered `context` handler, so the second
 * instance would re-run the ladder over already-pruned messages while keeping a
 * competing plan of its own.
 *
 * Ownership is therefore claimed per session id, at event time rather than load
 * time: the session is not resolvable when the factory runs.
 */

const owners = new Map<string, object>()

export interface SessionOwnership {
    /**
     * Whether this instance drives `sessionId`. Claims it when unowned, so the
     * first instance to see a session keeps it for the session's lifetime.
     */
    owns(sessionId: string): boolean
    /** True once this instance has lost a session to another copy. */
    readonly displaced: boolean
}

export function createSessionOwnership(): SessionOwnership {
    const instance = {}
    let displaced = false
    return {
        owns(sessionId) {
            const owner = owners.get(sessionId)
            if (owner === undefined) {
                owners.set(sessionId, instance)
                return true
            }
            if (owner === instance) return true
            displaced = true
            return false
        },
        get displaced() {
            return displaced
        },
    }
}

/** Test seam: forget every claim so cases start from a clean process. */
export function resetSessionOwnership(): void {
    owners.clear()
}
