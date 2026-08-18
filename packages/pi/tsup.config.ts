import { defineConfig } from "tsup"
import { version } from "./package.json"

const shared = {
    format: ["esm"],
    dts: false,
    sourcemap: false,
    define: { __BC_VERSION__: JSON.stringify(version) },
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
        clean: true,
        external: [/^@earendil-works\//],
    },
    {
        ...shared,
        entry: { omp: "src/omp.ts" },
        clean: false,
        external: [/^@oh-my-pi\//],
    },
])
