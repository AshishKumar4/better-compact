export type CompactionPreset = "light" | "moderate" | "max" | "custom"
export type SummaryEffort = "inherit" | "low" | "medium" | "high" | "max" | "off"

export interface CompactionCustomSettings {
    triggerPercent: number
    targetPercent: number
    recentToolTokens: number
    summarizerConcurrency: number
    /**
     * Whether the last-resort prefix summary may run when pruning alone cannot
     * reach the target. Off by default: deterministic pruning is the answer
     * until a user opts into the merge.
     */
    prefixSummary: boolean
}

export interface CompactionConfig {
    automatic: boolean
    preset: CompactionPreset
    summaryEffort: SummaryEffort
    custom: CompactionCustomSettings
}

export interface CompactionProfile extends CompactionCustomSettings {
    preset: CompactionPreset
}

export const COMPACTION_PRESETS: Record<Exclude<CompactionPreset, "custom">, CompactionProfile> = {
    light: {
        preset: "light",
        triggerPercent: 85,
        targetPercent: 35,
        recentToolTokens: 40_000,
        summarizerConcurrency: 4,
        prefixSummary: false,
    },
    moderate: {
        preset: "moderate",
        triggerPercent: 75,
        targetPercent: 25,
        recentToolTokens: 30_000,
        summarizerConcurrency: 6,
        prefixSummary: false,
    },
    max: {
        preset: "max",
        triggerPercent: 60,
        targetPercent: 15,
        recentToolTokens: 12_000,
        summarizerConcurrency: 8,
        prefixSummary: false,
    },
}

export const DEFAULT_CUSTOM_COMPACTION: CompactionCustomSettings = {
    triggerPercent: 85,
    targetPercent: 35,
    recentToolTokens: 40_000,
    summarizerConcurrency: 4,
    prefixSummary: false,
}

export function normalizeCompactionCustom(
    input: Partial<CompactionCustomSettings> | undefined,
): CompactionCustomSettings {
    return {
        triggerPercent: clampPercent(
            input?.triggerPercent,
            DEFAULT_CUSTOM_COMPACTION.triggerPercent,
        ),
        targetPercent: clampPercent(input?.targetPercent, DEFAULT_CUSTOM_COMPACTION.targetPercent),
        recentToolTokens: clampInteger(
            input?.recentToolTokens,
            0,
            200_000,
            DEFAULT_CUSTOM_COMPACTION.recentToolTokens,
        ),
        summarizerConcurrency: clampInteger(
            input?.summarizerConcurrency,
            1,
            16,
            DEFAULT_CUSTOM_COMPACTION.summarizerConcurrency,
        ),
        prefixSummary: input?.prefixSummary === true,
    }
}

export function resolveCompactionProfile(
    config: { compaction: CompactionConfig },
    override?: Partial<CompactionConfig>,
): CompactionProfile {
    const preset = normalizePreset(override?.preset ?? config.compaction.preset)
    const custom = normalizeCompactionCustom({
        ...config.compaction.custom,
        ...(override?.custom ?? {}),
    })
    if (preset === "custom") return { preset, ...custom }
    // The prefix-summary opt-in is orthogonal to a preset's pruning numbers,
    // so it carries through instead of being pinned to the preset's default.
    return { ...COMPACTION_PRESETS[preset], prefixSummary: custom.prefixSummary }
}

export function normalizePreset(value: unknown): CompactionPreset {
    return value === "light" || value === "moderate" || value === "max" || value === "custom"
        ? value
        : "light"
}

export function normalizeSummaryEffort(value: unknown): SummaryEffort {
    return value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "max" ||
        value === "off"
        ? value
        : "inherit"
}

function clampPercent(value: unknown, fallback: number): number {
    return clampInteger(value, 1, 99, fallback)
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const numeric =
        typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.max(min, Math.min(max, numeric))
}
