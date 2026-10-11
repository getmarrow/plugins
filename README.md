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

No account or key is needed to install. Claude Code shows what the plugin adds before you confirm. If it asks, run `/reload-plugins`.

## What it adds

| Component | What it does |
| --- | --- |
| Hooks (`hooks/hooks.json`) | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and the async `PermissionRequest` and `PostToolBatch` hooks. They run the pinned `@getmarrow/mcp` 3.9.100 Claude Code entrypoints, the same ones `npx @getmarrow/install` writes into `.claude/settings.json`. A warn-only `SessionStart` check says when Marrow is also set up outside the plugin. |
| MCP server (`.mcp.json`) | The Marrow MCP server. Its tools are on demand. |
| Skill (`skills/marrow`) | When to call Marrow, how holds and approvals work, the key step, and the update commands. |

Hooks are cooperative, client-reported control. They act only while the plugin is enabled and Claude Code runs them. A configured hook never proves coverage or enforcement on its own.

## Key

Without a key, routine and read-only tool calls run as usual, protected actions (deploy, publish, push, credential access and similar) are held with "Marrow can't find your key", and the MCP server does not start. To connect, create an agent key at https://getmarrow.ai and put it in `MARROW_API_KEY` or in `~/.marrow/env` (mode 600), then run `/reload-plugins`. Never paste a key into chat.

## Pinned versions and updates

- `plugins/marrow/package.json` and `package-lock.json` pin `@getmarrow/mcp` 3.9.100 and `@getmarrow/sdk` 3.7.65 with sha512 integrity. Claude Code installs them into the plugin's cached copy with install scripts disabled.
- Hooks start that copy with `node`, not `npx`. Each start checks the files against `scripts/mcp-manifest.json`; if they are missing or changed, the same entrypoint runs through `npx` at the same pinned version.
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
4. Raise `version` in `plugins/marrow/.claude-plugin/plugin.json`.
5. `node tools/check.cjs` and `claude plugin validate plugins/marrow --strict`.

Pins follow the `@getmarrow/install` release (`src/pins.js`): the same MCP version, SDK version and integrity.
