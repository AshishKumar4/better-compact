import type { CompactionConfig, CompactionPreset, SummaryEffort } from "@better-compact/core"
import type { HostSettingsUi } from "./host"

const PRESETS: CompactionPreset[] = ["light", "moderate", "max"]
const EFFORTS: SummaryEffort[] = ["inherit", "low", "medium", "high", "max"]
const AUTOMATIC = ["on", "off"]

const PRESET_HINT: Record<string, string> = {
    light: "Prune late and shallowly — closest to no compaction at all.",
    moderate: "Balanced trigger and target for most long sessions.",
    max: "Prune early and deeply; keeps the most headroom.",
}

export interface SettingsResult {
    changed: boolean
    config: CompactionConfig
}

// The host ships the SettingsList widget and its theme, so the panel matches
// every other settings surface in that host instead of inventing a look. Each
// entrypoint injects them from its own package scope.
export function createSettingsComponent<TComponent>(
    ui: HostSettingsUi<TComponent>,
    current: CompactionConfig,
    done: (result: SettingsResult) => void,
): TComponent {
    let config: CompactionConfig = { ...current }
    let changed = false

    const items = [
        {
            id: "automatic",
            label: "Automatic compaction",
            description: "Prune automatically when the session crosses the trigger.",
            currentValue: config.automatic ? "on" : "off",
            values: AUTOMATIC,
        },
        {
            id: "preset",
            label: "Compaction strength",
            description:
                PRESET_HINT[config.preset] ?? "Custom thresholds from better-compact.json.",
            currentValue: config.preset,
            values: config.preset === "custom" ? [...PRESETS, "custom"] : PRESETS,
        },
        {
            id: "summaryEffort",
            label: "Summary effort",
            description: "Reasoning effort for background assistant-run summaries.",
            currentValue: config.summaryEffort,
            values: EFFORTS,
        },
    ]

    return ui.createSettingsList(
        items,
        10,
        (id, value) => {
            changed = true
            if (id === "automatic") config = { ...config, automatic: value === "on" }
            else if (id === "preset") config = { ...config, preset: value as CompactionPreset }
            else if (id === "summaryEffort")
                config = { ...config, summaryEffort: value as SummaryEffort }
        },
        () => done({ changed, config }),
    )
}
