---
name: marrow
description: Marrow approval and proof rules for this Claude Code session. Use before consequential actions (deploy, publish, release, push or merge to a protected branch, database migration, credential or secret access, production config, destructive commands), when a Marrow hook holds or blocks a tool call, when Marrow says it has no API key, when Marrow reports a client update, or when the user asks to set up, update or remove Marrow.
---

# Marrow

Marrow is the approval and proof layer for agent actions. The marrow plugin adds:

- Hooks before and after tool calls. They run the pinned `@getmarrow/mcp` 3.9.106 entrypoints, the same ones `npx @getmarrow/install` writes. Hooks are cooperative, client-reported control: they act only while this plugin is enabled and Claude Code runs them, and a configured hook never proves coverage on its own.
- The Marrow MCP server. Its `marrow_*` tools are on demand: they do nothing until called.

## Rules

1. Before a consequential action, call the Marrow `marrow_agent_runtime` tool and follow its decision: `allow`, `warn`, `review_required` or `block`. `review_required` and `block` do not grant permission. Reuse `runtime.decision_id` when its completion contract names a created decision; keep `runtime.runtime_authorization.id` separate as `gate_receipt_id`.
2. When a hook holds a call, tell the person what is waiting and why, carry on with other work, and retry only after they approve in Claude Code's own prompt or as the hook says. Never approve, write or claim an approval yourself.
3. Never edit, disable or work around Marrow's hooks, this plugin's files, Claude Code settings, hook trust or permission rules to get past a hold, and never ask the person to do so.
4. After meaningful work, record the real result with `marrow_commit`. Only `committed: true` confirms closure. Leave unfinished work visible; never invent success.
5. If Marrow is offline it says so. That is not a policy denial: low-risk work goes on and the record is queued locally. High-risk work still needs a fresh gate.

## No key yet

Installing the plugin needs no account and no key. The hooks run `@getmarrow/mcp` 3.9.106, which includes the free keyless seatbelt: when there is no usable key and the machine shows no sign of a Marrow account, they stop seven kinds of action with the host's own deny and make no network call. The seven are changes to Marrow's own hooks, settings or plugins (and owner-only Marrow commands), force-push or delete of a protected branch, a production deploy, a package publish, reading credentials or secrets (a project `.env` file other than a template included), a recursive delete outside the workspace, and decoded data run by a shell or interpreter. Everything else gets no Marrow decision, so Claude Code's own approval step decides. It is a seatbelt, not a vault: a determined agent can get around a local check. With an account, Marrow holds risky actions for approval and keeps the audit trail.

When a seatbelt stop appears, tell the person what was stopped; it needs the machine owner. Do not retry it another way, and do not change Marrow's hooks, settings or plugins to get past it. Until a key exists:

- the Marrow MCP server starts with no tools. It makes no decisions and records nothing, so `marrow_agent_runtime` and `marrow_commit` do not exist yet: do not look for them, do not treat having no tool as an approval, and leave the hooks' holds and stops as they are;
- if the seatbelt cannot run on this machine (a home or agent settings folder that others can write), every hold stays, and the hold says "Marrow has no working key on this machine and its keyless mode is off here".

To connect an account, the owner does this in their own terminal, never in chat:

1. Create an agent key at https://getmarrow.ai.
2. Keep it in a file Marrow reads:

   ```bash
   mkdir -p ~/.marrow && chmod 700 ~/.marrow
   # put MARROW_API_KEY=<your_key> in ~/.marrow/env
   chmod 600 ~/.marrow/env
   ```

   Or set `MARROW_API_KEY` in the environment that starts Claude Code.
3. Run `/reload-plugins` or restart Claude Code.

Never ask for the key in chat, never print it, and never put it on a command line yourself. With this plugin installed, do not suggest the installer activate command (`npx -y @getmarrow/install@latest activate`) or `marrow-mcp setup` for Claude Code in the same project, nor the installer's `--repair`, even when a Marrow message says to run them: they write a second copy of the hooks. The key step above is all the plugin needs to connect an account. To check the key and connection, the owner can run `npx -y @getmarrow/install@latest doctor`, which only reads; installer 0.1.71 and later count this plugin's hooks, and 0.1.70 and earlier report Claude Code hooks as missing because this plugin holds them.

If a call is held with "Marrow plugin: ... could not load a verified copy" or "... is not installed yet", Marrow itself could not start. Marrow needs Node.js 18 or newer with npm on `PATH`: if the message says Node.js is too old or npm was not found, the owner installs them and restarts Claude Code. Tell the owner the message; do not retry around it.

## Updates and removal

The plugin pins its packages and never updates itself or any other package. When Marrow returns a `client_update` notice, tell the operator and give these exact commands; run them only if the owner asks in this session:

```bash
claude plugin marketplace update getmarrow
claude plugin update marrow@getmarrow
```

Then `/reload-plugins`. To remove Marrow from Claude Code: `claude plugin uninstall marrow@getmarrow`. Uninstalling removes the hooks and the MCP server with it.
