import { readConfigObject, updateConfigObject } from "../config"

/** Who supplies Oh My Pi's durable compaction result. */
export type OmpCompactionOwner = "better-compact" | "omp"

export const OMP_COMPACTION_OWNERS: readonly OmpCompactionOwner[] = ["better-compact", "omp"]
export const DEFAULT_OMP_COMPACTION_OWNER: OmpCompactionOwner = "better-compact"
export const OMP_COMPACTION_OWNER_KEY = "ompCompactionOwner"

export function isOmpCompactionOwner(value: unknown): value is OmpCompactionOwner {
    return value === "better-compact" || value === "omp"
}

export async function loadOmpCompactionOwner(path: string): Promise<OmpCompactionOwner> {
    try {
        const config = await readConfigObject(path)
        const configured = config?.[OMP_COMPACTION_OWNER_KEY]
        return isOmpCompactionOwner(configured) ? configured : DEFAULT_OMP_COMPACTION_OWNER
    } catch {
        // The shared config loader already reports malformed JSON and falls back
        // to defaults. Owner loading must follow the same failure boundary.
        return DEFAULT_OMP_COMPACTION_OWNER
    }
}

/**
 * Save the owner without dropping Better Compact's shared config or fields from
 * newer versions. `updateConfigObject` serializes the read-modify-write across
 * sessions and processes.
 */
export async function saveOmpCompactionOwner(
    path: string,
    owner: OmpCompactionOwner,
): Promise<void> {
    await updateConfigObject(path, { [OMP_COMPACTION_OWNER_KEY]: owner })
}

export function commandOmpCompactionOwner(value: string): OmpCompactionOwner | null {
    const normalized = value.trim().toLowerCase()
    return isOmpCompactionOwner(normalized) ? normalized : null
}
