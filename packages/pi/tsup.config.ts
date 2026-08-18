import { defineConfig } from "tsup"
import { version } from "./package.json"

const shared = {
    format: ["esm"],
    dts: false,
    sourcemap: false,
    define: { __BC_VERSION__: JSON.stringify(version) },
    // `clean` stays off in both configs: tsup runs an array config concurrently,
    // so one config wiping dist races the other config emitting into it. The
    // build script removes dist once, up front, instead.
    clean: false,
    noExternal: ["@better-compact/core"],
} as const

// One self-contained artifact per host: core is bundled, the host's own
// packages stay external because the host provides them at runtime. The two
// bundles never mix package scopes — Oh My Pi would resolve `@earendil-works/*`
// through its legacy-pi compatibility shim, but the native adapter has no
// reason to depend on that layer.
export default defineConfig([
    {
        ...shared,
        entry: { extension: "src/extension.ts" },
        external: [/^@earendil-works\//],
    },
    {
        ...shared,
        entry: { omp: "src/omp.ts" },
        external: [/^@oh-my-pi\//],
    },
])
