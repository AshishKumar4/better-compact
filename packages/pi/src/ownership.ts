/**
 * One copy of Better Compact drives each bound session.
 *
 * The pi-family hosts bind extensions per session: every agent session —
 * subagents and revived sessions included — builds its own runner and calls
 * each extension factory against it. That runner's session manager is the
 * identity that matters. It stays the same object across new/resume/switch
 * inside the runner, a revived or reopened session gets a fresh one, and an
 * auxiliary agent the host runs over the parent's journal shares the
 * parent's. Keying ownership on that object instead of the session id means a
 * runner that is gone can never keep a session it no longer serves.
 *
 * An instance stays inert in two cases:
 * - `duplicate`: a second copy of the plugin, loaded from another root (an
 *   installed plugin plus a drop-in, or an explicit path), already drives the
 *   session. Separate module copies share only `globalThis`, so the registry
 *   lives there. This is an installation mistake worth reporting.
 * - `auxiliary`: another instance of this same copy drives it, because the
 *   host bound an auxiliary agent to the parent's journal. Pruning there would
 *   plan against history that agent is not sending. Expected, not reported.
 *
 * The owner releases its claim on `session_shutdown`, so a later runner over
 * the same manager (an extension reload) can take the session over.
 */

export type Claim = "owner" | "auxiliary" | "duplicate"

export interface SessionOwnership {
    /** Claims `session` when unowned; otherwise reports who holds it. */
    claim(session: object): Claim
    /** Gives up `session` if this instance holds it. */
    release(session: object): void
}

interface Holder {
    instance: object
    copy: symbol
}

declare global {
    // Shared by every copy of the plugin loaded into this process.
    var betterCompactSessionOwners: WeakMap<object, Holder> | undefined
}

// One per evaluated module: two installs of the plugin get two of these.
const COPY = Symbol("better-compact module copy")

function registry(): WeakMap<object, Holder> {
    globalThis.betterCompactSessionOwners ??= new WeakMap()
    return globalThis.betterCompactSessionOwners
}

export function createSessionOwnership(): SessionOwnership {
    const instance = {}
    return {
        claim(session) {
            const owners = registry()
            const holder = owners.get(session)
            if (holder === undefined) {
                owners.set(session, { instance, copy: COPY })
                return "owner"
            }
            if (holder.instance === instance) return "owner"
            return holder.copy === COPY ? "auxiliary" : "duplicate"
        },
        release(session) {
            const owners = registry()
            if (owners.get(session)?.instance === instance) owners.delete(session)
        },
    }
}
