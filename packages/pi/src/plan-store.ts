import {
    matchesPlanSnapshot,
    type PlanSnapshot,
    type PlanStore,
    type Turn,
} from "@better-compact/core"

export const PLAN_ENTRY_TYPE = "better-compact-plan"

/**
 * The branch slice of a host session manager. Both pi-family hosts persist
 * extension state as `{ type: "custom", customType, data }` entries, so the
 * reader is described structurally and one store serves both.
 */
export interface BranchReader {
    getBranch(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }>
}

export interface PiPlanStore extends PlanStore {
    // Rebuild the in-memory snapshot from the session branch. Custom entries
    // are recorded per branch position, so a fork or resume replays exactly
    // the plan its branch last saved.
    restore(session: BranchReader): void
    // A restored branch entry is only adopted after its compacted prefix is
    // proven to match the live context. Content-hash keys survive host forks.
    adopt(sessionKey: string, turns: Turn[]): void
}

export function createPlanStore(
    appendEntry: (customType: string, data: unknown) => void,
): PiPlanStore {
    let snapshot: PlanSnapshot | null = null
    let pending: PlanSnapshot | null | undefined
    return {
        load: () => snapshot,
        save(_sessionKey, next) {
            snapshot = next
            pending = undefined
            appendEntry(PLAN_ENTRY_TYPE, { snapshot: next })
        },
        restore(session) {
            snapshot = null
            pending = null
            // getBranch walks root -> leaf; the last plan entry on the branch wins.
            for (const entry of session.getBranch()) {
                if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY_TYPE) continue
                const { data } = entry
                pending =
                    typeof data === "object" && data !== null && "snapshot" in data
                        ? ((data.snapshot as PlanSnapshot | null) ?? null)
                        : null
            }
        },
        adopt(sessionKey, turns) {
            if (pending === undefined) return
            const stored = pending
            pending = undefined
            if (!stored) return
            if (!matchesPlanSnapshot(turns, stored)) return
            snapshot = { ...stored, sessionId: sessionKey }
        },
    }
}
