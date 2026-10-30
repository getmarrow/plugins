# Marrow for Cursor

Marrow's approval hooks, the Marrow MCP server and a short skill for Cursor. They run the pinned `@getmarrow/mcp` 3.9.109 entrypoints, the same ones `npx @getmarrow/install` writes into `.cursor/hooks.json`. No account or key is needed to install, and no config in this plugin holds a key. 3.9.109 includes the free keyless seatbelt: with no key and no sign of a Marrow account on the machine, the hooks stop seven kinds of action: changes to Marrow's own hooks, settings or plugins (and owner-only Marrow commands), force-push or delete of a protected branch, a production deploy, a package publish, reading credentials or secrets (a project `.env` file other than a template included), a recursive delete outside the workspace, and decoded data run by a shell or interpreter. They stop them with Cursor's own deny and make no network call; a shell command that a hook without a key used to hold (for example `git commit` or `git push`) is left to Cursor's own approval prompt. With an account, Marrow holds risky actions for approval and keeps the audit trail. See "Without a key: the keyless seatbelt" in the repository README.

- Hooks (`hooks/hooks.json`): `preToolUse`, `beforeShellExecution` and `beforeMCPExecution` (15 s, `failClosed`), `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `afterMCPExecution`, `stop`, `sessionStart` and `beforeSubmitPrompt`, with the installer's matchers.
- MCP server (`mcp.json`): server `marrow`, started by `scripts/marrow-launch.cjs mcp`. Every hook command is `node "${CURSOR_PLUGIN_ROOT}/scripts/marrow-launch.cjs" <entrypoint>`, never a path relative to the project.
- Skill (`skills/marrow`).

Needs Node.js 18 or later on `PATH`. The first start of the plugin's Marrow server (or the first prompt's context hook) installs the pinned package once into `~/.marrow/cursor-plugin` (`npm ci --ignore-scripts` from `package-lock.json`, outside your project) and checks every file against `scripts/mcp-manifest.json`; only a verified copy ever runs. If none can load, Marrow's pre-action hooks hold the call at once; they never install or wait for an install themselves.

To connect a key, in your own terminal:

```bash
mkdir -p ~/.marrow && chmod 700 ~/.marrow
# put MARROW_API_KEY=<your_key> in ~/.marrow/env
chmod 600 ~/.marrow/env
```

Then restart Cursor. Hooks are cooperative, client-reported control. A configured hook never proves coverage on its own. More in the repository README. License: MIT.
