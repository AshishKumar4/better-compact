# OpenCode scripts

> Edited and maintained by Claude. Provided as-is.

Development and release tools for the OpenCode package. These files are not included in the npm package.

## Package checks

| Script                       | Use                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `verify-package.mjs`         | Check required files, manifest fields, imports, entrypoints, and tarball contents |
| `verify-release.mjs`         | Check that a `v*` tag matches the package version                                 |
| `smoke-opencode-install.mjs` | Install through a real OpenCode binary and load both plugin entrypoints           |

Run from `packages/opencode`:

```bash
pnpm verify:package
pnpm verify:release
pnpm smoke:install
```

## Session inspection

| Script                          | Use                                        |
| ------------------------------- | ------------------------------------------ |
| `opencode-find-session`         | Find a stored session                      |
| `opencode-get-message`          | Print one message                          |
| `opencode-session-timeline`     | Print a session timeline                   |
| `opencode-token-stats`          | Summarize token usage                      |
| `opencode-message-token-counts` | Show token counts by message               |
| `opencode-better-compact-stats` | Show Better Compact plan and savings data  |
| `opencode_api.py`               | Shared storage helpers used by the scripts |

Run a script directly from this directory:

```bash
./opencode-find-session <query>
./opencode-session-timeline <session-id>
./opencode-better-compact-stats <session-id>
```
