# Marrow plugins for Claude Code, Codex and Cursor

The `getmarrow` marketplace for Claude Code, Cursor and Codex. Each host's `marrow` plugin adds Marrow's approval hooks, the Marrow MCP server and a short skill to that host. Codex also has `marrow-advisory`, with no hooks.

| Host | Plugin folder | Marketplace file |
| --- | --- | --- |
| Claude Code | `plugins/marrow` | `.claude-plugin/marketplace.json` |
| Cursor | `plugins/marrow-cursor` | `.cursor-plugin/marketplace.json` |
| Codex | `codex/marrow` (hooks), `codex/marrow-advisory` (no hooks; install one of the two, not both) | `.agents/plugins/marketplace.json` |

Each plugin governs its own host only. The Claude Code plugin does not govern Cursor, even where Cursor imports Claude Code plugins: Cursor users install the Cursor plugin.

## Install in Claude Code

In Claude Code:

```text
/plugin marketplace add getmarrow/plugins
/plugin install marrow@getmarrow
```

Or from your shell, in one command (Claude Code v2.1.292 or later):

```bash
claude plugin install marrow --marketplace getmarrow/plugins
```

No account or key is needed to install. Claude Code shows what the plugin adds before you confirm. If it asks, run `/reload-plugins`. The hooks and MCP server need Node.js 18 or later on `PATH`, as Marrow's `npx` hooks do today.

Check that `claude plugin marketplace list` shows `getmarrow` coming from `getmarrow/plugins`, and that `claude plugin list` shows exactly one `marrow@...` plugin.

To stay on one reviewed release of the marketplace itself, add it by tag: `/plugin marketplace add getmarrow/plugins#v0.2.1`.

## Install in Cursor

Install **Marrow** from the Cursor plugin marketplace (Settings → Plugins), or add this repository as a plugin source. No account or key is needed to install, and no plugin config holds a key. The hooks and MCP server need Node.js 18 or later on `PATH`, and the first hook call installs the pinned package once (see "Pinned versions" below), so the first call needs the network. Restart Cursor after installing, then check that Cursor's hooks view lists Marrow's hooks.

Only the MCP server, without hooks, is a one-click link (a page renders it as a link or an "Add to Cursor" button):

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=marrow&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcGFja2FnZT1AZ2V0bWFycm93L21jcEAzLjkuMTAyIiwibWFycm93LW1jcCJdfQ==
```

The `config` value is base64 of `{"command":"npx","args":["-y","--package=@getmarrow/mcp@3.9.102","marrow-mcp"]}`, pinned, with no key and no `env`. The MCP server alone is advisory: approvals are enforced only by the plugin's hooks. Unlike the plugin, the link starts the server through `npx`, which can pick up a copy of `@getmarrow/mcp` that a project's `node_modules` claims at the same version. Prefer the plugin.

## What each plugin adds

| Component | Claude Code (`plugins/marrow`) | Cursor (`plugins/marrow-cursor`) |
| --- | --- | --- |
| Hooks | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and the async `PermissionRequest` and `PostToolBatch` hooks: the events `npx @getmarrow/install` writes into `.claude/settings.json`. Their tool matcher sends Marrow every tool call the installer's matcher does, and skips only this plugin's own 17 Marrow tools by exact name. A warn-only `SessionStart` check says when Marrow is also set up outside the plugin or another plugin named `marrow` is enabled. | The ten hooks `npx @getmarrow/install` 0.1.70 writes into `.cursor/hooks.json`: `preToolUse`, `beforeShellExecution` and `beforeMCPExecution` (15 s, `failClosed`), `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `afterMCPExecution`, `stop`, `sessionStart` and `beforeSubmitPrompt`, with the installer's matchers byte for byte. |
| MCP server | `.mcp.json`: server `marrow`. Its tools are on demand. | `mcp.json`: server `marrow`. Its tools are on demand. |
| Skill | `skills/marrow`: when to call Marrow, holds and approvals, the key step, update commands. | `skills/marrow`: the same rules for Cursor. |

Both run the pinned `@getmarrow/mcp` 3.9.102 entrypoints, the same ones the installer writes, through the same launcher. The plugins add no policy of their own.

Hooks are cooperative, client-reported control. They act only while the plugin is enabled and the host runs them. A configured hook never proves coverage or enforcement on its own.

**Hook commands.** Every hook command is one string that names the plugin root variable and the entrypoint inline (`node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook`, `node "${CURSOR_PLUGIN_ROOT}/scripts/marrow-launch.cjs" cursor-pre-action-hook`, `${PLUGIN_ROOT}` on Codex). None is relative to your project and none relies on separate `args`, which a host that imports the plugin may drop. The launcher starts the MCP server only for the explicit `mcp` argument in the plugin's MCP config; started with no argument it refuses (exit 2) and starts nothing. `tools/check.cjs` enforces both.

**Cursor: how Marrow's own tools are told apart.** Cursor's `preToolUse` names an MCP tool `MCP:<tool>`, with no server, so a name cannot prove which server it came from. The plugin uses `@getmarrow/install` 0.1.70's matchers byte for byte: every label that holds `MCP:` reaches the hook, `MCP:marrow_<anything>` included, and no MCP label is skipped by name. The pinned hook then allows Marrow's own tools only for the server exactly `marrow` and an exact registered tool name; `Marrow`, `MARROW`, padded and re-cased names go the normal path. `beforeMCPExecution` carries the server name and has no matcher. The plugin sends every MCP call there, Marrow's own included, to the pinned hook, with no fast-allow guard, so it never allows more than the installer's guard does.

## Key

Without a key, routine and read-only tool calls run as usual, protected actions (deploy, publish, push, credential access and similar) are held with "Marrow has no API key on this machine", and the MCP server does not start. To connect, create an agent key at https://getmarrow.ai, then keep it in a file in your own terminal:

```bash
mkdir -p ~/.marrow && chmod 700 ~/.marrow
# put MARROW_API_KEY=<your_key> in ~/.marrow/env
chmod 600 ~/.marrow/env
```

Or set `MARROW_API_KEY` in the environment that starts the host. Then run `/reload-plugins` in Claude Code, or restart Cursor. Never paste a key into chat.

The plugins carry the hooks, so the hold message's "run the installer activate command" step is not needed for Claude Code or Cursor in a project that uses the plugin. That command (`MARROW_API_KEY=<your_key> npx -y @getmarrow/install@latest activate`) writes a second copy of the hooks there. To check the key and connection, run `npx -y @getmarrow/install@latest doctor`. It only reads. Until `@getmarrow/install` 0.1.70, it reports Claude Code and Cursor hooks as missing, because the plugin holds them.

## Pinned versions and updates

- `package.json` and `package-lock.json` (the same files in both plugins) pin `@getmarrow/mcp` 3.9.102 and `@getmarrow/sdk` 3.7.65 with sha512 integrity, equal to `@getmarrow/install` 0.1.70's `src/pins.js`.
- Hooks start the package with `node`, not `npx`. Each start checks every file against `scripts/mcp-manifest.json`. Claude Code installs the lockfile into the plugin's cached copy with install scripts disabled. If that copy is missing or changed, or on Cursor, which installs no plugin dependencies, the launcher installs the same lockfile once (`npm ci --ignore-scripts`, outside your project) and checks that copy the same way. Claude Code keeps it in the plugin's data folder (`~/.claude/plugins/data/`, removed on uninstall), Cursor in `~/.marrow/cursor-plugin` (mode 700), Codex in `~/.codex/plugins/data/marrow-getmarrow/`. Nothing is fetched by version at run time and nothing runs from your project's `node_modules`.
- If no verified copy can be loaded (for example, offline on first use), the pre-action hook holds tool calls with a "Marrow plugin:" message until it can, and the other hooks report a non-blocking error.
- Each plugin sets `version`, so the host keeps you on the installed copy until a new version is published and you update. Third-party Claude Code marketplaces do not auto-update unless you turn that on.
- To update the Claude Code plugin after Marrow reports a client update:

```bash
claude plugin marketplace update getmarrow
claude plugin update marrow@getmarrow
```

In Cursor, update Marrow from Settings → Plugins.

## Uninstall

```bash
claude plugin uninstall marrow@getmarrow
claude plugin marketplace remove getmarrow
```

In Cursor, uninstall Marrow from Settings → Plugins, then remove its package copy: `rm -rf ~/.marrow/cursor-plugin`. In Codex, see "Update and remove" below.

The hooks and the MCP server live inside the plugin, so they go with it. What is left, exactly:

- **Claude Code.** Installing writes `enabledPlugins` (and, from the marketplace add, `extraKnownMarketplaces`) in `~/.claude/settings.json`; it writes no hook entries and does not touch your other settings. Uninstall removes the `enabledPlugins` entry and the plugin's data folder (`~/.claude/plugins/data/`). The cached plugin copy stays, marked `.orphaned_at`, until Claude Code's own cleanup removes it. `claude plugin marketplace remove getmarrow` removes the marketplace registration.
- **All hosts.** Marrow's runtime state under `~/.marrow` stays: for example `session-loop-guard/state.json`, and the cache, spool, health and host-approval files that build up in use. Your key file `~/.marrow/env` stays too. Delete the files you no longer want; nothing is deleted for you.

## Codex

The same repository is a Codex marketplace (`.agents/plugins/marketplace.json`) with two plugins:

| Plugin | What it adds |
| --- | --- |
| `marrow` | Marrow's Codex hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`), the Marrow MCP server and the skill. The hooks run the pinned `@getmarrow/mcp` 3.9.102 Codex entrypoints, the ones `npx @getmarrow/install` writes into `.codex/hooks.json`. Their tool matcher is `*`: every tool call reaches the hook, this plugin's own Marrow tools included, and the plugin exempts no tool by name. The pinned 3.9.102 hook then skips a call without a check when its label is exactly `mcp__marrow__<name>` for one of the 58 tool names the `marrow` server registers. It reads the label only and cannot tell which server produced it. |
| `marrow-advisory` | Advisory only: the Marrow MCP server and the skill, with no hooks. Nothing is held; Marrow sees an action only when the agent calls a `marrow_*` tool. |

Install one of them, not both: both name their MCP server `marrow`. Codex accepts both without a warning, and one server `marrow` then wins.

```bash
codex plugin marketplace add getmarrow/plugins
codex plugin add marrow@getmarrow
```

No account or key is needed to install. Start a new Codex session, then open `/hooks` and review and trust the Marrow hooks: Codex does not run plugin hooks until you trust them, and asks again whenever they change. On the first session start the plugin installs its pinned copy of `@getmarrow/mcp` (from `package-lock.json`, install scripts off) into `~/.codex/plugins/data/marrow-getmarrow/` and checks it against `scripts/mcp-manifest.json`; until a verified copy loads, `PreToolUse` holds tool calls with a "Marrow plugin:" message. Node.js 18 or later must be on `PATH`.

Key: without one, routine tool calls run and protected actions are held with "Marrow has no API key". Codex passes a plugin MCP server only `MARROW_API_KEY` from your environment (by name; no key is stored in any config), so the simplest setup is the key file:

    mkdir -p ~/.marrow && chmod 700 ~/.marrow
    # put MARROW_API_KEY=<your_key> in ~/.marrow/env
    chmod 600 ~/.marrow/env

Update and remove:

```bash
codex plugin marketplace upgrade getmarrow
codex plugin remove marrow@getmarrow      # or marrow-advisory@getmarrow
rm -rf ~/.codex/plugins/data/marrow-getmarrow
```

`codex plugin remove` leaves the package copy in `~/.codex/plugins/data/marrow-getmarrow` (about 3 MB); the `rm` step deletes it. The runtime state under `~/.marrow` and your key file stay, as above.

`npx @getmarrow/install` writes Codex hooks too, and what they do depends on its version:

- **0.1.70 (the version published before 2026-10-19).** Its tool-hook matcher uses a lookahead that Codex rejects (`invalid matcher`), so its `PreToolUse` and `PostToolUse` hooks never load and no Codex tool call is checked. Only its context and session hooks run. For protection in Codex, use this plugin.
- **0.1.71 and later (the 2026-10-19 release; not published until then).** The installer writes the matcher `*`, so its Codex hooks send every tool call to Marrow's check, Marrow's own tools included. The check itself is `@getmarrow/mcp`: from 3.9.103 it skips Marrow's own tools only when the host's own configuration proves that the `marrow` server is the official Marrow MCP server (the `npx -y @getmarrow/mcp` entry with no project or environment npm setting that could change where npx fetches it, the installed `marrow-mcp`, the installer's verified runtime, or this plugin, verified file by file and installed alone, with no other server that could give the same label). A look-alike server or plugin, or one Marrow cannot prove, is checked like any other tool. That needs the installer release to pin 3.9.103; until it does, the installer's hook runs 3.9.102 and skips by label alone, as this plugin's hooks do.
- **This plugin's own hooks** run the `@getmarrow/mcp` 3.9.102 it pins. They get every tool call (`*`), and 3.9.102 skips by label alone (see the table above). Moving them to a newer MCP is a later plugin release: a plugin release cannot pin an MCP that already carries that release's pins ([docs/PLUGIN-RELEASE.md](docs/PLUGIN-RELEASE.md)).

Use the plugin or the installer for Codex, not both. If the installer's `.codex/hooks.json` is also there, its context and session hooks run twice next to the plugin's, and from installer 0.1.71 its tool hooks run next to the plugin's as well, so every tool call is checked by two separate hooks; keep one copy. Hooks are cooperative, client-reported control.

The bundled skill (`skills/marrow/SKILL.md` and `references/hosts.md` in both packages) is the `getmarrow/skills` copy byte for byte. Copy it from the skills repo when that changes; `--skills <checkout>` below fails if either package differs.

Maintainers: `node tools/codex-check.cjs <marrow-install>/src/pins.js <marrow-mcp>/src/cli.ts <marrow-install>/src/installer.js --skills <getmarrow/skills checkout> --rust <wasm>` checks both packages and the matcher's name table. Build the Rust checker once with `cargo build --release --target wasm32-wasip1` in `tools/codex-rust-matcher` (it compiles the matcher with the `regex` crate, the engine Codex uses). Change pins with `node tools/codex-pin-manifest.cjs <dir>` (same steps as above, for `codex/marrow`, then copy `package.json` and the lockfile into `codex/marrow-advisory`), and keep `OWN_TOOLS` in `tools/codex-matcher.cjs` equal to the default tool set. The tool matcher is the wildcard `*`, so no matcher is generated and no tool name belongs in `hooks/hooks.json`; `tools/codex-check.cjs` fails if one does.

## Using Marrow with other agents

Gemini CLI, Windsurf and other hosts get Marrow from the installer, run by the owner in a terminal: `MARROW_API_KEY=<your_key> npx -y @getmarrow/install@latest activate`, then `npx -y @getmarrow/install@latest doctor`. The skills for those agents are at https://github.com/getmarrow/skills.

## Maintainers: changing the pins

The Codex plugins are also pinned by `@getmarrow/mcp`: read [docs/PLUGIN-RELEASE.md](docs/PLUGIN-RELEASE.md) for the order before you change any of their six pinned files or bump their version. CI (`.github/workflows/codex-plugin-pins.yml`) fails on a pinned file that has no matching pin.

1. Set the new exact versions in `plugins/marrow/package.json`, then `npm install --package-lock-only --ignore-scripts` there.
2. In an empty directory with copies of `package.json` and `package-lock.json`: `npm ci --ignore-scripts`.
3. `node tools/pin-manifest.cjs <that directory>`.
4. Copy `package.json`, `package-lock.json`, `scripts/marrow-launch.cjs` and `scripts/mcp-manifest.json` to `plugins/marrow-cursor` (`tools/check.cjs` requires identical bytes).
5. Raise `version` in `plugins/marrow/.claude-plugin/plugin.json` and `plugins/marrow-cursor/.cursor-plugin/plugin.json`. A host keeps a cached copy while the version is unchanged, so a pin change without a version change never reaches users.
6. If the new MCP release changes its default tool set, update `OWN_TOOLS` in `tools/check.cjs` and the matcher in `plugins/marrow/hooks/hooks.json`. If the installer changes its Cursor hooks, update `plugins/marrow-cursor/hooks/hooks.json` and `CURSOR_EXPECTED`.
7. Run the checks:
   - `node tools/check.cjs <marrow-install>/src/pins.js <marrow-mcp>/src/cli.ts <marrow-mcp>/dist/hook-contract.js [<candidate marrow-mcp>/dist/hook-contract.js ...] [--installer-cursor-hooks <hooks.json the installer writes for Cursor>]` (use `src/tool-catalog.ts` for 3.9.102 and later in place of `src/cli.ts`)
   - `node tools/codex-check.cjs <marrow-install>/src/pins.js <marrow-mcp>/src/cli.ts <marrow-install>/src/installer.js --skills <getmarrow/skills checkout>`
   - `node tools/test-launcher.cjs claude` and `node tools/test-launcher.cjs cursor`
   - `claude plugin validate plugins/marrow --strict`
8. Tag the release (`v<version>`).

Pins follow the `@getmarrow/install` release (`src/pins.js`): the same MCP version, SDK version and integrity.
