# Releasing

Three packages publish to npm, each on its own tag, each through GitHub Actions
OIDC trusted publishing (no npm token or 2FA in CI).

## `better-compact` (the OpenCode plugin)

1. Bump `packages/opencode/package.json` `version`, commit, push to `master`.
2. Tag and push:
   ```bash
   git tag v0.2.1 && git push origin v0.2.1
   ```
   `.github/workflows/release.yml` verifies the tag matches the version, runs
   the full gate, smoke-installs the tarball through a real `opencode`, and
   publishes with provenance.

## `@better-compact/core` (the shared ladder)

1. Bump `packages/core/package.json` `version`, commit, push to `master`.
2. Tag and push with the `core-v` prefix:
   ```bash
   git tag core-v0.1.1 && git push origin core-v0.1.1
   ```
   `.github/workflows/release-core.yml` verifies the tag matches the version,
   runs typecheck + tests, then `pnpm pack`s the package (so `publishConfig`
   repoints `exports`/`main`/`types` at `dist`) and `npm publish`es that tarball
   with provenance.

### One-time trusted-publisher setup (required before the first CI core release)

`@better-compact/core@0.1.0` was published manually. For CI to publish future
versions without a token, configure a trusted publisher once on npmjs.com:

- npmjs.com → the `@better-compact/core` package → **Settings → Trusted Publishing**
- Add a **GitHub Actions** publisher:
  - Repository owner/name: `AshishKumar4/better-compact`
  - Workflow filename: `release-core.yml`

After that, a `core-v*` tag publishes core hands-off, the same way the plugin
already releases.

## `@better-compact/pi` (the pi and Oh My Pi extensions)

> **Trusted publishing is not bound for this package yet.** 0.2.0 and 0.3.0 were
> both published by hand, so a `pi-v*` tag currently gets all the way through
> typecheck, tests, build, pack and provenance signing and then fails the final
> `npm publish` with `E404 … or you do not have permission` — npm's response when
> the OIDC identity has no publish rights. Bind it once (below) and the tag
> pipeline works from then on; until then, publish manually and expect the tag's
> CI run to go red.

1. Bump `packages/pi/package.json` `version`, commit, push to `master`.
2. Tag and push with the `pi-v` prefix:
   ```bash
   git tag pi-v0.3.0 && git push origin pi-v0.3.0
   ```
   `.github/workflows/release-pi.yml` verifies the tag matches the version,
   runs typecheck + tests, builds and `pnpm pack`s the package, and `npm publish`es
   that tarball with provenance.

Manual publish, needed until the trusted publisher is bound (and for the very
first publish of any package, because npm can only bind a trusted publisher to a
package that already exists):

```bash
npm login                     # web login
cd packages/pi && pnpm build
npm publish "$(pnpm pack --pack-destination /tmp | tail -1)" --access public
```

A manual publish has no provenance attestation — check with
`npm view @better-compact/pi --json` and look for `dist.attestations`.

To bind the trusted publisher: npmjs.com → the `@better-compact/pi` package →
**Settings → Trusted Publishing** → GitHub Actions, repository
`AshishKumar4/better-compact`, workflow `release-pi.yml`. After that, re-running
the failed job of an existing tag is enough — the tag already matches the
version, so no new tag is needed:

```bash
gh run rerun <run-id> --failed
```

## `@better-compact/cli` (the Claude Code compaction CLI)

1. Bump `packages/cli/package.json` `version`, commit, push to `master`.
2. Tag and push with the `cli-v` prefix:
   ```bash
   git tag cli-v0.2.0 && git push origin cli-v0.2.0
   ```
   `.github/workflows/release-cli.yml` verifies the tag matches the version,
   runs typecheck + tests, builds and `pnpm pack`s the package, and `npm publish`es
   that tarball with provenance via the configured npmjs trusted publisher
   (GitHub Actions, workflow `release-cli.yml`) — no token or 2FA involved.

## One-time trusted-publisher setup (required before the first CI proxy release)

The first publish of `@better-compact/cli@0.1.0` must be manual from an
authenticated npm session. After it exists, configure a trusted publisher once
on npmjs.com so CI can publish future versions without a token:

- npmjs.com → the `@better-compact/cli` package → **Settings → Trusted Publishing**
- Add a **GitHub Actions** publisher:
  - Repository owner/name: `AshishKumar4/better-compact`
  - Workflow filename: `release-proxy.yml`

After that, subsequent `proxy-v*` tags publish the proxy tokenlessly with
provenance.
