# Marrow for Claude Code

Marrow AI adds approvals and a record of what your agent did to Claude Code. Install it and, with no account and no key, a free local seatbelt stops seven kinds of risky action. Connect a Marrow account and risky actions are checked, with proof recorded afterwards. On the 30-day evaluation and Business, deploys and publishes wait for your approval; Team and Free get a warning.

## What it does in the first hour

- Installing needs no account and no key. At session start it prints one line, "Marrow seatbelt is on (no key yet)".
- With no key, hooks stop these seven kinds of action: a change to Marrow's own hooks, settings or plugins; a force-push or delete of a protected branch; a production deploy; a package publish; reading credentials or secrets, such as a project `.env` file; a recursive delete outside your workspace; and decoded data run by a shell. Everything else is left to Claude Code's own approval prompts.
- With a key, Marrow checks risky actions (a git push, a publish, a deploy, an API delete). On the 30-day evaluation and Business, deploys and publishes are held until you approve in Claude Code's own prompt; Team and Free get a warning. If Marrow cannot be reached, high-risk actions wait and routine ones run with a warning.
- Hooks are cooperative: they act only while the plugin is enabled and Claude Code runs them. Keep Claude Code's own permissions on.

## Install

```
/plugin marketplace add getmarrow/plugins
/plugin install marrow@getmarrow
```

To connect an account, create a key at https://getmarrow.ai/signup and put `MARROW_API_KEY=<your key>` in `~/.marrow/env` (run `chmod 600 ~/.marrow/env`), or set it in the environment that starts Claude Code. Then run `/reload-plugins`. Never paste a key into chat.

## Updates

The plugin pins one exact version of Marrow and stays on it until you update. To update by hand, run `/marrow:update` in Claude Code. It runs `npx @getmarrow/install@latest update`, which updates this plugin install in place (it runs `claude plugin marketplace update getmarrow` and `claude plugin update marrow@getmarrow -s <the installed scope> -y`) and adds no second copy of the hooks. Then run `/reload-plugins`.

To update automatically, turn on auto-update for this marketplace: in Claude Code open `/plugin`, go to Marketplaces, choose getmarrow and select Enable auto-update. Claude Code does not auto-update third-party marketplaces until you turn this on.

## What it runs, sends and fetches

- **Runs:** `node` runs `scripts/marrow-launch.cjs` for these Claude Code events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, PermissionRequest and PostToolBatch. The launcher starts the Marrow MCP package `@getmarrow/mcp` 3.9.113 and an MCP server named `marrow`. It loads only a copy whose files match `scripts/mcp-manifest.json` byte for byte.
- **Fetches:** once, the launcher runs `npm ci --ignore-scripts` from the plugin's `package-lock.json` to install `@getmarrow/mcp` 3.9.113 and `@getmarrow/sdk` 3.7.67 from your npm registry (npmjs.org by default), into the plugin's data folder. Install scripts are disabled. Nothing else is downloaded.
- **Sends, with a key:** to `https://api.getmarrow.ai`, compact classifications and lifecycle receipts for tool calls. A tool call is described by its kind and name, the program names (and edit paths, with your home folder as `~`) and a keyed hash of a normalized form (HMAC-SHA256 under a key derived from a device key that stays on your machine), not by its text, with two exceptions: `sst deploy --stage <stage>` is sent word for word so Marrow can judge the stage, and the command text of a plain `git push` or `gh pr create` is sent so Marrow can judge branch pushes, never when it carries a credential. Credentials are replaced and anything else that may be secret is withheld before anything leaves the machine.
- **Sends, with no key:** nothing. The seatbelt makes no network call. Its decisions are written on your machine to `~/.marrow/seatbelt/receipts/` as codes and keyed hashes, and kept for up to 90 days or 50 MB.
- **Reads your credentials:** only to sign in to Marrow, from `MARROW_API_KEY`, `MARROW_KEY`, or the owner-only files `~/.marrow/env.local` and `~/.marrow/env`.
- **Seatbelt checks, with no key:** the seatbelt looks for signs of a Marrow account on this machine (an owner key file, a claim marker, Marrow's local approval state) and checks that your home folder and agent settings folders (such as `~/.claude`) can be written by you alone. The seatbelt section of the root README of getmarrow/plugins describes both checks.
- **Not needed:** the hooks do not need raw prompts, model replies, command output, tool output or your credentials. The private device key in `~/.marrow/seatbelt/salt` is never sent.

## Remove it

```
claude plugin uninstall marrow@getmarrow
claude plugin marketplace remove getmarrow
```

This removes the hooks, the MCP server and the plugin's data folder. Marrow's local state under `~/.marrow` and your key file stay; delete what you no longer want.

## More

Docs: https://getmarrow.ai/marrow-for-claude-code. Source: https://github.com/getmarrow/plugins. Licence: MIT.
