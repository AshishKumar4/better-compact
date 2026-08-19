import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

/**
 * The manifest contract that decides whether an install succeeds.
 *
 * Oh My Pi resolves one manifest per package — `pluginPkg.omp || pluginPkg.pi`
 * (`extensibility/plugins/loader.ts`) — and then validates *every* entry that
 * manifest declares by actually loading it (`plugins/manager.ts`
 * `#validateInstalledExtensions`). So the `omp` key must exist and must point
 * only at the Oh My Pi artifact: a package declaring just `pi` makes Oh My Pi
 * validate the pi entry, which fails to load there with
 * `Export named 'sessionEntryToContextMessages' not found` and aborts the whole
 * install.
 */
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf-8")) as {
    version: string
    omp?: { extensions?: string[] }
    pi?: { extensions?: string[] }
    files?: string[]
    exports?: Record<string, string>
}

test("Oh My Pi resolves the omp manifest, and it names only the omp artifact", () => {
    const manifest = pkg.omp ?? pkg.pi
    assert.deepEqual(
        manifest?.extensions,
        ["./dist/omp.js"],
        "the resolved manifest must declare exactly the Oh My Pi entry",
    )
})

test("pi keeps its own entry, so one package still serves both hosts", () => {
    assert.deepEqual(pkg.pi?.extensions, ["./dist/extension.js"])
})

test("both artifacts are published", () => {
    assert.ok(pkg.files?.includes("dist/"), "dist/ must be in files")
    assert.equal(pkg.exports?.["."], "./dist/extension.js")
    assert.equal(pkg.exports?.["./omp"], "./dist/omp.js")
})

test("the version is at or past the release that added Oh My Pi support", () => {
    const [major, minor] = pkg.version.split(".").map(Number)
    assert.ok(
        major > 0 || minor >= 3,
        `Oh My Pi support ships from 0.3.0; found ${pkg.version}`,
    )
})
