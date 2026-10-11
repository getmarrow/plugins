# Marrow plugins for Claude Code

The `getmarrow` marketplace. Its one plugin, `marrow`, adds Marrow's approval hooks, the Marrow MCP server and a short skill to Claude Code.

## Install

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

To stay on one reviewed release of the marketplace itself, add it by tag: `/plugin marketplace add getmarrow/plugins#v0.1.0`.


## What it adds

| Component | What it does |
| --- | --- |
| Hooks (`hooks/hooks.json`) | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and the async `PermissionRequest` and `PostToolBatch` hooks. They run the pinned `@getmarrow/mcp` 3.9.100 Claude Code entrypoints, the same ones `npx @getmarrow/install` writes into `.claude/settings.json`. Their tool matcher sends Marrow every tool call the installer's matcher does, and skips only this plugin's own 17 Marrow tools by exact name. A warn-only `SessionStart` check says when Marrow is also set up outside the plugin or another plugin named `marrow` is enabled. |
| MCP server (`.mcp.json`) | The Marrow MCP server. Its tools are on demand. |
| Skill (`skills/marrow`) | When to call Marrow, how holds and approvals work, the key step, and the update commands. |

Hooks are cooperative, client-reported control. They act only while the plugin is enabled and Claude Code runs them. A configured hook never proves coverage or enforcement on its own.

## Key

Without a key, routine and read-only tool calls run as usual, protected actions (deploy, publish, push, credential access and similar) are held with "Marrow can't find your key", and the MCP server does not start. To connect, create an agent key at https://getmarrow.ai and put it in `MARROW_API_KEY` or in `~/.marrow/env` (mode 600), then run `/reload-plugins`. Never paste a key into chat.

## Pinned versions and updates

- `plugins/marrow/package.json` and `package-lock.json` pin `@getmarrow/mcp` 3.9.100 and `@getmarrow/sdk` 3.7.65 with sha512 integrity. Claude Code installs them into the plugin's cached copy with install scripts disabled.
- Hooks start that copy with `node`, not `npx`. Each start checks every file against `scripts/mcp-manifest.json`. If the copy is missing or changed, the plugin installs the same lockfile once into its data directory (`npm ci --ignore-scripts`, outside your project, under `~/.claude/plugins/data/`) and checks that copy the same way. Nothing is fetched by version at run time and nothing runs from your project's `node_modules`.
- If no verified copy can be loaded (for example, offline on first use), the `PreToolUse` hook holds tool calls with a "Marrow plugin:" message until it can, and the other hooks report a non-blocking error.
- `plugin.json` sets `version`, so Claude Code keeps you on the installed copy until a new version is published and you update. Third-party marketplaces do not auto-update unless you turn that on.
- To update after Marrow reports a client update:

```bash
claude plugin marketplace update getmarrow
claude plugin update marrow@getmarrow
```

## Uninstall

```bash
claude plugin uninstall marrow@getmarrow
```

The hooks and the MCP server live inside the plugin, so they go with it. Settings files are not touched by install or uninstall.

## Using Marrow with other agents

Codex, Cursor, Gemini CLI and other hosts use `npx -y @getmarrow/install@0.1.68`, run by the owner in a terminal. The skills for those agents are at https://github.com/getmarrow/skills.

## Maintainers: changing the pins

1. Set the new exact versions in `plugins/marrow/package.json`, then `npm install --package-lock-only --ignore-scripts` there.
2. In an empty directory with copies of `package.json` and `package-lock.json`: `npm ci --ignore-scripts`.
3. `node tools/pin-manifest.cjs <that directory>`.
4. Raise `version` in `plugins/marrow/.claude-plugin/plugin.json`. Claude Code keeps a cached copy while the version is unchanged, so a pin change without a version change never reaches users.
5. If the new MCP release changes its default tool set, update `OWN_TOOLS` in `tools/check.cjs` and the matcher in `hooks/hooks.json`.
6. `node tools/check.cjs <marrow-install>/src/pins.js <marrow-mcp>/src/cli.ts` and `claude plugin validate plugins/marrow --strict`.
7. Tag the release (`v<version>`).

Pins follow the `@getmarrow/install` release (`src/pins.js`): the same MCP version, SDK version and integrity.
