// The pi-family hosts (pi and Oh My Pi) ship the same TUI primitives under
// different package scopes. The components below only ever need the structural
// slice declared here, so keeping it local is what lets one implementation
// serve both hosts without importing either scope.

/**
 * The palette keys these components use. Both hosts throw on an unknown key, so
 * naming them keeps a host renaming one a typecheck failure in the entrypoint
 * rather than an error thrown mid-render inside an overlay.
 */
export type HostThemeColor =
    | "accent"
    | "borderMuted"
    | "dim"
    | "error"
    | "muted"
    | "success"
    | "text"
    | "toolTitle"
    | "warning"

/** The `fg`/`bold` slice of a host theme the components actually use. */
export interface HostTheme {
    fg(color: HostThemeColor, text: string): string
    bold(text: string): string
}

/**
 * The host component contract for the components this package renders itself:
 * emit lines, drop cached state on resize. `string[]` rather than
 * `readonly string[]` because it must satisfy both hosts' `Component`.
 */
export interface HostComponent {
    render(width?: number): string[]
    invalidate(): void
}

/** One row of a host `SettingsList`. */
export interface HostSettingsItem {
    id: string
    label: string
    description: string
    currentValue: string
    values: string[]
}

/**
 * The host's own settings widget, injected by each entrypoint so the panel
 * matches every other settings surface in that host rather than inventing a
 * look. Generic in the component type: the settings module only forwards what
 * the host built, so the host's real `Component` type flows through untouched
 * instead of being flattened into {@link HostComponent}.
 */
export interface HostSettingsUi<TComponent> {
    createSettingsList(
        items: HostSettingsItem[],
        visibleRows: number,
        onChange: (id: string, value: string) => void,
        onDone: () => void,
    ): TComponent
}
