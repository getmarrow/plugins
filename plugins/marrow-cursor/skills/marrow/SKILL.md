---
name: marrow
description: Marrow approval and proof rules for this Cursor session. Use before consequential actions (deploy, publish, release, push or merge to a protected branch, database migration, credential or secret access, production config, destructive commands), when a Marrow hook holds or blocks a tool call, when Marrow says it has no API key, when Marrow reports a client update, or when the user asks to set up, update or remove Marrow.
---

# Marrow

Marrow is the approval and proof layer for agent actions. The Marrow plugin for Cursor adds:

- Hooks before and after tool calls, shell commands and MCP calls. They run the pinned `@getmarrow/mcp` 3.9.102 entrypoints, the same ones `npx @getmarrow/install` writes into `.cursor/hooks.json`. Hooks are cooperative, client-reported control: they act only while this plugin is enabled and Cursor runs them, and a configured hook never proves coverage on its own.
- The Marrow MCP server. Its `marrow_*` tools are on demand: they do nothing until called.

## Rules

1. Before a consequential action, call the Marrow `marrow_agent_runtime` tool and follow its decision: `allow`, `warn`, `review_required` or `block`. `review_required` and `block` do not grant permission. Reuse `runtime.decision_id` when its completion contract names a created decision; keep `runtime.runtime_authorization.id` separate as `gate_receipt_id`.
2. When a hook holds a call, tell the person what is waiting and why, carry on with other work, and retry only after they approve in Cursor's own prompt or with the typed reply the hook shows them. Never approve, write or claim an approval yourself, and never ask anyone to log in to a dashboard to approve.
3. Never edit, disable or work around Marrow's hooks, this plugin's files, `.cursor/hooks.json`, Cursor settings or permission rules to get past a hold, and never ask the person to do so.
4. After meaningful work, record the real result with `marrow_commit`. Only `committed: true` confirms closure. Leave unfinished work visible; never invent success.
5. If Marrow is offline it says so. That is not a policy denial: low-risk work goes on and the record is queued locally. High-risk work still needs a fresh gate.

## No key yet

Installing the plugin needs no account and no key. Until a key exists:

- read-only and routine tool calls run as usual;
- protected actions (deploy, publish, push, credential access and similar) are held with "Marrow has no API key on this machine";
- the Marrow MCP server does not start.

To connect, the owner does this in their own terminal, never in chat:

1. Create an agent key at https://getmarrow.ai.
2. Keep it in a file Marrow reads:

   ```bash
   mkdir -p ~/.marrow && chmod 700 ~/.marrow
   # put MARROW_API_KEY=<your_key> in ~/.marrow/env
   chmod 600 ~/.marrow/env
   ```

   Or set `MARROW_API_KEY` in the environment that starts Cursor.
3. Restart Cursor.

Never ask for the key in chat, never print it, and never put it on a command line yourself. With this plugin installed, do not suggest the installer activate command (`npx -y @getmarrow/install@latest activate`) or `marrow-mcp setup` for Cursor in the same project, even when a Marrow message says to run them: they write a second copy of the hooks into `.cursor/hooks.json`. The key step above is all the plugin needs. To check the key and connection, the owner can run `npx -y @getmarrow/install@latest doctor`, which only reads; until `@getmarrow/install` 0.1.70 it reports Cursor hooks as missing because this plugin holds them.

If a call is held with "Marrow plugin: ... could not load a verified copy", Marrow itself could not start (the first hook call installs the pinned package once and needs the network). Tell the owner the message; do not retry around it.

## Updates and removal

The plugin pins its packages and never updates itself or any other package. When Marrow returns a `client_update` notice, tell the owner to update Marrow from Cursor's Settings → Plugins. To remove Marrow from Cursor, the owner uninstalls it there, then runs `rm -rf ~/.marrow/cursor-plugin` to remove the plugin's package copy. Uninstalling removes the hooks and the MCP server with it.
