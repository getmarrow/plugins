---
name: marrow
description: Set up and use Marrow, the approval and proof layer for AI coding agents, in Codex, Cursor, Gemini CLI, Windsurf, Cline, Grok, Claude Code and other MCP hosts. Use before consequential actions (deploy, publish, release, push or merge to a protected branch, database migration, credential or secret access, production config, destructive commands), when a Marrow hook holds or blocks an action, when Marrow reports a client update, or when the user asks to install, connect, verify, update or remove Marrow.
license: MIT
metadata:
  author: getmarrow
  version: "0.1.0"
  install-package: "@getmarrow/install@0.1.68"
  mcp-package: "@getmarrow/mcp@3.9.100"
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
6. For a consequential command on a host without Marrow hooks, run it through the governed wrapper: `npx -y @getmarrow/install@0.1.68 run -- -- <command>`. It covers only that command.

## Setting Marrow up

Show the owner these steps. The owner runs them in their own terminal; run a setup, update or removal command yourself only when the owner asks you to in this session. Never ask for a key in chat, print it, or put it on a command line.

**Claude Code:** use the plugin. No account or key is needed to install:

```text
/plugin marketplace add getmarrow/plugins
/plugin install marrow@getmarrow
```

**Codex, Cursor, Gemini CLI, Windsurf, Cline, Grok:**

1. Create an agent key at https://getmarrow.ai and store it as `MARROW_API_KEY`, or as a line `MARROW_API_KEY=...` in `~/.marrow/env` with `chmod 600 ~/.marrow/env`.
2. In the project's terminal: `npx -y @getmarrow/install@0.1.68`. It detects the hosts, writes Marrow's hooks and MCP configuration, keeps the owner's other settings, and runs a self-test. Without a key it stops before writing anything.
3. Restart the host and finish its hook review. Each host's step is in [references/hosts.md](references/hosts.md).
4. Verify: `npx -y @getmarrow/install@0.1.68 doctor --self-test`.

If the Marrow Claude Code plugin is installed on this machine, tell the owner that step 2 also writes Claude Code hooks into this project, which then run twice next to the plugin's. They choose which copy to keep.

## Updates and removal

Packages never update themselves. When Marrow returns a `client_update` notice, tell the operator and give its exact update and verification commands. Run them only when the owner asks.

To remove Marrow from a project: `npx -y @getmarrow/install@0.1.68 uninstall` previews what would be removed; add `--yes` to remove Marrow's own entries. The owner's other hooks and settings stay. Restart the hosts afterwards. In Claude Code with the plugin: `claude plugin uninstall marrow@getmarrow`.
