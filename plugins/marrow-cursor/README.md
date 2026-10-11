# Marrow for Cursor

Marrow's approval hooks, the Marrow MCP server and a short skill for Cursor. They run the pinned `@getmarrow/mcp` 3.9.101 entrypoints, the same ones `npx @getmarrow/install` writes into `.cursor/hooks.json`. No account or key is needed to install, and no config in this plugin holds a key.

- Hooks (`hooks/hooks.json`): `preToolUse`, `beforeShellExecution` and `beforeMCPExecution` (15 s, `failClosed`), `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `afterMCPExecution`, `stop`, `sessionStart` and `beforeSubmitPrompt`, with the installer's matchers.
- MCP server (`mcp.json`): server `marrow`, started by `scripts/marrow-launch.cjs`.
- Skill (`skills/marrow`).

Needs Node.js 18 or later on `PATH`. The first hook call installs the pinned package once into `~/.marrow/cursor-plugin` (`npm ci --ignore-scripts` from `package-lock.json`, outside your project) and checks every file against `scripts/mcp-manifest.json`; only a verified copy ever runs. If none can load, Marrow's pre-action hooks hold the call.

To connect a key, in your own terminal:

```bash
mkdir -p ~/.marrow && chmod 700 ~/.marrow
# put MARROW_API_KEY=<your_key> in ~/.marrow/env
chmod 600 ~/.marrow/env
```

Then restart Cursor. Hooks are cooperative, client-reported control. A configured hook never proves coverage on its own. More in the repository README. License: MIT.
