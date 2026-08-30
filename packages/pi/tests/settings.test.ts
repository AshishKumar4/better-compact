import assert from "node:assert/strict"
import test from "node:test"
import type { CompactionConfig } from "@better-compact/core"
import { createSettingsComponent } from "../src/tui/settings"
import type { HostSettingsItem, HostSettingsUi } from "../src/tui/host"

interface CapturedSettings {
    items: HostSettingsItem[]
    change(id: string, value: string): void
    done(): void
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
        },
    }
}

test("host-specific rows share the settings panel and receive changes", () => {
    let captured: CapturedSettings | undefined
    let owner = "better-compact"
    let result: { changed: boolean; config: CompactionConfig } | undefined
    const ui: HostSettingsUi<CapturedSettings> = {
        createSettingsList(items, _visibleRows, change, done) {
            captured = { items, change, done }
            return captured
        },
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
        ["automatic", "preset", "summaryEffort", "ompCompactionOwner"],
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
    const ui: HostSettingsUi<CapturedSettings> = {
        createSettingsList(items, _visibleRows, change, done) {
            captured = { items, change, done }
            return captured
        },
    }

    createSettingsComponent(ui, config(), (next) => (result = next))
    assert.ok(captured)
    captured.change("automatic", "off")
    captured.change("preset", "max")
    captured.done()

    assert.equal(result?.config.automatic, false)
    assert.equal(result?.config.preset, "max")
})
