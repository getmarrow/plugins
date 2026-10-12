# Releasing a Codex plugin: the pin order

`@getmarrow/mcp` skips Marrow's own tools on Codex only when the host's own configuration proves the
`marrow` server is the official one. For the official Codex plugin that proof is a SHA-256 list: the
MCP carries, per released `<plugin name>@<plugin version>`, the digest of six files, and the plugin is
official only if it is installed alone and all six match byte for byte. Any other plugin, or any other
bytes, is checked like a look-alike. The list is `src/codex-plugin-pins.ts` in getmarrow/marrow-mcp
(`OFFICIAL_CODEX_PLUGIN_PINS`, `OFFICIAL_CODEX_PLUGIN_DIRS`).

## The six pinned files (each of `codex/marrow` and `codex/marrow-advisory`)

| File | Why it decides what the `marrow` server runs |
| --- | --- |
| `.codex-plugin/plugin.json` | the manifest; names `.mcp.json` and carries the version the pins are keyed by |
| `.mcp.json` | the server command (`node ./scripts/marrow-launch.cjs mcp`) |
| `scripts/marrow-launch.cjs` | the launcher: what it installs and runs |
| `scripts/mcp-manifest.json` | the pinned MCP version, tarball integrity, file list and tree digest |
| `package.json` | the MCP version the launcher reads |
| `package-lock.json` | the source `npm ci` installs from |

Not pinned, so changed without an MCP release: `hooks/hooks.json`, `skills/`, `LICENSE`, `README.md`,
`docs/`, `tools/`, `.github/` and the Claude and Cursor plugins (the MCP pins only the Codex plugins).

## Order

1. **A plugin release pins an older MCP.** `scripts/mcp-manifest.json` holds the integrity of the MCP
   tarball the plugin installs. That tarball cannot also carry the plugin's own pins, because the pins
   contain the digest of `mcp-manifest.json`, which contains the tarball's integrity: a hash fixed
   point. So the plugin pins MCP *X*, and a newer **deciding MCP** *Y* carries the plugin release's pins.
   Only a hook that runs *Y* (the installer's `*` hooks once it pins *Y*) can prove the plugin. The
   plugin's own hooks run *X* and skip by label alone.
2. **The deciding MCP carries the release's pins before the plugin ships.** In this order:
   1. Build the plugin release commit (pinned files final).
   2. Take the six digests per plugin (`node tools/pins-check-ci.cjs` prints `expected` and `got`;
      `sha256sum` of the six files gives the same).
   3. Add `<name>@<version>` to `src/codex-plugin-pins.ts` in the MCP, rebuild `dist/`, run its
      `node scripts/codex-plugin-pins-check.cjs <plugins checkout>` (exit 0), publish MCP *Y*, and have the
      installer pin *Y*.
   4. In this repository, copy the MCP's `scripts/codex-plugin-pins-check.cjs` and
      `dist/codex-plugin-pins.js` from the *Y* commit into `tools/mcp-pins/`, update `SHA256SUMS` and
      `SOURCE.md`. `.github/workflows/codex-plugin-pins.yml` then passes.
   5. Tag and publish the plugin.
   A plugin that ships first has no pins in any published MCP, so it fails closed for users (its own
   tools are checked) and this repository's CI is red. Do not release past a red check.
3. **A version bump changes a pinned file.** `plugin.json` holds the version and is pinned, so every
   version bump, even one that changes only unpinned files, needs a new pins entry and follows step 2.
   Changing a pinned file without a bump makes the pins check fail: the installed bytes would no longer
   match the entry for that version.

## What the CI proves, and does not

`tools/pins-check-ci.cjs` (run by `.github/workflows/codex-plugin-pins.yml` on every pull request and
push) verifies the vendored MCP check by SHA-256, requires every pinned file of both plugins to match,
and changes one byte of each pinned file in turn to show the check fails. It proves the repository
matches the vendored pins. It does not prove those pins are in a published MCP: before a release, step
2.3 must be done and `tools/mcp-pins/` refreshed from that commit. A new plugin directory that is not
in `OFFICIAL_CODEX_PLUGIN_DIRS` is not checked (it fails closed at runtime).

## Existing installs

A change to unpinned files only (this repository's `*` matcher and text) keeps `marrow@0.1.1`. Codex
0.161, tested with a local marketplace: `codex plugin add marrow@getmarrow` again replaced the cached
files of the unchanged version (the cache copy of `hooks/hooks.json` went from the old matcher to `*`).
An install that is never re-added keeps the old files, and the owner must trust the changed hooks again
in `/hooks`. Not tested: whether `codex plugin marketplace upgrade` of a Git marketplace alone refreshes
the cache. A new install gets the current files.
