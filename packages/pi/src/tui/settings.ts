import type {
    CompactionConfig,
    CompactionCustomSettings,
    CompactionPreset,
    SummaryEffort,
} from "@better-compact/core"
import type { HostSettingsItem, HostSettingsUi } from "./host"

const PRESETS: CompactionPreset[] = ["light", "moderate", "max"]
const EFFORTS: SummaryEffort[] = ["inherit", "low", "medium", "high", "max", "off"]
const AUTOMATIC = ["on", "off"]
const PREFIX_SUMMARY = ["off", "on"]

const PRESET_HINT: Record<string, string> = {
    light: "Prune late and shallowly — closest to no compaction at all.",
    moderate: "Balanced trigger and target for most long sessions.",
    max: "Prune early and deeply; keeps the most headroom.",
}

export interface SettingsResult {
    changed: boolean
    config: CompactionConfig
}

/** Bounds every custom numeric row is parsed against before it is accepted. */
const CUSTOM_NUMERIC: ReadonlyArray<{
    key: "triggerPercent" | "targetPercent" | "recentToolTokens" | "summarizerConcurrency"
    label: string
    description: string
    min: number
    max: number
}> = [
    {
        key: "triggerPercent",
        label: "Trigger at % of context",
        description: "Start pruning once context reaches this percentage.",
        min: 1,
        max: 99,
    },
    {
        key: "targetPercent",
        label: "Prune down to % of context",
        description: "Keep pruning until context falls to this percentage.",
        min: 1,
        max: 99,
    },
    {
        key: "recentToolTokens",
        label: "Recent tool budget (tokens)",
        description: "Keep this many tokens of recent tool output verbatim.",
        min: 0,
        max: 200_000,
    },
    {
        key: "summarizerConcurrency",
        label: "Summary jobs in parallel",
        description: "How many assistant-run summaries may run at once.",
        min: 1,
        max: 16,
    },
]

/** Host-specific row appended to the shared settings panel. */
export interface AdditionalSetting<TComponent = unknown> extends HostSettingsItem<TComponent> {
    onChange(value: string): void
}

// The host ships the SettingsList widget and its theme, so the panel matches
// every other settings surface in that host instead of inventing a look. Each
// entrypoint injects them from its own package scope.
export function createSettingsComponent<TList, TInput = TList>(
    ui: HostSettingsUi<TList, TInput>,
    current: CompactionConfig,
    done: (result: SettingsResult) => void,
    additional: AdditionalSetting<TInput>[] = [],
): TList {
    let config: CompactionConfig = { ...current, custom: { ...current.custom } }
    let changed = false
    const custom = (): CompactionCustomSettings => config.custom

    // Numeric rows type through a one-line submenu field; the bounds table
    // decides, and a failed parse keeps the current value. The host forwards
    // the submenu's done value into onChange below.
    const numericRow = (
        key: (typeof CUSTOM_NUMERIC)[number]["key"],
        label: string,
        description: string,
    ): HostSettingsItem<TInput> => ({
        id: `custom.${key}`,
        label,
        description,
        currentValue: String(custom()[key]),
        submenu: (currentValue, done) => ui.createTextInput(currentValue, label, done),
    })

    const items: HostSettingsItem<TInput>[] = [
        {
            id: "automatic",
            label: "Automatic pruning",
            description: "Apply Better Compact to outgoing requests after the trigger.",
            currentValue: config.automatic ? "on" : "off",
            values: AUTOMATIC,
        },
        {
            id: "preset",
            label: "Compaction strength",
            description:
                config.preset === "custom"
                    ? "Custom thresholds below. Switch back to a preset to pin its numbers."
                    : (PRESET_HINT[config.preset] ?? "Compaction strength."),
            currentValue: config.preset,
            values: [...PRESETS, "custom"],
        },
        {
            id: "summaryEffort",
            label: "Summary effort",
            description: "Reasoning effort for background assistant-run summaries.",
            currentValue: config.summaryEffort,
            values: EFFORTS,
        },
        ...CUSTOM_NUMERIC.map((row) => numericRow(row.key, row.label, row.description)),
        {
            id: "custom.prefixSummary",
            label: "Last-resort prefix summary",
            description: "Merge the prefix when pruning alone cannot reach the target.",
            currentValue: custom().prefixSummary ? "on" : "off",
            values: PREFIX_SUMMARY,
        },
        ...additional.map(({ onChange: _onChange, ...item }) => item),
    ]

    return ui.createSettingsList(
        items,
        12,
        (id, value) => {
            changed = true
            if (id === "automatic") config = { ...config, automatic: value === "on" }
            else if (id === "preset") config = { ...config, preset: value as CompactionPreset }
            else if (id === "summaryEffort")
                config = { ...config, summaryEffort: value as SummaryEffort }
            else if (id === "custom.prefixSummary")
                config = { ...config, custom: { ...custom(), prefixSummary: value === "on" } }
            else if (id.startsWith("custom.")) {
                const bounds = CUSTOM_NUMERIC.find((row) => `custom.${row.key}` === id)
                if (!bounds || value.trim() === "") return
                const parsed = Math.round(Number(value))
                // A trigger at or below the target can never fire: keep the
                // current value instead of persisting dead configuration.
                if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) return
                const next = { ...custom(), [bounds.key]: parsed }
                if (next.triggerPercent <= next.targetPercent) return
                config = { ...config, custom: next }
            } else additional.find((item) => item.id === id)?.onChange(value)
        },
        () => done({ changed, config }),
    )
}
