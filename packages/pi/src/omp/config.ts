import { readConfigObject, updateConfigObject } from "../config"

/** Who supplies Oh My Pi's durable compaction result. */
export type OmpCompactionOwner = "better-compact" | "omp"

export const OMP_COMPACTION_OWNERS: readonly OmpCompactionOwner[] = ["better-compact", "omp"]
export const DEFAULT_OMP_COMPACTION_OWNER: OmpCompactionOwner = "better-compact"
export const OMP_COMPACTION_OWNER_KEY = "ompCompactionOwner"

/** Shared by duplicate extension instances in one process. */
const cachedOwners = new Map<string, OmpCompactionOwner>()

export function currentOmpCompactionOwner(path: string): OmpCompactionOwner {
    return cachedOwners.get(path) ?? DEFAULT_OMP_COMPACTION_OWNER
}

export function isOmpCompactionOwner(value: unknown): value is OmpCompactionOwner {
    return value === "better-compact" || value === "omp"
}

export async function loadOmpCompactionOwner(path: string): Promise<OmpCompactionOwner> {
    try {
        const config = await readConfigObject(path)
        const configured = config?.[OMP_COMPACTION_OWNER_KEY]
        const owner = isOmpCompactionOwner(configured) ? configured : DEFAULT_OMP_COMPACTION_OWNER
        cachedOwners.set(path, owner)
        return owner
    } catch {
        // The shared config loader already reports malformed JSON and falls back
        // to defaults. Owner loading must follow the same failure boundary.
        cachedOwners.set(path, DEFAULT_OMP_COMPACTION_OWNER)
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
    cachedOwners.set(path, owner)
}

export function commandOmpCompactionOwner(value: string): OmpCompactionOwner | null {
    const normalized = value.trim().toLowerCase()
    return isOmpCompactionOwner(normalized) ? normalized : null
}

/** Test seam for independent process fixtures. */
export function resetOmpCompactionOwnerCache(): void {
    cachedOwners.clear()
}
