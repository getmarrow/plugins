# Vendored MCP pins check

These two files are byte-identical to getmarrow/marrow-mcp commit
`868a9c18530a75fcee5052441d0d3d2383511df4`, the `@getmarrow/mcp` 3.9.103 release commit:

| Here | There |
| --- | --- |
| `scripts/codex-plugin-pins-check.cjs` | `scripts/codex-plugin-pins-check.cjs` |
| `dist/codex-plugin-pins.js` | `dist/codex-plugin-pins.js` (built from `src/codex-plugin-pins.ts`) |

`SHA256SUMS` holds their digests; `tools/pins-check-ci.cjs` checks them before it runs anything.

The pins module is the MCP's list of the SHA-256 of the six files of each official Codex plugin
(`.codex-plugin/plugin.json`, `.mcp.json`, `scripts/marrow-launch.cjs`, `scripts/mcp-manifest.json`,
`package.json`, `package-lock.json`). It is what a published `@getmarrow/mcp` uses to decide that an
installed plugin is the official one. This repository's CI recomputes the six digests of every plugin
in `OFFICIAL_CODEX_PLUGIN_DIRS` and fails on any difference.

Refresh them only from the `@getmarrow/mcp` commit that is the deciding release for the plugin
release (see `docs/PLUGIN-RELEASE.md`): copy the two files, update `SHA256SUMS` and the commit above in
the same change.
