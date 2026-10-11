---
name: marrow
description: Set up and use Marrow, the approval and proof layer for AI coding agents, in Codex, Cursor, Gemini CLI, Windsurf, Cline, Grok, Claude Code and other MCP hosts. Use before consequential actions (deploy, publish, release, push or merge to a protected branch, database migration, credential or secret access, production config, destructive commands), when a Marrow hook holds or blocks an action, when Marrow reports a client update, or when the user asks to install, connect, verify, update or remove Marrow.
license: MIT
metadata:
  author: getmarrow
  version: "0.2.0"
  install-package: "@getmarrow/install@0.1.69"
  mcp-package: "@getmarrow/mcp@3.9.101"
---

# Marrow

Marrow checks consequential agent actions against the owner's policy, routes approvals to the owner, and keeps receipts. What it covers depends on how it is connected:

- Native hooks, which `@getmarrow/install` writes for the host, give cooperative, client-reported control and lifecycle evidence. They act only after the host restarts and the owner finishes the host's hook review.
- The Marrow MCP server gives `marrow_*` tools on demand. They do nothing until called.
- The governed wrapper covers only the one command it wraps.

A model name, API key, installed configuration or detected hook file never proves coverage or enforcement.

## Rules when Marrow is connected

1. Before a consequential action, call the `marrow_agent_runtime` tool and follow its decision: `allow`, `warn`, `review_required` or `block`. `review_required` and `block` do not grant permission. Reuse `runtime.decision_id` when its completion contract names a created decision; keep `runtime.runtime_authorization.id` separate as `gate_receipt_id`.
2. When a hook holds an action, tell the person what is waiting and why, carry on with other work, and retry only after they approve the way the hook says. Never approve, write or claim an approval yourself.
3. Never edit, disable or work around Marrow's hooks, MCP entry, host settings, hook trust or permission rules to get past a hold, and never ask the person to do so.
4. After meaningful work, record the real result with `marrow_commit`. Only `committed: true` confirms closure. Leave unfinished work visible.
5. If Marrow is offline it says so. That is not a policy denial: low-risk work goes on and the record is queued. High-risk work still needs a fresh gate.
6. For a consequential command on a host without Marrow hooks, run it through the governed wrapper: `npx -y @getmarrow/install@0.1.69 run -- -- <command>`. It covers only that command.

## Setting Marrow up

Show the owner these steps. The owner runs them in their own terminal; run a setup, update or removal command yourself only when the owner asks you to in this session. Never ask for a key in chat, print it, or type it into a command yourself: the owner puts their key in place of `<your_key>` in their own terminal.

**Claude Code:** use the plugin. No account or key is needed to install:

```text
/plugin marketplace add getmarrow/plugins
/plugin install marrow@getmarrow
```

**Cursor:** use the Marrow plugin from Cursor's plugin marketplace (Settings → Plugins). No account or key is needed to install; restart Cursor afterwards.

**Codex:** use the Marrow Codex plugin. Install one of the two, never both (both name their MCP server `marrow`): `marrow` holds protected actions with hooks, `marrow-advisory` has no hooks and holds nothing. No account or key is needed to install:

```bash
codex plugin marketplace add getmarrow/plugins
codex plugin add marrow@getmarrow
```

Start a new Codex session, then review and trust the Marrow hooks in `/hooks`; Codex does not run plugin hooks until they are trusted. The installer's Codex hooks are not accepted by Codex, so do not send Codex users to the installer for protection, and do not run the installer's activate command for Codex.

**Gemini CLI, Windsurf, Cline, Grok** (and Cursor without the plugin):

1. Create an agent key at https://getmarrow.ai.
2. In the project's terminal: `MARROW_API_KEY=<your_key> npx -y @getmarrow/install@latest activate`. It detects the hosts, writes Marrow's hooks and MCP configuration, keeps the owner's other settings, and runs a self-test. Without a key it stops before writing anything.
3. Restart the host and finish its hook review. Each host's step is in [references/hosts.md](references/hosts.md).
4. Verify: `npx -y @getmarrow/install@latest doctor`.

To keep the key in a file instead of the environment, the owner runs:

```bash
mkdir -p ~/.marrow && chmod 700 ~/.marrow
# put MARROW_API_KEY=<your_key> in ~/.marrow/env
chmod 600 ~/.marrow/env
```

With the Claude Code, Cursor or Codex plugin installed, the plugin needs only that key file (or `MARROW_API_KEY`), then a reload or restart. Do not run step 2 for that host in the same project, even when a Marrow message says to run the installer activate command: step 2 writes a second copy of the hooks, which then run twice next to the plugin's. If both are there, the owner chooses which copy to keep.

## Updates and removal

Packages never update themselves. When Marrow returns a `client_update` notice, tell the operator and give its exact update and verification commands. Run them only when the owner asks.

To remove Marrow from a project: `npx -y @getmarrow/install@0.1.69 uninstall` previews what would be removed; add `--yes` to remove Marrow's own entries. The owner's other hooks and settings stay. Restart the hosts afterwards. In Claude Code with the plugin: `claude plugin uninstall marrow@getmarrow`. In Cursor with the plugin: uninstall it in Settings → Plugins, then `rm -rf ~/.marrow/cursor-plugin`. In Codex with the plugin: `codex plugin remove marrow@getmarrow` (or `marrow-advisory@getmarrow`), then `rm -rf ~/.codex/plugins/data/marrow-getmarrow`, which holds the plugin's package copy.
