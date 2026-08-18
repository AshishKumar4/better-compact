import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
    DEFAULT_CUSTOM_COMPACTION,
    normalizeCompactionCustom,
    type CompactionConfig,
    type CompactionCustomSettings,
    type CompactionPreset,
    type Logger,
} from "@better-compact/core"

/** Better Compact's own config file, resolved per host under its agent dir. */
export const CONFIG_FILE = "better-compact.json"

export const DEFAULT_CONFIG: CompactionConfig = {
    automatic: true,
    preset: "light",
    summaryEffort: "inherit",
    custom: { ...DEFAULT_CUSTOM_COMPACTION },
}

export type CompactionConfigOverride = Omit<Partial<CompactionConfig>, "custom"> & {
    custom?: Partial<CompactionCustomSettings>
}

/**
 * Merge global then project overrides onto the defaults.
 *
 * `projectPath` is the caller's trust decision made explicit: pass `null` when
 * the host cannot vouch for the working tree, and the project file is not read
 * at all rather than silently trusted.
 */
export async function loadCompactionConfig(
    logger: Logger,
    globalPath: string,
    projectPath: string | null,
): Promise<CompactionConfig> {
    const [global, project] = await Promise.all([
        readConfigOverride(logger, globalPath),
        projectPath ? readConfigOverride(logger, projectPath) : Promise.resolve(null),
    ])
    return mergeCompactionConfig(global ?? {}, project ?? {})
}

export async function readConfigOverride(
    logger: Logger,
    path: string,
): Promise<CompactionConfigOverride | null> {
    try {
        const value = await readConfigObject(path)
        return value ? parseCompactionConfig(value) : null
    } catch (error) {
        logger.warn("Better Compact config ignored", { path, error: errorText(error) })
        return null
    }
}

export async function readConfigObject(path: string): Promise<Record<string, unknown> | null> {
    try {
        const value: unknown = JSON.parse(await readFile(path, "utf-8"))
        if (!isRecord(value)) throw new Error("config must be a JSON object")
        return value
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null
        throw error
    }
}

export async function writeConfigObject(
    path: string,
    value: Record<string, unknown>,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 })
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true })
        throw error
    }
}

export function parseCompactionConfig(value: Record<string, unknown>): CompactionConfigOverride {
    return {
        automatic: typeof value.automatic === "boolean" ? value.automatic : undefined,
        preset: isCompactionPreset(value.preset) ? value.preset : undefined,
        summaryEffort: isSummaryEffort(value.summaryEffort) ? value.summaryEffort : undefined,
        custom: parseCustomConfig(value.custom),
    }
}

function parseCustomConfig(value: unknown): Partial<CompactionCustomSettings> {
    if (!isRecord(value)) return {}
    const custom: Partial<CompactionCustomSettings> = {}
    if (typeof value.triggerPercent === "number" && Number.isFinite(value.triggerPercent)) {
        custom.triggerPercent = value.triggerPercent
    }
    if (typeof value.targetPercent === "number" && Number.isFinite(value.targetPercent)) {
        custom.targetPercent = value.targetPercent
    }
    if (typeof value.recentToolTokens === "number" && Number.isFinite(value.recentToolTokens)) {
        custom.recentToolTokens = value.recentToolTokens
    }
    if (
        typeof value.summarizerConcurrency === "number" &&
        Number.isFinite(value.summarizerConcurrency)
    ) {
        custom.summarizerConcurrency = value.summarizerConcurrency
    }
    return custom
}

export function mergeCompactionConfig(...overrides: CompactionConfigOverride[]): CompactionConfig {
    let config: CompactionConfig = {
        ...DEFAULT_CONFIG,
        custom: { ...DEFAULT_CONFIG.custom },
    }
    for (const override of overrides) {
        config = {
            automatic: override.automatic ?? config.automatic,
            preset: override.preset ?? config.preset,
            summaryEffort: override.summaryEffort ?? config.summaryEffort,
            custom: normalizeCompactionCustom({ ...config.custom, ...override.custom }),
        }
    }
    return config
}

export function commandPreset(value: string): Exclude<CompactionPreset, "custom"> | null {
    return value === "light" || value === "moderate" || value === "max" ? value : null
}

function isCompactionPreset(value: unknown): value is CompactionPreset {
    return value === "light" || value === "moderate" || value === "max" || value === "custom"
}

function isSummaryEffort(value: unknown): value is CompactionConfig["summaryEffort"] {
    return (
        value === "inherit" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "max"
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
