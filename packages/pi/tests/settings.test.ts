import assert from "node:assert/strict"
import test from "node:test"
import type { CompactionConfig } from "@better-compact/core"
import { createSettingsComponent } from "../src/tui/settings"
import type { HostSettingsItem, HostSettingsUi } from "../src/tui/host"

interface CapturedSettings {
    items: HostSettingsItem<unknown>[]
    change(id: string, value: string): void
    done(): void
    result?: { changed: boolean; config: CompactionConfig }
}

interface CapturedInput {
    currentValue: string
    placeholder: string
}

function inputOf(value: unknown): asserts value is CapturedInput {
    assert.ok(typeof value === "object" && value !== null && "currentValue" in value)
}

function config(): CompactionConfig {
    return {
        automatic: true,
        preset: "light",
        summaryEffort: "inherit",
        custom: {
            triggerPercent: 85,
            targetPercent: 35,
            recentToolTokens: 40_000,
            summarizerConcurrency: 4,
            prefixSummary: false,
        },
    }
}

test("host-specific rows share the settings panel and receive changes", () => {
    let captured: CapturedSettings | undefined
    let owner = "better-compact"
    let result: { changed: boolean; config: CompactionConfig } | undefined
    const ui: HostSettingsUi<CapturedSettings, CapturedInput> = {
        createSettingsList(items, _visibleRows, change, done) {
            captured = {
                items,
                change,
                done,
                get result() {
                    return result
                },
            }
            return captured
        },
        createTextInput: (currentValue, placeholder) => ({ currentValue, placeholder }),
    }

    createSettingsComponent(ui, config(), (next) => (result = next), [
        {
            id: "ompCompactionOwner",
            label: "Committed compaction",
            description: "Choose the owner.",
            currentValue: owner,
            values: ["better-compact", "omp"],
            onChange: (value) => (owner = value),
        },
    ])

    assert.ok(captured)
    assert.deepEqual(
        captured.items.map((item) => item.id),
        [
            "automatic",
            "preset",
            "summaryEffort",
            "custom.triggerPercent",
            "custom.targetPercent",
            "custom.recentToolTokens",
            "custom.summarizerConcurrency",
            "custom.prefixSummary",
            "ompCompactionOwner",
        ],
    )
    captured.change("ompCompactionOwner", "omp")
    captured.done()

    assert.equal(owner, "omp")
    assert.equal(result?.changed, true)
    assert.equal(result?.config.preset, "light")
})

test("shared rows keep their existing behavior when host rows are present", () => {
    let captured: CapturedSettings | undefined
    let result: { changed: boolean; config: CompactionConfig } | undefined
    const ui: HostSettingsUi<CapturedSettings, CapturedInput> = {
        createSettingsList(items, _visibleRows, change, done) {
            captured = {
                items,
                change,
                done,
                get result() {
                    return result
                },
            }
            return captured
        },
        createTextInput: (currentValue, placeholder) => ({ currentValue, placeholder }),
    }

    createSettingsComponent(ui, config(), (next) => (result = next))
    assert.ok(captured)
    captured.change("automatic", "off")
    captured.change("preset", "max")
    captured.done()

    assert.equal(result?.config.automatic, false)
    assert.equal(result?.config.preset, "max")
})

test("custom numeric rows accept in-range input and refuse dead configuration", () => {
    let captured: CapturedSettings | undefined
    const ui: HostSettingsUi<CapturedSettings, CapturedInput> = {
        createSettingsList(items, _visibleRows, change, done) {
            captured = {
                items,
                change,
                done,
                get result() {
                    return seen
                },
            }
            return captured
        },
        createTextInput: (currentValue, placeholder) => ({ currentValue, placeholder }),
    }
    let seen: { changed: boolean; config: CompactionConfig } | undefined
    createSettingsComponent(ui, config(), (next) => (seen = next))
    assert.ok(captured)
    const numeric = captured.items.find((item) => item.id === "custom.triggerPercent")
    assert.ok(numeric?.submenu)
    const field = numeric.submenu("85", (value) => {
        if (value !== undefined) captured?.change("custom.triggerPercent", value)
    })
    inputOf(field)
    assert.equal(field.currentValue, "85")
    captured.change("custom.triggerPercent", "75")
    captured.change("custom.targetPercent", "35")
    captured.done()
    assert.equal(seen?.config.custom.triggerPercent, 75)
    captured.change("custom.triggerPercent", "30")
    captured.done()
    assert.equal(seen?.config.custom.triggerPercent, 75)
    captured.change("custom.triggerPercent", "500")
    captured.done()
    assert.equal(seen?.config.custom.triggerPercent, 75)
    captured.change("custom.prefixSummary", "on")
    captured.done()
    assert.equal(seen?.config.custom.prefixSummary, true)
    assert.deepEqual(seen?.config.custom, {
        triggerPercent: 75,
        targetPercent: 35,
        recentToolTokens: 40_000,
        summarizerConcurrency: 4,
        prefixSummary: true,
    })
})
