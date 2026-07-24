import { defineConfig } from "tsup"
import { version } from "./package.json"

// One self-contained artifact for ~/.pi/agent/extensions drop-in and for the
// npm pi package: core is bundled, pi's own packages stay external because pi
// provides them at runtime.
export default defineConfig({
    entry: { extension: "src/extension.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: false,
    define: { __BC_VERSION__: JSON.stringify(version) },
    external: [/^@earendil-works\//],
    noExternal: ["@better-compact/core"],
})
