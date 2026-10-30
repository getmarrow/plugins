# Vendored MCP pins check

`dist/codex-plugin-pins.js` is the `@getmarrow/mcp` 3.9.109 pack's own `package/dist/codex-plugin-pins.js`
(getmarrow/marrow-mcp commit `990aaaa673a3d117599a33a8972dedc1398e240e`, built from `src/codex-plugin-pins.ts`); it is
byte-identical to the 3.9.108 pack's, so its digest is unchanged. `scripts/codex-plugin-pins-check.cjs` is the check script of
getmarrow/marrow-mcp commit `e3752f3baa511bb3071b73f521ba2b3bb526d0fd` (the 3.9.108 release commit), unchanged since 3.9.107: the
pack does not ship it, and it was not re-fetched for 3.9.109.

| Here | There |
| --- | --- |
| `scripts/codex-plugin-pins-check.cjs` | `scripts/codex-plugin-pins-check.cjs` (commit `e3752f3b`) |
| `dist/codex-plugin-pins.js` | `dist/codex-plugin-pins.js` (the 3.9.109 pack; commit `990aaaa6`) |

The pack is `@getmarrow/mcp` 3.9.109, sha512 integrity
`sha512-tgGXtv7vTxhtD2/HRbAGBjPpZ3fQYWXPN6XkJhVx07YCvg2sGfhkFbD+QfP+c56FbeVa5Rwbe4B50kiRuM+rdQ==`.

`SHA256SUMS` holds their digests; `tools/pins-check-ci.cjs` checks them before it runs anything.

The pins module is the MCP's list of the SHA-256 of the six files of each official Codex plugin
(`.codex-plugin/plugin.json`, `.mcp.json`, `scripts/marrow-launch.cjs`, `scripts/mcp-manifest.json`,
`package.json`, `package-lock.json`). It is what a published `@getmarrow/mcp` uses to decide that an
installed plugin is the official one. This repository's CI recomputes the six digests of every plugin
in `OFFICIAL_CODEX_PLUGIN_DIRS` and fails on any difference.

Refresh them only from the `@getmarrow/mcp` commit that is the deciding release for the plugin
release (see `docs/PLUGIN-RELEASE.md`): copy the two files, update `SHA256SUMS` and the commit above in
the same change.
