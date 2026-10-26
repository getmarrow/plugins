# Vendored MCP pins check

These two files are byte-identical to getmarrow/marrow-mcp commit
`e3752f3baa511bb3071b73f521ba2b3bb526d0fd`, the `@getmarrow/mcp` 3.9.108 release candidate commit:

| Here | There |
| --- | --- |
| `scripts/codex-plugin-pins-check.cjs` | `scripts/codex-plugin-pins-check.cjs` |
| `dist/codex-plugin-pins.js` | `dist/codex-plugin-pins.js` (built from `src/codex-plugin-pins.ts`) |

The pack is `@getmarrow/mcp` 3.9.108, sha512 integrity
`sha512-tbgRVlydUbc1or+i68xOO3QprN4Vp9tV0LBGhxD4WhIHeycyS7TqGg2sn4epMajx/nHcO0txjpjOdgqFf/1eEw==`. `dist/codex-plugin-pins.js` is that
pack's own `package/dist/codex-plugin-pins.js`; the pack does not ship the check script, so
`scripts/codex-plugin-pins-check.cjs` comes from the same commit (it is unchanged since 3.9.107).

`SHA256SUMS` holds their digests; `tools/pins-check-ci.cjs` checks them before it runs anything.

The pins module is the MCP's list of the SHA-256 of the six files of each official Codex plugin
(`.codex-plugin/plugin.json`, `.mcp.json`, `scripts/marrow-launch.cjs`, `scripts/mcp-manifest.json`,
`package.json`, `package-lock.json`). It is what a published `@getmarrow/mcp` uses to decide that an
installed plugin is the official one. This repository's CI recomputes the six digests of every plugin
in `OFFICIAL_CODEX_PLUGIN_DIRS` and fails on any difference.

Refresh them only from the `@getmarrow/mcp` commit that is the deciding release for the plugin
release (see `docs/PLUGIN-RELEASE.md`): copy the two files, update `SHA256SUMS` and the commit above in
the same change.
